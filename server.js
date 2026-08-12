/* ================================================================
   VAULTMARK server — real data sources
   ----------------------------------------------------------------
   Steam Web API   : vanity resolution, profile, owned games   (key)
   steamcommunity  : public inventories (no key, rate-limited)
   store.steampowered.com/api/appdetails : current game prices
   api.skinport.com : third-party market prices for all 4 apps
   open.er-api.com  : live FX rates (USD base)

   Everything is cache-first (memory + disk) because Steam's
   community endpoints 429 aggressively at any real traffic.
   ================================================================ */

import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Real brand fonts, not a system fallback — vendored the same way as the PDF
// libs (public/vendor/) so this doesn't depend on Google Fonts being
// reachable from wherever this ends up hosted.
const FONT_DIR = path.join(__dirname, "public", "vendor", "fonts");
GlobalFonts.registerFromPath(path.join(FONT_DIR, "ChakraPetch-Bold.ttf"), "Chakra Petch");
GlobalFonts.registerFromPath(path.join(FONT_DIR, "ChakraPetch-SemiBold.ttf"), "Chakra Petch SemiBold");
GlobalFonts.registerFromPath(path.join(FONT_DIR, "JetBrainsMono-Variable.ttf"), "JetBrains Mono");

/* ------------------------- tiny .env loader (no dotenv dep) ------------------------- */
try {
  const env = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env file — rely on real env vars */ }

const STEAM_KEY = process.env.STEAM_API_KEY || "";
const PORT = Number(process.env.PORT || 3000);

/* ------------------------- SQLite: cache + snapshots ------------------------- */
/* Swapped from a single cache.json blob to SQLite so this survives hosts with
   no persistent disk assumptions beyond one file, and so snapshots/leaderboard
   have somewhere durable to live. node:sqlite is built into Node 22.5+ — no
   native module to compile, which matters for one-command deploys. */

// DB_FILE env var lets Docker mount a persistent volume at a dedicated data
// directory instead of the app directory itself — defaults to the old
// behavior for local/non-container dev, where nothing changes.
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "vaultmark.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    val TEXT NOT NULL,
    exp INTEGER NOT NULL,
    at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    steamid64  TEXT NOT NULL,
    persona    TEXT,
    avatar     TEXT,
    total      REAL NOT NULL,
    games_value REAL NOT NULL,
    items_value REAL NOT NULL,
    public     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_steamid ON snapshots(steamid64, created_at);
  CREATE INDEX IF NOT EXISTS idx_snapshots_public ON snapshots(public, total);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,   -- 'pageview' | 'appraisal' | 'share_view'
    path       TEXT,
    referrer   TEXT,
    steamid64  TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(type, created_at);
`);

const cache = new Map();

// One-time migration from the old cache.json, so a prior warm cache (hours of
// slow Steam Market back-fill) isn't thrown away by this storage swap.
{
  const CACHE_FILE = path.join(__dirname, "cache.json");
  const row = db.prepare("SELECT COUNT(*) as n FROM cache").get();
  if (row.n === 0) {
    try {
      const saved = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      const now = Date.now();
      const stmt = db.prepare("INSERT OR REPLACE INTO cache (key, val, exp, at) VALUES (?, ?, ?, ?)");
      let migrated = 0;
      for (const [k, v] of Object.entries(saved)) {
        if (v.exp > now) { stmt.run(k, JSON.stringify(v.val), v.exp, v.at); migrated++; }
      }
      if (migrated) console.log(`[cache] migrated ${migrated} entries from cache.json into SQLite`);
    } catch { /* no cache.json — first run */ }
  }
}

{
  const now = Date.now();
  db.prepare("DELETE FROM cache WHERE exp < ?").run(now);
  for (const row of db.prepare("SELECT key, val, exp, at FROM cache").all()) {
    cache.set(row.key, { val: JSON.parse(row.val), exp: row.exp, at: row.at });
  }
  console.log(`[cache] restored ${cache.size} entries`);
}

let persistTimer = null;
function persistCache() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const now = Date.now();
    const insert = db.prepare("INSERT INTO cache (key, val, exp, at) VALUES (?, ?, ?, ?)");
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM cache");
      for (const [k, v] of cache) if (v.exp > now) insert.run(k, JSON.stringify(v.val), v.exp, v.at);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }, 5000);
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) { cache.delete(key); return undefined; }
  return hit.val;
}
function cacheSet(key, val, ttlMs) {
  cache.set(key, { val, exp: Date.now() + ttlMs, at: Date.now() });
  persistCache();
}
function cacheAge(key) {
  const hit = cache.get(key);
  return hit ? Date.now() - hit.at : null;
}

// Deliberately not tracking anything that would need a cookie-consent banner:
// no cookies, no IP storage, no cross-request identifier. Just event counts
// (pageview / appraisal / share_view) with path, referrer, and — for
// appraisals — the steamid64 being looked up, so "most appraised profiles"
// is answerable. Enough to know whether the site is being used at all.
const insertEvent = db.prepare(
  "INSERT INTO events (type, path, referrer, steamid64, created_at) VALUES (?, ?, ?, ?, ?)"
);
function logEvent(type, { path = null, referrer = null, steamid64 = null } = {}) {
  try { insertEvent.run(type, path, referrer, steamid64, Date.now()); } catch { /* analytics must never break the app */ }
}

const TTL = {
  vanity: 24 * 3600e3,
  profile: 30 * 60e3,
  games: 30 * 60e3,
  gamePrice: 6 * 3600e3,  // short enough to catch sale start/end same-day
  inventory: 30 * 60e3,
  skinport: 10 * 60e3,   // Skinport caches server-side for 5 min
  market: 24 * 3600e3,     // Steam Market priceoverview hits
  marketMiss: 6 * 3600e3,  // priceoverview "no listings" — retry sooner
  rates: 12 * 3600e3,
  reputation: 24 * 3600e3, // level/badges/bans change rarely
  deals: 4 * 3600e3,       // deal rotation is slow enough that 4h is fine
  genre: 30 * 24 * 3600e3, // a game's genre tags essentially never change
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* Coalesce concurrent identical fetches: two people appraising the same
   profile at once share one upstream request instead of doubling load. */
const inflight = new Map();
function coalesce(key, fn) {
  let p = inflight.get(key);
  if (!p) {
    p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/* ------------------------- fetch helper ------------------------- */

const UA = "Mozilla/5.0 (compatible; VaultmarkAppraiser/1.0)";

async function getJSON(url, { headers = {}, timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: ctrl.signal });
    if (res.status === 429) return { ok: false, status: 429 };
    if (res.status === 403) return { ok: false, status: 403 };
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json().catch(() => null);
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : String(e) };
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------- SteamID parsing ------------------------- */

const STEAM64_BASE = 76561197960265728n;

function parseSteamInput(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  let m = s.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (m) return { type: "steamid64", steamid64: m[1] };
  m = s.match(/steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,32})/i);
  if (m) return { type: "vanity", vanity: m[1] };
  if (/^\d{17}$/.test(s)) return { type: "steamid64", steamid64: s };
  m = s.match(/^STEAM_[0-5]:([01]):(\d+)$/i);
  if (m) return { type: "steam2", steamid64: (STEAM64_BASE + BigInt(m[2]) * 2n + BigInt(m[1])).toString() };
  m = s.match(/^\[?U:1:(\d+)\]?$/i);
  if (m) return { type: "steam3", steamid64: (STEAM64_BASE + BigInt(m[1])).toString() };
  if (/^[A-Za-z0-9_-]{2,32}$/.test(s)) return { type: "vanity", vanity: s };
  return { type: "invalid" };
}

/* ------------------------- Steam Web API calls ------------------------- */

async function resolveVanity(vanity) {
  const key = `vanity:${vanity.toLowerCase()}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const r = await getJSON(
    `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_KEY}&vanityurl=${encodeURIComponent(vanity)}`
  );
  if (!r.ok) return { error: "steam_api_unreachable", status: r.status };
  if (r.data?.response?.success !== 1) return { error: "vanity_not_found" };
  const out = { steamid64: r.data.response.steamid };
  cacheSet(key, out, TTL.vanity);
  return out;
}

