# PlatWatch

A Warframe platinum trading scanner for PC. It crawls warframe.market, ranks
what is worth trading, watches the live order feed for underpriced listings, and
keeps a journal so you can find out whether any of it actually made money.

Personal tool. Local only, single user, no authentication.

## Quick start

```bash
npm install
npm start          # daemon: UI + live sniper + scheduled crawls
```

Then open <http://127.0.0.1:5173>.

The first run needs a baseline before anything is rankable — the daemon fetches
the catalogue, sweeps every item's order book (~22 min), then pulls price
history (~20 min). The live sniper waits for that sweep to finish and then
starts on its own.

## Alerts

On Windows, alerts arrive as **toast notifications** — the one channel that
works with nobody at a terminal. A burst becomes a single toast, led by the best
genuine find, and clicking it opens the UI to copy the whisper. Turn them off
with `--no-toast`.

For a phone, set `DISCORD_WEBHOOK_URL`. When PlatWatch runs from Task Scheduler
this has to be a **user** environment variable — a scheduled task never sees
variables set only in a shell:

```powershell
[Environment]::SetEnvironmentVariable('DISCORD_WEBHOOK_URL', '<your webhook>', 'User')
```

Then restart the daemon so it picks the variable up.

## Running it unattended

`npm start` stops when its terminal closes. To keep PlatWatch running and have
it start at login, register it with Task Scheduler:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-task.ps1
Start-ScheduledTask -TaskName PlatWatch      # start now, without logging out
```

It runs as you, only while you are logged on — no administrator rights, no
stored password. Output goes to `.cache\platwatch.log`, which rotates to
`platwatch.log.1` whenever it passes 5 MB — while running, not just at start.

| Script | What it does |
|---|---|
| `scripts\platwatch-stop.ps1` | Stop the running daemon |
| `scripts\uninstall-task.ps1` | Remove the task and stop the daemon |

Stop it with the script rather than "End" in Task Scheduler. Ending the task
stops the PowerShell launcher but can leave its node child running; the script
targets whatever holds the port. A hard stop is safe: SQLite is in WAL mode and
an interrupted sweep resumes on the next start.

**Only one process talks to warframe.market at a time.** The UI port is the
lock. A second `npm start`, and `npm run ingest` / `npm run watch` /
`npm run verify:phase1` while the daemon is up, all refuse and say why — each
would otherwise run its own rate limiter and double the load. To run one of
those by hand, stop the daemon first. Anything that only reads the database
(`rank`, `ducats`, `sell`, the other gates) runs freely alongside it.

## Commands

| Command | What it does |
|---|---|
| `npm start` | The daemon. Everything in one process — see below. |
| `npm run rank` | Ranked opportunities. `--kind set`, `--sort return`, `--max-capital 150`, `--rejected` |
| `npm run ducats -- --budget 200` | Ducat conversions for the Baro play |
| `npm run sell -- rhino_prime_set` | What to list something at, and how long it will take |
| `npm run watch` | Live sniper alone |
| `npm run ingest -- sweep` | A crawl by hand: `catalog`, `details`, `sweep`, `stats` |
| `npm test` | 182 tests |

Sweeps are resumable. Interrupt one and `npm run ingest -- sweep --resume`
continues it rather than starting over.

## Why one process

The rate limiter is per-process. Separate processes each get their own 3 req/s
budget, and a small volunteer-run service sees the sum. The daemon shares one
limiter across every job, and priority keeps the live poll ahead of a
22-minute crawl.

Jobs: catalogue daily, part lists for new sets hourly (no requests unless a new
Prime Access landed), full sweep every 6h, price history daily, retention daily,
watchlist every 5 min. Jobs with nothing to do log nothing. Last-run times
persist, so restarting does not re-trigger a long crawl.

## How it decides

Two strategies, plus ducat conversion, plus a live alert feed.

**Spread** is market making: post a bid above the best bid, an ask below the
best ask, wait for both. Margin is the spread minus what it costs to be top of
book on each side. This is not a whisper — offering a seller their asking price
and then undercutting it loses money.

**Set arbitrage** buys components at their asks, assembles, and undercuts the
set — but never lists above where sets actually trade. Against the ask alone,
Aeolak topped the list at +183p: 64p of parts, cheapest set ask 248p, for a set
that trades at 77p. Component quantities matter too: dual-wield sets need two of
most parts, and treating that as one inverts the answer. The **Sets** tab lays
this out per set — every part × quantity, their sum, what the set sells for —
and can show the sets held back, with the reason.

**Ducats** spends platinum for a different currency, so it is ranked separately.
Parts convert at a fixed rate whatever you paid, so only the purchase price
moves the return.

Everything is filtered on liquidity, book freshness, corroboration on both
sides, and — the rule that took longest to learn — **prices are judged against
completed trades, never against what sellers ask.**

## Things the API will do to you

Every one of these was found the hard way.

**v1 is dead except for one route.** `/v1/items` 404s and `/v1/.../orders`
returns `403 Deprecated`. Price history at `/v1/items/{slug}/statistics` still
answers and has no v2 replacement. It is isolated behind an interface for the
day it stops.

**There are no CORS headers.** The browser cannot call the API. Everything goes
through the local server.

**Orders carry `rank`, `subtype` and star counts, and they are different goods.**
Over half of live orders have a rank. Archon Vitality sells at 20p unranked and
has 85p buy orders for the maxed version; Lith relics sell intact and buy
radiant. Pricing an item as one market invents enormous margins out of nothing.
Everything is keyed per variant.

**Price history is split the same way, under different field names.** Statistics
use `mod_rank` and `subtype` where orders use `rank` and `subtype`. Orders also
report `subtype: "regular"` where history reports nothing, so the neutral
subtype is normalised away or the two never join.

**`quantityInSet` is not always 1.** Akimbo and dual-wield sets need two of most
components. Dual Kamas Prime costs ~100p in parts against an 88p set — a flat
sum shows +40p and gets the sign wrong.

**`setParts` includes the set's own id.** Count it and the set becomes a
component of itself.

**Slugs have aliases.** `mirage_prime_systems` resolves to
`mirage_prime_systems_blueprint` — same item, different address. Identity
belongs on `id`; a slug is only how you address the API.

**Zero-volume buckets are omitted, not zeroed.** Taking the last 30 buckets of
history spans far more than 30 days on an illiquid item, and overstates its
recent volume badly. Window by date.

**`/orders/recent` shows orders being posted, never cancelled or filled.** A
price seen there is evidence one existed, not proof it still does — and the
cheapest asks are the ones most likely to have been bought. Live observations
expire after 15 minutes for exactly this reason.

**`/top` returns only online and `ingame` sellers.** That discards the
overwhelming majority of dead listings for free, but it removes *cheap* prices,
not *bad* ones: the lowest ask is frequently held by someone offline.

## Data

SQLite at `.cache/platwatch.db`. Schema in `src/db/schema.sql`, changes in
`src/db/migrate.ts`.

**Retention: 30 days.** A daily job removes orders that left the book more than
30 days ago, and snapshots from sweeps older than that. It never removes an
order still on the book, an order your whisper log refers to, or the latest
full sweep. Without it the database grew about 40 MB a day indefinitely; with
it, it levels off around 1 GB. Deleted space is reused rather than returned, so
the file stops growing instead of shrinking. The window is `RETENTION_DAYS` in
`src/db/retention.ts`. Price history (`stat_daily`) is left alone: it is small,
and anything older than 90 days cannot be fetched again.

One rule governs migrations: **`order_seen.first_seen` records when *you* first
saw an order and cannot be refetched at any price.** Derived caches like
`stat_daily` may be rebuilt; observation history never is. "Just rebuild the
database" stopped being an acceptable answer the moment real crawl history
existed.

The journal stores what the tool *predicted* alongside what you realised, so the
calibration table can compare them. It reports its own confidence — a ratio
built from trades that cannot corroborate it says so rather than reading as
accuracy.

## What it deliberately does not do

**It does not whisper or trade for you.** That would be a bot under both
Warframe's and warframe.market's rules. Copying a message is the boundary.

**It does not model the credit trade tax.** Out of scope by choice.

**Its thresholds are guesses.** Every number in `DEFAULT_POLICY` and
`DEFAULT_ALERT_POLICY` is judgement, not measurement. That is what the journal
is for — a few dozen real trades will say more about which are wrong than any
amount of reasoning.

## Caveats worth repeating

Prices are a hypothesis unless marked **live**, and even a live one is only
evidence a price existed minutes ago. Confirm in game before committing
platinum.

Ghost detection (`sweeps_at_best`) needs sweeps spread over hours before "still
cheapest, still unsold" means anything. On the 6-hour schedule it becomes useful
within a day or two.

The server binds to loopback only. There is no authentication and the database
holds your trade history — do not expose it.
