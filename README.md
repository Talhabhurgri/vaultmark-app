# VAULTMARK

Steam portfolio appraiser. Paste any profile URL / vanity name / SteamID format, get game-library value plus item-level inventory appraisals for CS2, Dota 2, TF2, Rust and Steam Community items (trading cards, backgrounds, emotes, gems), with a downloadable share card. No login required from the person being appraised.

## Setup

Requires Node 22.5+ (uses native `fetch` and the built-in `node:sqlite` — no native module to compile).

```bash
npm install
cp .env.example .env      # then paste your key into .env
npm start                 # http://localhost:3000
```

Get a Steam Web API key at https://steamcommunity.com/dev/apikey (any domain value works for local use). Keep the key in `.env` — it's server-side only and never reaches the browser. `.env` is gitignored; `.env.example` is committed and must never contain a real key.

What works without a key: inventories + item prices (the community inventory endpoint is keyless). What needs the key: vanity-name resolution, profile names/avatars, and the owned-games library.

## Data sources

| Data | Source | Cache |
|---|---|---|
| Vanity → SteamID64 | `ISteamUser/ResolveVanityURL` | 24 h |
| Profile name/avatar/account age | `ISteamUser/GetPlayerSummaries` (`timecreated`) | 30 min |
| Steam level, badge count, ban status | `IPlayerService/GetBadges` + `ISteamUser/GetPlayerBans` | 24 h |
| Owned games + hours | `IPlayerService/GetOwnedGames` | 30 min |
| Current game prices | `store.steampowered.com/api/appdetails` (batched, `price_overview` filter, selectable store region, normalized to USD) — regular + sale price + discount % | 6 h per app per region |
| Inventories | `steamcommunity.com/inventory/{id}/{appid}/{context}` (paginated; context 2 for games, 6 for Community appid 753) | 30 min |
| Item prices | Skinport public API (`min_price` as market, `suggested_price` as reference) — covers 730/570/440/252490, no key needed | 10 min |
| Fallback item prices | `steamcommunity.com/market/priceoverview` — one slow global queue (1 req/3.5 s, 90 s backoff on 429) back-fills anything Skinport misses, incl. all Community items | 24 h hits, 6 h misses |
| FX rates | open.er-api.com (USD base, 20+ currencies) | 12 h |
| Deals (games you don't own) | CheapShark `deals` API — free, keyless | 4 h |

The cache persists to a local SQLite file, `vaultmark.db` (built with Node's built-in `node:sqlite` — no native module to install). "Refresh" on a result page drops that profile's cache entries and refetches. `vaultmark.db` and the legacy `cache.json` are both gitignored; if you're upgrading from an older checkout that still has a `cache.json`, its unexpired entries are migrated into SQLite automatically on first boot.

## Rate limits (read this before deploying)

- The **community inventory endpoint 429s aggressively**. The server fetches politely (1.2 s between pages), caches successes for 30 min, and surfaces a clear retry message on 429. At real traffic you'll want rotating egress IPs in front of `fetchInventory()`.
- `appdetails` allows roughly 200 requests per 5 min; the 6 h per-app price cache plus 100-appid batching keeps you far under it after warmup.
- Skinport's API is cached on their side for 5 min and is one request per app — effectively free.

Game totals count the **regular** price (`initial`), not the sale price, so appraisals stay comparable across Steam sales — active discounts are shown per game, plus a "rebuilding this library today would cost X" line while sales are on.

Store prices are region-specific (Steam's regional pricing differs hugely — Rust is $39.99 in the US store, $18.99 in Pakistan's, ₹1,799 in India's, all verified live). The header's **Store region** selector defaults to a guess at the visitor's own region — from `navigator.languages`, e.g. `ur-PK` → `pk` — falling back to US if the locale doesn't map to a supported region or has no region subtag at all. It's a heuristic, not exact (locale isn't geography), so the selector is still there to override it manually. Regional prices returned in local currency are normalized to USD via the FX feed, so the display-currency dropdown stays a pure conversion layer on top.

## Item prices: Skinport first, Steam Market fallback

Skinport returns every listed item for an app in one response, and third-party market prices are closer to what traders consider real value anyway — so it's the primary source for the four game apps. Anything Skinport doesn't carry (long-tail items, and the entire Community inventory) goes into a lazy throttled queue against Steam's `priceoverview` (one item per request, ~20 req/min shared with the inventory endpoint's rate budget). Inventory responses are priced at request time from whatever the caches hold, and report `pricePending` — the count of items still awaiting their first lookup — so repeat appraisals get progressively more complete. A giant card collection (2000+ distinct items) takes a couple of hours to fully price the first time; after that it's cached for 24 h.

Items with no listing on either market show as "no current listings" and count as zero rather than a guessed number. Non-marketable items are labeled as such; items under a temporary trade/market hold (`cache_expiration` in the item description — e.g. fresh Rust drops) get a "trade hold" pill with the lift date instead of being lumped in with permanently untradable items.

## Cost to actually cash out

Every priced-items total is gross, not net — marketplaces take a cut. The summary panel and PDF report both show a second line: total fees and net payout if everything priced were sold today, using each item's actual `priceSource` to pick the right rate — **Skinport 8%** standard (**6%** on items over $1000, matching their published tiered rate) or **Steam Community Market 15%** (5% Steam + 10% game publisher, the standard split across CS2/Dota2/TF2/Rust). Both rates were verified against current published fee pages, not assumed — Skinport's fee dropped from 12% to 8% in mid-2025, so a stale figure would have been wrong. Items with no known price source are called out separately and excluded from the fee estimate rather than silently assumed. This is a published-rate estimate, not a guarantee of actual proceeds — real payouts can differ by listing strategy, currency conversion, or fee changes since generation.

## PDF report

"Download PDF Report" builds a detailed, itemized document client-side via `jsPDF` + `jspdf-autotable`, self-hosted in `public/vendor/` (not pulled from a CDN at runtime, so it doesn't depend on a third party staying up). Always priced in USD regardless of the on-page currency selector — jsPDF's built-in fonts only cover WinAnsi/Latin-1, so symbols like ₹ ₩ ₽ ฿ would render as blank boxes; one reliably-correct currency beats a broken-looking one.

Two things learned the hard way, from actually reading a generated report rather than trusting that it ran without errors:
- Persona names and item names with emoji or other non-Latin1 characters rendered as mojibake (`Ø>ÝvAnomaly Ø=Ü²...` instead of "🥶Anomaly 💲..."), for the same WinAnsi-only-fonts reason as the currency symbols. `pdfSafe()` strips anything outside the printable-ASCII/Latin-1-supplement range before it hits the page.
- The first version dumped every single item — a large Community inventory produced a 35-page, 1.5MB PDF that buried the handful of items actually worth knowing about under pages of $0.03 trading cards. Item tables now cap at the top 50 by value per game, with a rollup line for the rest ("+ 945 more priced items below the cutoff, totaling $54.52").

Covers: persona/SteamID/account age, the ban warning if one applies, total/games/items, the liquidity breakdown, the cash-out-after-fees line, a game library table, and a capped itemized table per game with rarity/wear/liquidity/price columns. Meant as proof-of-value documentation for trading individual items — see the scope note above on what this app deliberately doesn't help with.

Known honesty gaps, called out in the UI: TF2 unusuals are priced by name only (the particle effect that drives their real value isn't in the market hash name — backpack.tf's API is the proper fix), and Rust DLC packs are account entitlements that no public API exposes for other accounts, so they aren't counted.

## Account reputation — level, badges, age, ban status

`GET /api/reputation/:steamid64` calls `IPlayerService/GetBadges` and `ISteamUser/GetPlayerBans` and returns Steam level, badge count, and VAC/community/economy ban status; account age comes from `timecreated` on the profile call (already being fetched, previously discarded). Rendered as a small line under the persona name — deliberately **not** folded into the dollar total, since level/badges/age aren't liquid value, just trust signals.

If the account has a VAC or community ban, a warning banner appears above the summary: Valve's own policy is that a VAC ban **permanently** freezes Steam Market access and trading on that account. An appraisal's dollar total assumes normal trading ability — on a banned account that assumption is false, so the warning says so explicitly rather than presenting a number that can't actually be realized.

## Deals: games on sale, not in your library, worth trusting

`POST /api/deals/:steamid64` (body: `{ owned: [appid, ...] }`) returns up to 24 deals from CheapShark's free, keyless API, filtered to Steam-store deals with **75%+ positive reviews and 5,000+ ratings**, sorted by review score. That rating-count floor is load-bearing, not decorative — at a lower bar (tried 500 first) the list was dominated by $0.49 shovelware with a handful of positive reviews rather than games worth knowing about. A handful of $0.00 entries CheapShark returns for delisted/giveaway-flagged listings are filtered out too, since a $0.00 "deal" reads as a bug, not a find.

The candidate pool (an 8-page fetch, ~480 raw deals) is cached globally for 4 h since it isn't personalized; only the "already own this" filter runs per request, cheaply, against the caller's owned-appid list. Their own `sortBy=Rating` parameter sorts by CheapShark's internal deal-quality score, not the game's actual Steam review score — that distinction mattered enough to sort client-side (well, server-side) on `steamRatingPercent` instead. Prices shown are US-region Steam prices from CheapShark's data, independent of the store-region selector used for your own library.

Deals are grouped into genre categories (Action, Indie, Adventure, ...) in the UI. Genre tags come from `store.steampowered.com/api/appdetails?filters=genres` — confirmed by testing that, unlike `price_overview`, this filter does **not** batch across multiple appids, so each game needs its own request. Rather than block a single `/api/deals` response on 60 sequential fetches, genre lookups run through the same kind of lazy background queue as the Steam Market price back-fill (`genreQueue` in `server.js`, 1.2 s between requests, yields to live inventory fetches): whatever's cached renders immediately, anything missing lands in a "More" bucket and gets its own category on a later request once the queue catches up. Genre tags are cached 30 days since they essentially never change.

## Float values (CS2)

Wear tier (Field-Tested etc.) comes from the item description. Exact floats require resolving each item's inspect link through the CS2 game coordinator, which means bot accounts speaking the Steam GC protocol (~1 inspect/sec per bot) or a third-party inspect service. That's deliberately out of scope here; when you have a resolver, add an endpoint like `GET /api/float?inspect=...` in `server.js` and a lazy per-item button in the UI — the card layout already reserves the space.

## Share card

Client-rendered 1200×630 canvas → PNG download. Item icons are intentionally not drawn onto the canvas: Steam's CDN doesn't send CORS headers, so drawing them would taint the canvas and break `toDataURL`.

## OG share link — the actual growth mechanism

`https://yourdomain/share/:steamid64` is a real link-unfurl target: paste it into Discord, Twitter, or Slack and it shows up as a full card, not a bare URL. The "Copy link" button on the results page gives you this URL directly.

How it works: the page itself is minimal HTML with `og:image`/`twitter:image` meta tags pointing at `GET /api/og/:steamid64.png`, plus a meta-refresh + JS redirect to send actual human visitors on to the live app (bots reading meta tags don't execute either, so they see the tags; people get redirected). The image itself is rendered server-side with `@napi-rs/canvas` — a prebuilt-binary Canvas implementation, confirmed to need no native compile step, unlike `node-canvas` — from the **latest saved snapshot** for that steamid64, not a live Steam fetch, so it's fast even on a cold cache.

Two things fixed after actually looking at the rendered output instead of trusting it ran without errors:
- The real brand fonts (Chakra Petch, JetBrains Mono) are vendored as actual `.ttf` files in `public/vendor/fonts/` and registered via `GlobalFonts.registerFromPath()` at boot — a plain string like `font: '700 30px "Chakra Petch"'` silently falls back to a system font server-side if the family was never registered, so this isn't optional.
- Emoji in persona names (extremely common on Steam) rendered as broken tofu boxes — Chakra Petch has no emoji glyphs, and unlike a browser, canvas font fallback doesn't reliably substitute a system emoji font. `textSafe()` strips anything outside printable ASCII/Latin-1 before it hits the canvas, same fix as the PDF report's `pdfSafe()`.

Unlike the client-side PNG download, the server-side render has no CORS restriction, so the avatar image is actually drawn onto the card — something the browser-side canvas deliberately can't do.

If no snapshot exists yet for a steamid64 (nobody's appraised it), `/api/og/:id.png` returns 404 and `/share/:id` redirects straight to the live appraisal instead of showing a broken image.

## History, leaderboard and badge

Every completed appraisal writes a row to the `snapshots` table (`steamid64`, totals, timestamp). Two things read from it:

- `GET /api/history/:steamid64` — every past snapshot for that account, oldest first. The client always saves one silently after a successful appraisal (`makePublic: false`), which is what powers the "value over time" sparkline on repeat visits to the same profile. This needs no opt-in because it's scoped to the exact steamid64 the visitor already looked up.
- `GET /api/leaderboard` — the latest snapshot per steamid64 with `public = 1`, ranked by total. Snapshots only get `public = 1` if the person checks "Show this appraisal on the public leaderboard" after appraising — appearing on a global "richest accounts" list is a bigger exposure than a private history line, so it's opt-in, not opt-out. There's currently no way to un-publish from the UI; that needs a moderation/delete route if it becomes a real complaint.

`GET /api/badge/:steamid64.svg` renders a shields.io-style badge (hand-built SVG, no image-rendering dependency) showing that account's latest total — embed it anywhere that accepts a hotlinked image (forum signature, Discord bio). It shows whatever the latest snapshot says regardless of that snapshot's public flag, on the same trust model as a profile URL: only someone who already has the link can fetch it.

## Selling what you just priced — and whether it'll actually sell

Every priced inventory item carries a `sellLink` — the real Skinport listing URL (`item_page` from their API) for Skinport-priced items, or a constructed `steamcommunity.com/market/listings/{appid}/{name}` URL for items priced through the Steam Market fallback.

A price alone doesn't tell you whether anyone's buying. Skinport's `quantity` (how many are listed right now) and Steam Market's `volume` (units traded in the last 24h) are both real signals of that, and were previously fetched and discarded — now every priced item carries a `liquidity: { level, metric, unitLabel }` field: `level` is `"liquid"` / `"thin"` / `"illiquid"` against a hand-picked threshold (15+ Skinport listings or 20+ Steam trades/day = liquid; under 3 = illiquid), and `metric` is the raw count so the label never stands alone as an unverifiable claim. These thresholds are a judgment call, not derived from real sell-through data — treat "liquid" as "probably fine soon," not a guarantee.

No affiliate program is wired in — VAULTMARK doesn't have the traffic Skinport's program requires yet (see their published bar: 5,000+ YouTube subs, 50+ avg Twitch viewers, or 5,000+ website views). Worth revisiting once there's real traffic.

**Scope note:** all of the above is about selling individual tradeable items through markets built for that (Skinport, Steam Community Market) — completely legitimate, same as any skin trade. Selling a whole Steam *account* is a different thing: it violates Steam's Subscriber Agreement and is a well-known scam/chargeback vector on third-party account marketplaces. This app appraises accounts; it deliberately doesn't help transfer them.

## Running this for real

A few things this needs before it's more than a local tool:

- **Host it on something with a persistent Node process** (Render, Railway, Fly.io, a VPS) — not a serverless platform. The SQLite file and the in-memory pricing queue both assume one long-lived process.
- **`helmet` and per-IP rate limiting are already wired in** (60 req/min per IP on `/api/*`). If you put this behind a reverse proxy or a PaaS load balancer, uncomment `app.set("trust proxy", 1)` in `server.js` so the limiter keys off the real client IP instead of the proxy's.
- **Content-Security-Policy is currently disabled** (`helmet({ contentSecurityPolicy: false })`) because the page loads Google Fonts and hotlinks Steam/Skinport CDN images that a default `default-src 'self'` policy would block. The other hardening headers still apply; tighten the CSP with an explicit allowlist if you want it.
- **Read Steam's Web API Terms of Use and Skinport's API terms before calling this commercial.** Aggregating and republishing Steam data at scale sits in a gray area; this isn't legal advice, just a flag to check before charging money for it.
- Nothing here handles secrets management beyond `.env` — don't commit it, and if a real key ever ends up in a file meant to be committed (like `.env.example`), treat it as compromised and rotate it at https://steamcommunity.com/dev/apikey.