async function fetchProfile(steamid64) {
  const key = `profile:${steamid64}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const r = await getJSON(
    `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${steamid64}`
  );
  if (!r.ok) return { error: "steam_api_unreachable", status: r.status };
  const p = r.data?.response?.players?.[0];
  if (!p) return { error: "profile_not_found" };
  const out = {
    steamid64,
    persona: p.personaname,
    avatar: p.avatarfull,
    visibility: p.communityvisibilitystate === 3 ? "public" : "private",
    profileUrl: p.profileurl,
    // timecreated is omitted by Steam for some accounts even when public —
    // treat missing as "unknown," not "brand new."
    accountCreated: p.timecreated ? p.timecreated * 1000 : null,
  };
  cacheSet(key, out, TTL.profile);
  return out;
}

/* Steam level/badges/ban status — official API, no pricing pipeline involved.
   Bans matter beyond reputation: a VAC ban permanently freezes Steam Market
   and trading on that account, which can make an otherwise-priced inventory
   unrealizable regardless of what the numbers say. */
async function fetchReputation(steamid64) {
  const key = `rep:${steamid64}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return coalesce(key, async () => {
    const [badgesR, bansR] = await Promise.all([
      getJSON(`https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${STEAM_KEY}&steamid=${steamid64}`),
      getJSON(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${STEAM_KEY}&steamids=${steamid64}`),
    ]);
    if (!badgesR.ok && !bansR.ok) return { error: "steam_api_unreachable" };
    const b = badgesR.ok ? badgesR.data?.response : null;
    const ban = bansR.ok ? bansR.data?.players?.[0] : null;
    const out = {
      level: b?.player_level ?? null,
      badgeCount: Array.isArray(b?.badges) ? b.badges.length : null,
      vacBanned: ban?.VACBanned ?? null,
      communityBanned: ban?.CommunityBanned ?? null,
      economyBan: ban?.EconomyBan ?? null, // "none" | "probation" | "banned"
      numberOfVACBans: ban?.NumberOfVACBans ?? 0,
      numberOfGameBans: ban?.NumberOfGameBans ?? 0,
      daysSinceLastBan: ban?.DaysSinceLastBan ?? null,
    };
    cacheSet(key, out, TTL.reputation);
    return out;
  });
}

async function fetchOwnedGames(steamid64, cc) {
  const key = `games:${steamid64}:${cc}`;
  let hit = cacheGet(key);
  // pre-sale-aware cache shape (no discount field on games) → refetch
  if (hit?.games?.length && !("discount" in hit.games[0])) { cache.delete(key); hit = undefined; }
  if (hit) return { ...hit, cachedMs: cacheAge(key) };
  return coalesce(key, async () => {
    const r = await getJSON(
      `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${steamid64}&include_appinfo=1&include_played_free_games=1&format=json`
    );
    if (!r.ok) return { error: "steam_api_unreachable", status: r.status };
    const games = r.data?.response?.games;
    if (!games) return { status: "private" }; // game details hidden (separate privacy toggle from inventory)

    const list = games.map((g) => ({
      appid: g.appid,
      name: g.name,
      hours: Math.round((g.playtime_forever || 0) / 60),
      img: g.img_icon_url
        ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg`
        : null,
    }));

    await attachGamePrices(list, cc);
    const out = { status: "ok", games: list };
    cacheSet(key, out, TTL.games);
    return out;
  });
}

/* Current store prices via appdetails. Batched appids only work with the
   price_overview filter — that's a documented quirk we rely on. ~200 req/5min
   limit on this endpoint, so everything lands in a 6h per-app-per-region cache.
   `initial` is the regular price (counted in totals — stable across sales),
   `final` is what the store charges right now, discounted during sales.
   Prices come back in the region's store currency and are normalized to USD
   with our FX rates so the display-currency dropdown stays a pure FX layer. */
function applyGamePrice(g, p) {
  g.price = p.price;                          // regular price — what totals count
  g.sale = p.discount > 0 ? p.sale : null;    // current discounted price, if on sale
  g.discount = p.discount || 0;
}

async function attachGamePrices(list, cc) {
  const fx = (await fetchRates()).rates;
  const need = [];
  for (const g of list) {
    const hit = cacheGet(`gp:${cc}:${g.appid}`);
    if (hit !== undefined && typeof hit === "object") applyGamePrice(g, hit);
    else need.push(g);
  }
  const BATCH = 100;
  for (let i = 0; i < need.length; i += BATCH) {
    const batch = need.slice(i, i + BATCH);
    const ids = batch.map((g) => g.appid).join(",");
    const r = await getJSON(
      `https://store.steampowered.com/api/appdetails?appids=${ids}&filters=price_overview&cc=${cc}`
    );
    for (const g of batch) {
      let p = { price: 0, sale: 0, discount: 0 };
      const entry = r.ok ? r.data?.[g.appid] : null;
      const po = entry?.success ? entry.data?.price_overview : null;
      if (po) {
        const rate = fx[po.currency] || 1; // → USD; unknown currency passes through
        p = {
          price: (po.initial ?? po.final) / 100 / rate,
          sale: po.final / 100 / rate,
          discount: po.discount_percent || 0,
        };
      }
      applyGamePrice(g, p);
      if (r.ok) cacheSet(`gp:${cc}:${g.appid}`, p, TTL.gamePrice);
    }
    if (i + BATCH < need.length) await sleep(1500);
  }
}

