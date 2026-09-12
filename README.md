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

For a phone, set `PLATWATCH_DISCORD_WEBHOOK_URL`. When PlatWatch runs from Task Scheduler
this has to be a **user** environment variable — a scheduled task never sees
variables set only in a shell:

```powershell
[Environment]::SetEnvironmentVariable('PLATWATCH_DISCORD_WEBHOOK_URL', '<your webhook>', 'User')
```

Then restart the daemon so it picks the variable up.

Discord messages are stored in SQLite before delivery. If Discord or the network
is unavailable, PlatWatch retries with increasing delays for up to an hour
between attempts, and the queue survives a restart.

**Exit alerts** cover what you already hold, through the same toast and
webhook. Record a purchase with "bought" and give it a target; every five
minutes the daemon checks each open position and says when a buyer bids at or
above your target (with the whisper to sell to them), when units are listed
below it, or when the position has sat far longer than expected. Each signal
fires once; a better bid or a deeper undercut fires again. Held items are
refreshed with the watchlist, so the check reads a book minutes old, not hours.

Positions with more than one unit can be sold in parts. Enter the quantity sold;
PlatWatch records that lot's profit and leaves the remaining units open at their
original cost and target. Each lot remembers the purchase it was sold from, and
the alert that found it, so alert performance counts every partial sale once.

On **Live alerts**, choosing _bought_ on a "buy it" alert records an open
position and links it to the alert in one server step. Choosing _sold_ on a "sell
to them" alert lists your matching open positions: pick one and the quantity
sold, and the profit comes from what that position really cost. With nothing
tracked to sell from, _Record untracked sale_ asks for the original cost. Doing
either again — after an error, or by accident — returns the trade already
recorded instead of creating a second one. An older outcome saved without a
trade keeps an _add to trades_ repair button.

Alert references are medians and can be decimal (138.75p). Predictions keep
their decimals for calibration; suggested listing targets round down to whole
platinum, and platinum paid and received is always whole.

Repeats of the same item at the same price fold under one row, suspicious
alerts stay collapsed until asked for, and only an alert still backed by a
fresh, reachable order is marked **actionable** — the rest say _verify first_.
Every item name links to its warframe.market page in a new tab, so a listing can
be confirmed before trading; price history is the _history_ button beside it.

Settings shows whether the running daemon actually has Windows toasts on. The
scheduled task starts it with `--no-toast`, so they read _disabled_; Discord is
unaffected.

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

| Script                       | What it does                        |
| ---------------------------- | ----------------------------------- |
| `scripts\platwatch-stop.ps1` | Stop the running daemon             |
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

| Command                           | What it does                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `npm start`                       | The daemon. Everything in one process — see below.                                     |
| `npm run rank`                    | Ranked opportunities. `--kind set`, `--sort return`, `--max-capital 150`, `--rejected` |
| `npm run ducats -- --budget 200`  | Ducat conversions for the Baro play                                                    |
| `npm run sell -- rhino_prime_set` | What to list something at, and how long it will take                                   |
| `npm run watch`                   | Live sniper alone                                                                      |
| `npm run ingest -- sweep`         | A crawl by hand: `catalog`, `details`, `sweep`, `stats`                                |
| `npm test`                        | Unit and API tests, each on an in-memory database                                      |
| `npm run test:browser`            | Clicks through the real UI in headless Chromium, on a temporary database               |

Sweeps are resumable. Interrupt one and `npm run ingest -- sweep --resume`
continues it rather than starting over.

**An outage never replaces the market.** If warframe.market stops answering,
a sweep stops after ten failures in a row and stays open; the previous sweep
remains the baseline, and the daemon resumes 30 minutes later. A sweep that
runs to the end but fetched under 90% of the catalogue is kept as partial and
never used as the baseline. Both used to happen the other way round: an outage
sweep ground on for hours, was stamped finished, and emptied the ranking and
the sniper until the next good one.

## Why one process

The rate limiter is per-process. Separate processes each get their own 3 req/s
budget, and a small volunteer-run service sees the sum. The daemon shares one
limiter across every job, and priority keeps the live poll ahead of a
22-minute crawl.

Jobs: catalogue daily, part lists for new sets hourly (no requests unless a new
Prime Access landed), full sweep every 6h, price history daily, retention daily,
watchlist — plus everything you hold — every 5 min, and the exit check every 5
min (database only, no requests). Jobs with nothing to do log nothing. Last-run
times persist, so restarting does not re-trigger a long crawl.

## How it decides

Two strategies, plus ducat conversion, plus a live alert feed.

**Spread** is market making: post a bid above the best bid, an ask below the
best ask, wait for both. Margin is the spread minus what it costs to be top of
book on each side. This is not a whisper — offering a seller their asking price
and then undercutting it loses money.