/* ------------------------- Liquidity: will this actually sell? ------------------------- */
/* A price tells you what an item is worth if someone buys it — it says nothing
   about whether anyone will. A rare item with one listing and a busy item with
   a thousand can show the same priceMarket while having wildly different odds
   of actually converting to cash soon. Skinport's `quantity` (how many are for
   sale right now) and Steam Market's `volume` (units traded in the last 24h)
   are both real, honest signals of that — not a promise, just a proxy, so the
   raw number always travels with the label rather than the label standing
   alone. Thresholds below are a judgment call, not derived from real
   sell-through data — treat "liquid" as "probably fine," not a guarantee. */
const LIQUIDITY_THRESHOLDS = {
  skinportListings: { liquid: 15, thin: 3 },
  steamVolume24h: { liquid: 20, thin: 3 },
};
function classifyLiquidity(metric, thresholds, unitLabel) {
  const n = Number(metric) || 0;
  const level = n >= thresholds.liquid ? "liquid" : n >= thresholds.thin ? "thin" : "illiquid";
  return { level, metric: n, unitLabel };
}

/* ------------------------- Skinport market prices ------------------------- */
/* One call returns every listed item for an app — min/suggested prices keyed by
   market_hash_name. Covers 730, 570, 440, 252490. Refreshed every 10 min. */

async function skinportPrices(appid) {
  const key = `skinport:${appid}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  return coalesce(key, async () => {
    const r = await getJSON(`https://api.skinport.com/v1/items?app_id=${appid}&currency=USD`, { timeout: 25000 });
    if (!r.ok || !Array.isArray(r.data)) return null;
    const map = {};
    for (const it of r.data) {
      map[it.market_hash_name] = {
        market: it.min_price ?? it.suggested_price ?? 0,
        suggested: it.suggested_price ?? 0,
        link: it.item_page || it.market_page || null,
        listings: it.quantity ?? 0, // how many are for sale right now — a price with no buyers isn't a real price
      };
    }
    cacheSet(key, map, TTL.skinport);
    return map;
  });
}

/* ------------------------- Steam Market fallback prices ------------------------- */
/* Skinport only lists items they carry, and doesn't cover Community items (753)
   at all — anything it misses used to silently count as zero. Missing names go
   into one slow global queue against market/priceoverview. That endpoint shares
   steamcommunity.com's rate budget with the inventory endpoint (~20 req/min
   total), hence the 3.5 s gap and 90 s backoff on 429. Coverage builds lazily:
   the first appraisal queues the gaps, later ones read them from cache. */

const PO_GAP_MS = 3500;
const PO_MAX_QUEUE = 2000;
const poQueue = [];
const poQueued = new Set();
let poDraining = false;