**Set arbitrage** buys components, assembles, and undercuts the set — but never
lists above where sets actually trade. Against the ask alone, Aeolak topped the
list at +183p: 64p of parts, cheapest set ask 248p, for a set that trades at
77p. The parts are costed by **walking the book**: two blades from a seller
holding one cost the cheapest blade plus the next one up, and a part you cannot
buy enough of from reachable sellers holds the set back as "short" rather than
pricing it. The **Sets** tab lays this out per set — every part, who you would
buy it from, their sum, what the set sells for — and can show the sets held
back, with the reason.

**Ducats** spends platinum for a different currency, so it is ranked separately.
Parts convert at a fixed rate whatever you paid, so only the purchase price
moves the return.

Everything is filtered on liquidity, book freshness, corroboration on both
sides, and — the rule that took longest to learn — **prices are judged against
completed trades, never against what sellers ask.**

**A sniped listing is worth what you can resell it for.** A sell alert's
profit is its worth — the lower of the ask median and the traded median —
capped just under any cheaper ask already listed, because to resell you have
to be first. That cap used to be missing: of 151 real buy alerts, 143
overstated their profit and 51 had none at all, like Volt Prime Neuroptics
fired at 35p "under a 45p median" with a 15p ask on the book.

**Selling time** comes with every row as optimistic, base, and conservative
scenarios: your place in the queue over the units sold per day, counting both
legs of a spread (your bid filling, then your ask selling). The range widens as
the evidence weakens — high confidence needs trades on most days of the month
and enough of them. Platinum you wait on is platinum you cannot use. A position
is flagged as sitting when it passes either a meaningful overrun of its base
estimate or the three-day maximum hold, whichever comes first.

**The plan** turns a budget into a shortlist: the ranked trades in order, one
per item, none taking more than the per-item limit — counting what you already
hold in it. Ranked by default on return per day, which puts a 15p edge that
sells today ahead of 400p that sits for a week.

Set recommendations reserve the exact seller-order quantities they consume.
Once a higher-ranked set uses a scarce listing, another set cannot spend the
same stock again. Its component checklist is saved in SQLite — so it survives
another browser, restarts and backups — and tracks needed, contacted, purchased,
and unavailable orders. A half-bought set stays on Today, with the shopping list
it was bought from, until you mark it assembled or remove it, even after it
stops qualifying as an opportunity. Progress older versions kept in the
browser's localStorage moves into the database the first time the page loads. Actual paid totals update
the remaining cash requirement and projected margin; unavailable entries can
refresh every component book to find replacement sellers.

**Today** is the operating queue: positions that need a sale decision first,
unfinished set purchases next, then the five best trades from the current
budget plan. A trade's Verify action refreshes the resale market and every
component market immediately before you commit platinum.

The Today toolbar also provides CSV exports for trades, whispers, and alerts,
plus a manual backup button. The daemon creates a SQLite-consistent backup at
startup and daily thereafter in `.cache/backups`, retaining the latest seven.
Background jobs record attempts, successful completions, consecutive failures,
and the latest error; failed jobs retry with bounded exponential backoff and
surface their error in the dashboard header.

**Your results re-rank the strategies.** Each strategy's expected profit is
scaled by what its closed trades actually realised, weighted as if ten trades
had already landed on the prediction — ten closed trades move it halfway, a
handful barely at all. With no record it changes nothing. The Trades tab shows
the factor per strategy.

Every ranked trade has a **Why?** panel. It shows profit at the proposed
listing, the recent completed-trade median, an immediately reachable bid, and a
5p downside move, followed by break-even, timing evidence, price age, volume,
risk penalties, and the component-order breakdown for sets.

Calibration compares predicted and realised margins only for the same trades
that have a recorded prediction. Trades without predictions still count in
total profit, but do not influence the strategy's calibration.

**Price history** opens from the _history_ button beside any item name: daily traded median with its
low–high range, and volume, with the trade's own prices drawn across it — the
way to tell an unusual bargain from a market sliding downhill. Rows carry a
trend tag when last week's price moved 5% or more against the month's.

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

**Orders carry a quantity, and sellers an online status — both were being
thrown away.** A set needing two of a part was priced off a seller who might
hold one, and the cheapest "seller" offered was often an offline player or a
feed sighting hours old: for 172 of 766 set parts, the seller shown asked less
than the price the set was costed at. Both are recorded now, and a seller only
counts if a full top-of-book sweep saw them within six hours, or the creation feed saw them within 15 minutes,
and they were not last seen offline. A past top rank does not bypass expiry.
The same rule applies to buyers used for exit signals. Sets without enough
recently observed component stock are held back until fresh observations arrive;
historical prices can remain visible without an actionable seller.

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
overwhelming majority of dead listings for free, but it removes _cheap_ prices,
not _bad_ ones: the lowest ask is frequently held by someone offline.

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

One rule governs migrations: **`order_seen.first_seen` records when _you_ first
saw an order and cannot be refetched at any price.** Derived caches like
`stat_daily` may be rebuilt; observation history never is. "Just rebuild the
database" stopped being an acceptable answer the moment real crawl history
existed.

The journal stores what the tool _predicted_ alongside what you realised, so the
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