function parseMoney(s) {
  if (typeof s !== "string") return 0;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function parseCount(s) {
  if (typeof s !== "string") return 0;
  const n = Number(s.replace(/[^0-9]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function queueMarketLookups(appid, names) {
  for (const name of names) {
    const key = `po:${appid}:${name}`;
    if (poQueued.has(key) || cacheGet(key) !== undefined) continue;
    if (poQueue.length >= PO_MAX_QUEUE) break;
    poQueued.add(key);
    poQueue.push({ appid, name, key });
  }
  drainMarketQueue();
}

async function drainMarketQueue() {
  if (poDraining) return;
  poDraining = true;
  while (poQueue.length) {
    // Inventory fetches share steamcommunity.com's rate budget and serve a
    // waiting user — yield to them instead of racing them into a 429.
    while (invFetchesActive > 0) await sleep(2000);
    const job = poQueue[0];
    const r = await getJSON(
      `https://steamcommunity.com/market/priceoverview/?appid=${job.appid}&currency=1&market_hash_name=${encodeURIComponent(job.name)}`
    );
    if (r.status === 429) { await sleep(90000); continue; } // retry same job
    poQueue.shift();
    poQueued.delete(job.key);
    if (r.ok && r.data?.success) {
      const market = parseMoney(r.data.lowest_price);
      const suggested = parseMoney(r.data.median_price);
      // volume = units sold on Steam Market in the last 24h — real trade
      // velocity, not just a listing count, so it's the stronger signal.
      const volume = parseCount(r.data.volume);
      cacheSet(job.key, { market, suggested, volume }, market || suggested ? TTL.market : TTL.marketMiss);
    } else {
      cacheSet(job.key, { market: 0, suggested: 0, volume: 0 }, TTL.marketMiss);
    }
    await sleep(PO_GAP_MS);
  }
  poDraining = false;
}

/* ------------------------- Inventory ------------------------- */

const WEAR_NAMES = ["Factory New", "Minimal Wear", "Field-Tested", "Well-Worn", "Battle-Scarred"];

// Community items (cards, backgrounds, emotes, gems) live in context 6; game inventories use 2.
const INV_CONTEXT = { 753: 6 };

let invFetchesActive = 0; // while >0, the market price queue holds off

async function fetchInventoryRaw(steamid64, appid) {
  invFetchesActive++;
  try {
    return await fetchInventoryPages(steamid64, appid);
  } finally {
    invFetchesActive--;
  }
}

async function fetchInventoryPages(steamid64, appid) {
  // Paginate: count=2000 per page, follow last_assetid.
  let assets = [];
  const descriptions = new Map();
  let last = null;
  for (let page = 0; page < 6; page++) {
    const url =
      `https://steamcommunity.com/inventory/${steamid64}/${appid}/${INV_CONTEXT[appid] || 2}?l=english&count=2000` +
      (last ? `&start_assetid=${last}` : "");
    const r = await getJSON(url, { timeout: 20000 });
    if (r.status === 429) return { status: "rate_limited" };
    // Steam signals a private inventory as 403, 401, or a 200 with null body.
    if (r.status === 403 || r.status === 401 || (r.ok && r.data === null)) return { status: "private" };
    if (!r.ok) return { status: "error", httpStatus: r.status };
    const d = r.data;
    if (!d || d.success !== 1) return { status: "private" };
    assets = assets.concat(d.assets || []);
    for (const desc of d.descriptions || []) descriptions.set(`${desc.classid}_${desc.instanceid}`, desc);
    if (!d.more_items) break;
    last = d.last_assetid;
    await sleep(1200); // be gentle between pages
  }

  // Merge assets with descriptions, stack identical items. No prices here —
  // pricing happens per request so back-filled prices don't wait out this cache.
  const stacks = new Map();
  for (const a of assets) {
    const desc = descriptions.get(`${a.classid}_${a.instanceid}`);
    if (!desc) continue;
    const name = desc.market_hash_name || desc.name;
    const cur = stacks.get(name);
    const qty = Number(a.amount || 1);
    if (cur) { cur.qty += qty; continue; }

    const tags = desc.tags || [];
    const rarityTag = tags.find((t) => t.category === "Rarity");
    const exteriorTag = tags.find((t) => t.category === "Exterior");
    const typeTag = tags.find((t) => t.category === "Type" || t.category === "Quality" || t.category === "item_class");

    stacks.set(name, {
      name,
      qty,
      icon: desc.icon_url
        ? `https://community.fastly.steamstatic.com/economy/image/${desc.icon_url}/192x144`
        : null,
      rarity: rarityTag?.localized_tag_name || typeTag?.localized_tag_name || "Standard",
      rarityColor: rarityTag?.color ? `#${rarityTag.color}` : "#B0C3D9",
      wear: exteriorTag ? exteriorTag.localized_tag_name : (WEAR_NAMES.find((w) => name.includes(w)) || null),
      marketable: !!desc.marketable,
      // cache_expiration = trade/market hold that lifts on a date, e.g. fresh
      // Rust drops — distinct from permanently untradable items.
      hold: desc.cache_expiration || null,
    });
  }

  return { status: "ok", count: assets.length, stacks: [...stacks.values()] };
}

// DMarket's search works from a plain URL — no login wall, unlike CSFloat
// (verified: their search UI rejects unauthenticated queries entirely) — but
// only if the wear condition is stripped from the query first. Confirmed by
// testing directly: "AK-47 | Redline" returns real results, "AK-47 | Redline
// (Field-Tested)" silently returns nothing and falls back to the generic
// browse page. DMarket doesn't cover Community items (753). Skipped for
// ★/StatTrak™-prefixed names (knives, StatTrak weapons) — tested one of
// those and the result page was ambiguous (plausible prices mixed with
// generic "Recommended for you" filler, not clearly a filtered match) —
// a wrong link is worse than no link, so those fall back to Skinport/Steam
// Market only, which already price them correctly.
const DMARKET_SLUGS = { 730: "csgo-skins", 570: "dota2-skins", 440: "tf2-skins", 252490: "rust-skins" };
const WEAR_SUFFIX_RE = / \((?:Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/;
const DMARKET_UNSAFE_PREFIX_RE = /^(★|StatTrak™)/;

// Known seller fee ceilings, verified this session (not assumed): DMarket's
// own site states 1-5%; Skinport publishes 8% standard / 6% above $1000;
// Steam Market is a fixed 15% (5% Steam + 10% game publisher). Used only to
// rank which link is flagged "best" — the actual per-item cash-out estimate
// elsewhere in this file uses the precise Skinport/Steam rates, not this
// range. DMarket's real price isn't available (no API key), so it can't be
// included in that precise calculation — only in this fee-based ranking.
const PLATFORM_FEE_CEILING = { DMarket: 0.05, Skinport: 0.08, "Steam Market": 0.15 };

function buildSellLinks(appid, name, skinportLink) {
  const links = [];
  if (skinportLink) links.push({ platform: "Skinport", url: skinportLink });
  links.push({ platform: "Steam Market", url: `https://steamcommunity.com/market/listings/${appid}/${encodeURIComponent(name)}` });
  const slug = DMARKET_SLUGS[appid];
  if (slug && !DMARKET_UNSAFE_PREFIX_RE.test(name)) {
    const baseName = name.replace(WEAR_SUFFIX_RE, "");
    links.push({ platform: "DMarket", url: `https://dmarket.com/ingame-items/item-list/${slug}?title=${encodeURIComponent(baseName)}` });
  }
  links.sort((a, b) => PLATFORM_FEE_CEILING[a.platform] - PLATFORM_FEE_CEILING[b.platform]);
  if (links.length) links[0].best = true;
  return links;
}

async function fetchInventory(steamid64, appid) {
  const key = `inv:${steamid64}:${appid}`;
  let raw = cacheGet(key);
  if (raw && !raw.stacks) { cache.delete(key); raw = undefined; } // pre-pricing-split cache shape
  const cachedMs = raw ? cacheAge(key) : null;
  if (!raw) {
    raw = await coalesce(key, () => fetchInventoryRaw(steamid64, appid));
    if (raw.status !== "ok") return raw;
    cacheSet(key, raw, TTL.inventory);
  }

  const skinport = appid === 753 ? null : await skinportPrices(appid); // Skinport doesn't carry 753
  const pending = [];
  const items = raw.stacks.map((s) => {
    const it = { ...s, priceMarket: 0, priceSuggested: 0, priced: false, priceSource: null, sellLinks: [], liquidity: null };
    const sp = skinport?.[s.name];
    const po = sp ? undefined : cacheGet(`po:${appid}:${s.name}`);
    if (sp) {
      it.priceMarket = sp.market;
      it.priceSuggested = sp.suggested;
      it.priced = true;
      it.priceSource = "skinport";
      it.sellLinks = buildSellLinks(appid, s.name, sp.link);
      it.liquidity = classifyLiquidity(sp.listings, LIQUIDITY_THRESHOLDS.skinportListings, "listed on Skinport");
    } else if (po !== undefined) {
      it.priceMarket = po.market || po.suggested;
      it.priceSuggested = po.suggested;
      it.priced = it.priceMarket > 0;
      if (it.priced) {
        it.priceSource = "steam";
        it.sellLinks = buildSellLinks(appid, s.name, null);
        it.liquidity = classifyLiquidity(po.volume, LIQUIDITY_THRESHOLDS.steamVolume24h, "sold/day on Steam");
      }
    } else if (s.marketable) {
      pending.push(s.name);
    }
    return it;
  });
  queueMarketLookups(appid, pending);

  items.sort((a, b) => b.priceMarket * b.qty - a.priceMarket * a.qty);
  return {
    status: "ok",
    count: raw.count,
    items,
    pricesAvailable: appid === 753 ? true : !!skinport,
    pricePending: pending.length,
    ...(cachedMs != null ? { cachedMs } : {}),
  };
}

/* ------------------------- FX rates ------------------------- */

async function fetchRates() {
  const hit = cacheGet("rates");
  if (hit) return hit;
  const r = await getJSON("https://open.er-api.com/v6/latest/USD");
  const fallback = { USD: 1 };
  if (!r.ok || !r.data?.rates) return { base: "USD", rates: fallback, live: false };
  const wanted = ["USD","EUR","GBP","CNY","RUB","BRL","TRY","PLN","JPY","KRW","AUD","CAD","SEK","NOK","UAH","INR","MXN","IDR","PHP","THB","VND","MYR"];
  const rates = {};
  for (const c of wanted) if (r.data.rates[c]) rates[c] = r.data.rates[c];
  const out = { base: "USD", rates, live: true };
  cacheSet("rates", out, TTL.rates);
  return out;
}

/* ------------------------- Deals: on sale, highly rated, not in your library ------------------------- */
/* CheapShark aggregates deals across Steam/GOG/GreenManGaming/Humble/Fanatical
   etc — free, keyless, just wants a descriptive User-Agent (already sent).
   Their own sortBy=Rating sorts by CheapShark's internal deal-quality score,
   not the game's actual review score, so a candidate pool is fetched and
   sorted by steamRatingPercent here instead. The candidate pool is cached
   globally (it's not personalized); only the "already own this" filter is
   applied per request, cheaply, in memory. */

const DEALS_PAGES = 8;
const DEALS_PAGE_SIZE = 60;

async function fetchDealsCandidates() {
  const key = "deals:candidates";
  const hit = cacheGet(key);
  if (hit) return hit;
  return coalesce(key, async () => {
    let all = [];
    for (let page = 0; page < DEALS_PAGES; page++) {
      const r = await getJSON(
        `https://www.cheapshark.com/api/1.0/deals?storeID=1&onSale=1&sortBy=Savings&pageSize=${DEALS_PAGE_SIZE}&pageNumber=${page}`
      );
      if (!r.ok || !Array.isArray(r.data)) break;
      all = all.concat(r.data);
      if (r.data.length < DEALS_PAGE_SIZE) break;
    }
    const list = all
      // ratingCount floor is doing real work here: at 500 the list was dominated
      // by $0.49 shovelware with a handful of positive reviews. 5000+ means
      // enough people actually played it to trust the signal. salePrice > 0
      // drops a handful of $0.00 entries CheapShark returns for delisted or
      // giveaway-flagged listings — not a real "buy this now" price.
      .filter((d) => d.steamAppID && Number(d.steamRatingPercent) >= 75 && Number(d.steamRatingCount) >= 5000 && Number(d.salePrice) > 0)
      .map((d) => ({
        appid: Number(d.steamAppID),
        title: d.title,
        salePrice: Number(d.salePrice),
        normalPrice: Number(d.normalPrice),
        savings: Math.round(Number(d.savings)),
        ratingPercent: Number(d.steamRatingPercent),
        ratingText: d.steamRatingText,
        ratingCount: Number(d.steamRatingCount),
        thumb: d.thumb,
        dealLink: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`,
      }));
    // Same game can show up from multiple deals/stores — keep the cheapest.
    const byApp = new Map();
    for (const d of list) {
      const cur = byApp.get(d.appid);
      if (!cur || d.salePrice < cur.salePrice) byApp.set(d.appid, d);
    }
    const out = [...byApp.values()];
    cacheSet(key, out, TTL.deals);
    return out;
  });
}

/* Genre tags, for grouping deals into categories. appdetails does NOT batch
   multiple appids for the genres filter the way it does for price_overview —
   confirmed by testing, not assumed — so each game needs its own request.
   Fetching 60+ of these synchronously inside one /api/deals response would
   make that request take 20+ seconds, so this runs as the same kind of lazy
   background queue as the Steam Market price back-fill: serve whatever's
   cached now, queue the rest, they fill in on a later request. */

const GENRE_GAP_MS = 1200;
const genreQueue = [];
const genreQueued = new Set();
let genreDraining = false;

function queueGenreLookups(appids) {
  for (const appid of appids) {
    const key = `genre:${appid}`;
    if (genreQueued.has(key) || cacheGet(key) !== undefined) continue;
    genreQueued.add(key);
    genreQueue.push({ appid, key });
  }
  drainGenreQueue();
}

async function drainGenreQueue() {
  if (genreDraining) return;
  genreDraining = true;
  while (genreQueue.length) {
    while (invFetchesActive > 0) await sleep(2000); // same courtesy as the price queue
    const job = genreQueue.shift();
    genreQueued.delete(job.key);
    const r = await getJSON(`https://store.steampowered.com/api/appdetails?appids=${job.appid}&filters=genres`);
    const entry = r.ok ? r.data?.[job.appid] : null;
    const genre = entry?.success ? entry.data?.genres?.[0]?.description || "Other" : "Other";
    cacheSet(job.key, genre, TTL.genre);
    await sleep(GENRE_GAP_MS);
  }
  genreDraining = false;
}

/* ------------------------- HTTP layer ------------------------- */

const app = express();

// CSP disabled: the page loads Google Fonts and hotlinks Steam/Skinport CDN
// images, which a default-src 'self' policy would block. The other headers
// (clickjacking, MIME-sniffing, etc.) still apply. Tighten this with an
// explicit allowlist before relying on it as your only defense.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "8kb" }));

// If this sits behind a reverse proxy (nginx, a PaaS load balancer), uncomment
// so rate limiting keys off the real client IP instead of the proxy's:
// app.set("trust proxy", 1);
app.use("/api/", rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many requests — wait a minute." },
}));

app.use(express.static(path.join(__dirname, "public")));

function needKey(res) {
  if (STEAM_KEY) return false;
  res.status(503).json({ error: "no_api_key", message: "Set STEAM_API_KEY in .env (get one at steamcommunity.com/dev/apikey), then restart." });
  return true;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, keyConfigured: !!STEAM_KEY, cacheEntries: cache.size });
});

app.post("/api/track", (req, res) => {
  const p = typeof req.body?.path === "string" ? req.body.path.slice(0, 200) : null;
  const ref = typeof req.body?.referrer === "string" ? req.body.referrer.slice(0, 300) : null;
  logEvent("pageview", { path: p, referrer: ref || null });
  res.status(204).end();
});

app.get("/api/resolve", async (req, res) => {
  const parsed = parseSteamInput(req.query.input);
  if (!parsed || parsed.type === "invalid") return res.status(400).json({ error: "unparseable_input" });
  if (parsed.steamid64) {
    logEvent("appraisal", { steamid64: parsed.steamid64 });
    return res.json({ steamid64: parsed.steamid64, via: parsed.type });
  }
  if (needKey(res)) return;
  const r = await resolveVanity(parsed.vanity);
  if (r.error) return res.status(r.error === "vanity_not_found" ? 404 : 502).json(r);
  logEvent("appraisal", { steamid64: r.steamid64 });
  res.json({ steamid64: r.steamid64, via: "vanity" });
});

app.get("/api/profile/:id", async (req, res) => {
  if (needKey(res)) return;
  if (!/^\d{17}$/.test(req.params.id)) return res.status(400).json({ error: "bad_steamid" });
  const r = await fetchProfile(req.params.id);
  if (r.error) return res.status(r.error === "profile_not_found" ? 404 : 502).json(r);
  res.json(r);
});

app.get("/api/reputation/:id", async (req, res) => {
  if (needKey(res)) return;
  if (!/^\d{17}$/.test(req.params.id)) return res.status(400).json({ error: "bad_steamid" });
  res.json(await fetchReputation(req.params.id));
});

app.get("/api/games/:id", async (req, res) => {
  if (needKey(res)) return;
  if (!/^\d{17}$/.test(req.params.id)) return res.status(400).json({ error: "bad_steamid" });
  const cc = /^[a-z]{2}$/i.test(req.query.cc || "") ? req.query.cc.toLowerCase() : "us";
  res.json(await fetchOwnedGames(req.params.id, cc));
});

const SUPPORTED_APPS = new Set([730, 570, 440, 252490, 753]);
app.get("/api/inventory/:id/:appid", async (req, res) => {
  if (!/^\d{17}$/.test(req.params.id)) return res.status(400).json({ error: "bad_steamid" });
  const appid = Number(req.params.appid);
  if (!SUPPORTED_APPS.has(appid)) return res.status(400).json({ error: "unsupported_app" });
  res.json(await fetchInventory(req.params.id, appid));
});

app.get("/api/rates", async (req, res) => res.json(await fetchRates()));

app.post("/api/deals/:id", async (req, res) => {
  if (!/^\d{17}$/.test(req.params.id)) return res.status(400).json({ error: "bad_steamid" });
  const owned = new Set(Array.isArray(req.body?.owned) ? req.body.owned.map(Number) : []);
  const candidates = await fetchDealsCandidates();
  const deals = candidates
    .filter((d) => !owned.has(d.appid))
    .sort((a, b) => b.ratingPercent - a.ratingPercent || b.savings - a.savings)
    .slice(0, 60)
    .map((d) => ({ ...d, genre: cacheGet(`genre:${d.appid}`) || null }));
  queueGenreLookups(deals.filter((d) => !d.genre).map((d) => d.appid));
  res.json({ deals });
});

app.get("/api/refresh/:id", (req, res) => {
  // Drop caches for one profile so the next appraisal refetches.
  let n = 0;
  for (const k of [...cache.keys()]) {
    if (k.includes(req.params.id)) { cache.delete(k); n++; }
  }
  persistCache();
  res.json({ cleared: n });
});

/* ------------------------- Snapshots + leaderboard ------------------------- */
/* One row per completed appraisal, so a return visit can chart "your account
   over time" and (only if the person opts in) show up on the public
   leaderboard. History is saved automatically since it's scoped to the exact
   steamid64 that was just looked up; the leaderboard is opt-in per snapshot
   because appearing on a public "richest accounts" list is a bigger exposure
   than a private history line only that steamid's own visits can retrieve. */

const insertSnapshot = db.prepare(
  "INSERT INTO snapshots (steamid64, persona, avatar, total, games_value, items_value, public, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
);

app.post("/api/snapshot", (req, res) => {
  const { steamid64, persona, avatar, total, gamesValue, itemsValue, makePublic } = req.body || {};
  if (!/^\d{17}$/.test(steamid64 || "")) return res.status(400).json({ error: "bad_steamid" });
  if (typeof total !== "number" || !Number.isFinite(total)) return res.status(400).json({ error: "bad_total" });
  insertSnapshot.run(
    steamid64,
    String(persona || "").slice(0, 64),
    String(avatar || "").slice(0, 300),
    total,
    Number(gamesValue) || 0,
    Number(itemsValue) || 0,
    makePublic ? 1 : 0,
    Date.now()
  );
  res.json({ ok: true });
});

app.get("/api/history/:id", (req, res) => {
  if (!/^\d{17}$/.test(req.params.id)) return res.status(400).json({ error: "bad_steamid" });
  const history = db.prepare(
    "SELECT total, games_value as gamesValue, items_value as itemsValue, created_at as at FROM snapshots WHERE steamid64 = ? ORDER BY created_at ASC LIMIT 500"
  ).all(req.params.id);
  res.json({ history });
});

app.get("/api/leaderboard", (req, res) => {
  // Latest *public* snapshot per steamid64, ranked by total.
  const leaderboard = db.prepare(`
    SELECT s.steamid64, s.persona, s.avatar, s.total, s.created_at as at
    FROM snapshots s
    JOIN (
      SELECT steamid64, MAX(created_at) as maxAt
      FROM snapshots WHERE public = 1
      GROUP BY steamid64
    ) latest ON s.steamid64 = latest.steamid64 AND s.created_at = latest.maxAt
    ORDER BY s.total DESC
    LIMIT 20
  `).all();
  res.json({ leaderboard });
});

/* ------------------------- Embeddable badge ------------------------- */
/* Shields.io-style SVG badge, embeddable in a forum signature or Discord bio.
   Pure SVG — no image-rendering dependency, and every renderer that can show
   a hotlinked <img> can show this. Shows the latest snapshot for that
   steamid64, public or not — the badge URL itself is only ever shared by
   someone who already has it, same trust model as a profile URL. */

function escXml(s) { return String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c])); }
function fmtUsd(n) {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n >= 1000 ? 0 : 2, maximumFractionDigits: n >= 1000 ? 0 : 2 });
}
function badgeSvg(label, value, accent) {
  const labelW = 66 + label.length * 5.2;
  const valueW = 20 + value.length * 7.6;
  const w = Math.round(labelW + valueW);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${escXml(label)}: ${escXml(value)}">
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="4" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
<rect width="${labelW}" height="20" fill="#121722"/>
<rect x="${labelW}" width="${valueW}" height="20" fill="${accent}"/>
<rect width="${w}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">
<text x="${labelW / 2}" y="14" fill="#8894A8">${escXml(label)}</text>
<text x="${labelW + valueW / 2}" y="14" fill="#0A121B" font-weight="bold">${escXml(value)}</text>
</g>
</svg>`;
}

app.get("/api/badge/:id.svg", (req, res) => {
  if (!/^\d{17}$/.test(req.params.id)) return res.status(400).type("text/plain").send("bad steamid");
  const latest = db.prepare(
    "SELECT total FROM snapshots WHERE steamid64 = ? ORDER BY created_at DESC LIMIT 1"
  ).get(req.params.id);
  const svg = latest
    ? badgeSvg("VAULTMARK", fmtUsd(latest.total), "#63B0E3")
    : badgeSvg("VAULTMARK", "not appraised", "#5B6779");
  res.set("Content-Type", "image/svg+xml");
  res.set("Cache-Control", "public, max-age=600");
  res.send(svg);
});

/* ------------------------- OG share image ------------------------- */
/* This is the actual growth mechanism, not the PNG download button: a stable
   image URL that Discord/Twitter/Slack read when a /share/:steamid64 link
   gets pasted somewhere, so the appraisal shows up as a real link-preview
   card instead of a bare URL. Rendered server-side with @napi-rs/canvas
   (prebuilt binary, confirmed no native compile step) from the latest saved
   snapshot — no live Steam calls needed, so it's fast even cold. Uses the
   real vendored brand fonts (public/vendor/fonts/), not a system fallback. */

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fmtMoney(n) {
  const digits = Math.abs(n) >= 1000 ? 0 : 2;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
// Chakra Petch has no emoji glyphs, and canvas font fallback doesn't reliably
// substitute a system emoji font the way a browser does — emoji-heavy
// personas (very common on Steam) rendered as broken tofu boxes without
// this. Same fix as the PDF report's pdfSafe(): keep printable ASCII +
// Latin-1 supplement, drop the rest.
function textSafe(s) {
  const cleaned = String(s ?? "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || "(unnamed)";
}

async function renderShareCard(snap) {
  const W = 1200, H = 630;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const disp = "'Chakra Petch'";
  const mono = "'JetBrains Mono'";

  ctx.fillStyle = "#0B0F15"; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.82, 90, 40, W * 0.82, 90, 560);
  glow.addColorStop(0, "rgba(99,176,227,0.16)"); glow.addColorStop(1, "rgba(99,176,227,0)");
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#63B0E3"; ctx.font = `700 30px ${disp}`; ctx.fillText("VAULTMARK", 64, 84);
  ctx.fillStyle = "#5B6779"; ctx.font = `500 22px ${mono}`; ctx.fillText("steam portfolio appraisal", 288, 84);

  // Server-side has none of the CORS-canvas-tainting the browser's PNG
  // download has to avoid — safe to actually draw the avatar here.
  let nameX = 64;
  if (snap.avatar) {
    try {
      const img = await loadImage(snap.avatar);
      const size = 96, ax = 64, ay = 128;
      ctx.save();
      rr(ctx, ax, ay, size, size, 16);
      ctx.clip();
      ctx.drawImage(img, ax, ay, size, size);
      ctx.restore();
      nameX = ax + size + 24;
    } catch { /* avatar fetch failed — skip it, don't block the whole render */ }
  }

  ctx.fillStyle = "#E7EDF5"; ctx.font = `700 46px ${disp}`;
  ctx.fillText(textSafe(snap.persona || snap.steamid64).slice(0, 26), nameX, 178);
  ctx.fillStyle = "#5B6779"; ctx.font = `400 20px ${mono}`;
  ctx.fillText(snap.steamid64, nameX, 210);

  ctx.fillStyle = "#E7EDF5"; ctx.font = `700 126px ${disp}`;
  ctx.fillText(fmtMoney(snap.total), 58, 398);

  ctx.fillStyle = "#8894A8"; ctx.font = `500 26px ${mono}`;
  const parts = [];
  if (snap.games_value > 0) parts.push("games " + fmtMoney(snap.games_value));
  parts.push("items " + fmtMoney(snap.items_value));
  ctx.fillText(parts.join("   ·   "), 64, 446);

  ctx.fillStyle = "#63B0E3";
  rr(ctx, 64, 484, W - 128, 6, 3); ctx.fill();

  ctx.fillStyle = "#3A4557"; ctx.font = `400 19px ${mono}`;
  ctx.fillText("appraised " + new Date(snap.created_at).toISOString().slice(0, 10) + "   ·   vaultmark", 64, H - 46);

  return canvas.toBuffer("image/png");
}

app.get("/api/og/:id.png", async (req, res) => {
  if (!/^\d{17}$/.test(req.params.id)) return res.status(400).type("text/plain").send("bad steamid");
  const key = `og:${req.params.id}`;
  const hit = cacheGet(key);
  if (hit) {
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=600");
    return res.send(Buffer.from(hit, "base64"));
  }
  const snap = db.prepare(
    "SELECT * FROM snapshots WHERE steamid64 = ? ORDER BY created_at DESC LIMIT 1"
  ).get(req.params.id);
  if (!snap) return res.status(404).type("text/plain").send("no appraisal found for this steamid yet — appraise it once first");
  const png = await renderShareCard(snap);
  cacheSet(key, png.toString("base64"), 10 * 60e3);
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=600");
  res.send(png);
});

app.get("/share/:id", (req, res) => {
  if (!/^\d{17}$/.test(req.params.id)) return res.redirect("/");
  const appUrl = `/?q=${req.params.id}`;
  logEvent("share_view", { path: "/share/" + req.params.id, referrer: req.get("referer") || null, steamid64: req.params.id });
  const snap = db.prepare(
    "SELECT * FROM snapshots WHERE steamid64 = ? ORDER BY created_at DESC LIMIT 1"
  ).get(req.params.id);
  if (!snap) return res.redirect(appUrl);

  const title = escXml(`${snap.persona || snap.steamid64}'s VAULTMARK appraisal`);
  const desc = escXml(
    `Total ${fmtMoney(snap.total)}` + (snap.games_value > 0 ? ` — games ${fmtMoney(snap.games_value)} · items ${fmtMoney(snap.items_value)}` : ` — items ${fmtMoney(snap.items_value)}`)
  );
  const imgUrl = `${req.protocol}://${req.get("host")}/api/og/${req.params.id}.png`;
  const pageUrl = `${req.protocol}://${req.get("host")}/share/${req.params.id}`;

  res.set("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${title}</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${imgUrl}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:type" content="website">
<meta property="og:url" content="${pageUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${imgUrl}">
<meta http-equiv="refresh" content="0;url=${appUrl}">
<script>location.replace(${JSON.stringify(appUrl)});</script>
</head><body>
<p>Redirecting to <a href="${appUrl}">the appraisal</a>…</p>
</body></html>`);
});

/* ------------------------- Privacy policy (standalone page) ------------------------- */
/* AdSense's review process specifically looks for a clearly linkable privacy
   policy page — a section buried inside a collapsible FAQ panel isn't
   reliably enough. This is the same content, just given its own real URL
   and linked from the footer, which is where reviewers actually look. */

app.get("/privacy", (req, res) => {
  res.set("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — VAULTMARK</title>
<meta name="description" content="VAULTMARK privacy policy — what data is collected, what isn't, and how analytics and ads work on this site.">
<link rel="canonical" href="https://vaultmark.tech/privacy">
<style>
body{background:#0B0F15;color:#E7EDF5;font-family:system-ui,-apple-system,sans-serif;line-height:1.6;max-width:720px;margin:0 auto;padding:48px 24px}
h1{font-size:24px}h2{font-size:15px;color:#8894A8;text-transform:uppercase;letter-spacing:.06em;margin-top:32px}
a{color:#63B0E3}li{margin:8px 0;color:#C6CFDC}
.back{display:inline-block;margin-top:32px;color:#5B6779;font-size:13px}
</style></head><body>
<h1>Privacy Policy</h1>
<p style="color:#8894A8">Last updated ${new Date().toISOString().slice(0, 10)}</p>

<h2>What this site does</h2>
<p style="color:#C6CFDC">VAULTMARK appraises public Steam profiles — game library and item inventory value — using Steam's own public APIs and third-party market prices (Skinport, Steam Community Market). No login, no Steam credentials, ever.</p>

<h2>What's collected</h2>
<ul>
<li>No account, no login, no Steam credentials — everything shown comes from Steam's own public APIs, the same data anyone could look up about a public profile.</li>
<li>Every completed appraisal saves a snapshot (persona name, avatar URL, totals, timestamp) to power "value over time" history — private by default, tied only to the SteamID64 looked up.</li>
<li>That snapshot only becomes visible to other visitors if the person explicitly opts into the public leaderboard — unchecked by default, per-appraisal, not a permanent setting.</li>
<li>The contact form never sends anything to this server — it opens your own email client with the message pre-filled.</li>
<li>Steam profile data, item prices, and inventory contents are cached temporarily (30 minutes to a few hours) purely to avoid hammering Steam's rate limits.</li>
</ul>

<h2>Analytics</h2>
<p style="color:#C6CFDC">Basic usage analytics are logged — page loads, appraisals started, share-link views — with no cookies, no per-visitor identifier, and no IP address stored. Just event counts with the page and referrer, visible only to the site owner.</p>

<h2>Advertising</h2>
<p style="color:#C6CFDC">This site may show ads served by Google AdSense. If enabled, Google may set cookies to measure and personalize ads — see <a href="https://policies.google.com/technologies/ads" target="_blank" rel="noopener noreferrer">Google's ad policy</a> for details. Visitors in the UK/EEA are shown a consent choice before any personalized ad cookies are set.</p>

<h2>Contact</h2>
<p style="color:#C6CFDC">Questions, feedback, or a leaderboard removal request — use the contact form linked from the <a href="/">homepage</a>.</p>

<a class="back" href="/">← Back to VAULTMARK</a>
</body></html>`);
});

/* ------------------------- Stats dashboard (owner-only) ------------------------- */
/* Gated by ADMIN_KEY (set it in .env) rather than any login system — this
   app has no accounts at all, and adding one just to view traffic would be
   a lot of new surface area for one page. Returns a plain 404 (not 403) on
   a wrong/missing key so the route's existence isn't even confirmable. */

const ADMIN_KEY = process.env.ADMIN_KEY || "";

function countSince(type, ms) {
  return db.prepare("SELECT COUNT(*) as n FROM events WHERE type = ? AND created_at > ?").get(type, Date.now() - ms).n;
}

app.get("/api/stats", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(404).send("Not found");

  const DAY = 24 * 3600e3;
  const windows = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
  const summary = {};
  for (const type of ["pageview", "appraisal", "share_view"]) {
    summary[type] = {};
    for (const [label, ms] of Object.entries(windows)) summary[type][label] = countSince(type, ms);
  }

  const topReferrers = db.prepare(`
    SELECT COALESCE(NULLIF(referrer, ''), '(direct)') as ref, COUNT(*) as n
    FROM events WHERE type = 'pageview' AND created_at > ?
    GROUP BY ref ORDER BY n DESC LIMIT 10
  `).all(Date.now() - 30 * DAY);

  const mostAppraised = db.prepare(`
    SELECT e.steamid64, MAX(s.persona) as persona, COUNT(*) as n
    FROM events e LEFT JOIN snapshots s ON s.steamid64 = e.steamid64
    WHERE e.type = 'appraisal' AND e.created_at > ?
    GROUP BY e.steamid64 ORDER BY n DESC LIMIT 10
  `).all(Date.now() - 30 * DAY);

  const recent = db.prepare(`SELECT type, path, referrer, steamid64, created_at FROM events ORDER BY created_at DESC LIMIT 30`).all();

  const row = (label, d) => `<tr><td>${label}</td><td class="mono">${d["24h"]}</td><td class="mono">${d["7d"]}</td><td class="mono">${d["30d"]}</td></tr>`;

  res.set("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>VAULTMARK — stats</title>
<style>
body{background:#0B0F15;color:#E7EDF5;font-family:system-ui,sans-serif;padding:32px;max-width:960px;margin:0 auto}
h1{font-size:20px}h2{font-size:14px;color:#8894A8;text-transform:uppercase;letter-spacing:.06em;margin-top:32px}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #212B3C;font-size:13px}
th{color:#5B6779;font-weight:500}
.mono{font-family:ui-monospace,monospace}
</style></head><body>
<h1>VAULTMARK — usage stats</h1>
<h2>Events</h2>
<table><tr><th></th><th>24h</th><th>7d</th><th>30d</th></tr>
${row("Pageviews", summary.pageview)}
${row("Appraisals started", summary.appraisal)}
${row("Share link views", summary.share_view)}
</table>
<h2>Top referrers (30d)</h2>
<table><tr><th>Referrer</th><th>Views</th></tr>
${topReferrers.map((r) => `<tr><td>${escXml(r.ref)}</td><td class="mono">${r.n}</td></tr>`).join("")}
</table>
<h2>Most appraised profiles (30d)</h2>
<table><tr><th>SteamID64</th><th>Persona</th><th>Times</th></tr>
${mostAppraised.map((r) => `<tr><td class="mono">${r.steamid64}</td><td>${escXml(r.persona || "—")}</td><td class="mono">${r.n}</td></tr>`).join("")}
</table>
<h2>Recent activity</h2>
<table><tr><th>Type</th><th>Path/SteamID</th><th>Referrer</th><th>When</th></tr>
${recent.map((r) => `<tr><td>${r.type}</td><td class="mono">${escXml(r.path || r.steamid64 || "")}</td><td>${escXml(r.referrer || "")}</td><td>${new Date(r.created_at).toLocaleString()}</td></tr>`).join("")}
</table>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`VAULTMARK running at http://localhost:${PORT}`);
  if (!STEAM_KEY) console.log("⚠  No STEAM_API_KEY set — copy .env.example to .env and add your key.");
});
