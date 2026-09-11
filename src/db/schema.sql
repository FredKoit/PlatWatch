-- PlatWatch schema.
--
-- Identity is the warframe.market item id, never the slug: slugs have aliases
-- (`mirage_prime_systems` addresses `mirage_prime_systems_blueprint`), so a
-- slug-keyed join silently loses rows that are actually present.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  tags              TEXT NOT NULL,           -- JSON array
  -- Columns below come from /v2/item/{slug} and stay NULL until detail is
  -- fetched. Only set roots and their parts need it, so most rows keep NULLs.
  set_root          INTEGER,
  quantity_in_set   INTEGER,
  ducats            INTEGER,
  req_mastery_rank  INTEGER,
  tradable          INTEGER,
  detail_fetched_at TEXT
);

-- One row per (set, component). `qty` is quantityInSet: dual-wield and akimbo
-- weapons need 2 of most parts, and treating it as 1 inverts the arbitrage.
CREATE TABLE IF NOT EXISTS item_part (
  set_id  TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  qty     INTEGER NOT NULL CHECK (qty >= 1),
  PRIMARY KEY (set_id, part_id)
);
CREATE INDEX IF NOT EXISTS item_part_part ON item_part(part_id);

-- Provenance: which crawl produced which rows, and whether it finished.
CREATE TABLE IF NOT EXISTS sweep (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('top','detail','stats')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  items_ok     INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0
);

-- One row per item per sweep: the order book as it stood, reduced to the
-- numbers ranking needs.
CREATE TABLE IF NOT EXISTS snapshot (
  id             INTEGER PRIMARY KEY,
  item_id        TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  sweep_id       INTEGER NOT NULL REFERENCES sweep(id) ON DELETE CASCADE,
  -- Prices are per variant, not per item: '' for plain items, 'r10' for a
  -- maxed mod, 'radiant' for an upgraded relic. One row per variant per sweep.
  variant        TEXT NOT NULL DEFAULT '',
  taken_at       TEXT NOT NULL,
  low_sell       INTEGER,   -- cheapest reachable ask: the buy target
  high_buy       INTEGER,   -- best standing bid
  sell_p50_top   INTEGER,   -- median of the top sells: the robust fair value
  buy_p50_top    INTEGER,
  sell_count     INTEGER NOT NULL,
  buy_count      INTEGER NOT NULL,
  -- Age of the freshest sell we priced from. A book of old orders is a
  -- hypothesis, not a quote.
  newest_sell_age_h REAL
);
CREATE INDEX IF NOT EXISTS snapshot_item_time ON snapshot(item_id, taken_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS snapshot_item_sweep ON snapshot(item_id, sweep_id, variant);

CREATE TABLE IF NOT EXISTS stat_daily (
  item_id   TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  day       TEXT NOT NULL,
  -- History is per variant too: a rank-0 mod and a rank-10 mod have separate
  -- series with different volumes and medians on the same day.
  variant   TEXT NOT NULL DEFAULT '',
  volume    INTEGER NOT NULL,
  median    REAL,
  avg_price REAL,
  min_price REAL,
  max_price REAL,
  PRIMARY KEY (item_id, day, variant)
);

-- Every order id ever observed. `sightings` and `gone_at` are the raw material
-- for reachability scoring: an order that survives many sweeps at the top of
-- the book is one nobody can actually buy, whatever its price says.
CREATE TABLE IF NOT EXISTS order_seen (
  order_id    TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  ingame_name TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('sell','buy')),
  platinum    INTEGER NOT NULL,
  variant     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  sightings   INTEGER NOT NULL DEFAULT 1,
  -- Rank within the top-5 at the last sighting; 0 is the best price on the
  -- book. Kept because the ghost signal is specifically "sat at rank 0 and
  -- still nobody bought it".
  top_rank        INTEGER,
  sweeps_at_best  INTEGER NOT NULL DEFAULT 0,
  -- First sweep in which this order was absent from the top-5.
  -- NOT a fill signal: /top returns only the best five, so five better orders
  -- appearing pushes an order out just as surely as a sale does. Treat it as
  -- "left the top of book", and nothing more.
  left_top_at TEXT
);
CREATE INDEX IF NOT EXISTS order_seen_item ON order_seen(item_id);
CREATE INDEX IF NOT EXISTS order_seen_user ON order_seen(user_id);

-- Your own trade attempts. A per-seller reply rate built from a few hundred of
-- these beats every freshness heuristic, and no public tool can build it.
CREATE TABLE IF NOT EXISTS whisper_log (
  id          INTEGER PRIMARY KEY,
  order_id    TEXT,
  item_id     TEXT NOT NULL REFERENCES item(id),
  user_id     TEXT NOT NULL,
  ingame_name TEXT NOT NULL,
  platinum    INTEGER NOT NULL,
  sent_at     TEXT NOT NULL,
  replied     INTEGER,   -- NULL = still waiting
  traded      INTEGER,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS whisper_log_user ON whisper_log(user_id);

-- Liquidity, derived from price history at ingest time.
--
-- `volume_48h` comes from the hourly buckets and is the freshest read;
-- `days_traded_30d` separates a steadily liquid item from one whose entire
-- volume landed in a single spike, which spread alone cannot distinguish.
CREATE TABLE IF NOT EXISTS stat_summary (
  item_id         TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  variant         TEXT NOT NULL DEFAULT '',
  fetched_at      TEXT NOT NULL,
  volume_48h      INTEGER NOT NULL,
  volume_7d       INTEGER NOT NULL,
  volume_30d      INTEGER NOT NULL,
  median_7d       REAL,
  median_30d      REAL,
  days_traded_30d INTEGER NOT NULL,
  -- Most recent day with any trade. History can simply stop: an item whose
  -- series ended days ago has no current price, whatever its volume says.
  last_traded_day TEXT,
  -- End of the newest HOURLY bucket. Prefer this: the daily series covers
  -- closed days only and is always at least a day behind.
  last_traded_at  TEXT,
  PRIMARY KEY (item_id, variant)
);

-- Alerts fired by the live watcher. A new TABLE needs no migration: schema.sql
-- runs on every open with IF NOT EXISTS. Only changes to EXISTING tables have
-- to go through migrate.ts.
CREATE TABLE IF NOT EXISTS alert (
  id             INTEGER PRIMARY KEY,
  order_id       TEXT NOT NULL,
  item_id        TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  variant        TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL CHECK (kind IN ('underpriced_sell','overpriced_buy')),
  platinum       INTEGER NOT NULL,
  reference      INTEGER NOT NULL,   -- the price we judged it against
  profit         INTEGER NOT NULL,
  volume_48h     INTEGER,
  ingame_name    TEXT NOT NULL,
  user_status    TEXT NOT NULL,
  -- How old the baseline was when this fired. A big number means the
  -- comparison price came from a sweep long past.
  baseline_age_h REAL,
  -- The price was so far off the traded median that it is more likely a
  -- mistake or bait than an opportunity. Still reported, but not trusted.
  suspicious     INTEGER NOT NULL DEFAULT 0,
  fired_at       TEXT NOT NULL
);
-- One alert per order per kind, so a re-poll cannot spam the same find.
CREATE UNIQUE INDEX IF NOT EXISTS alert_order_kind ON alert(order_id, kind);
CREATE INDEX IF NOT EXISTS alert_fired ON alert(fired_at DESC);

-- Items you are actively trading. These get re-polled far more often than the
-- nightly sweep, because a price from last night is a hypothesis, not a quote.
CREATE TABLE IF NOT EXISTS watchlist (
  item_id  TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  variant  TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  PRIMARY KEY (item_id, variant)
);

-- Best prices observed from the live feed since the last sweep.
--
-- /v2/orders/recent shows orders being POSTED, never cancelled or filled, so a
-- price here is evidence one existed recently, not proof it exists now. Each
-- side carries its own timestamp and readers must ignore observations older
-- than the freshness window — that expiry is what keeps a filled order from
-- haunting the book until the next sweep.
CREATE TABLE IF NOT EXISTS live_book (
  item_id     TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  variant     TEXT NOT NULL DEFAULT '',
  low_sell    INTEGER,
  low_sell_at TEXT,
  high_buy    INTEGER,
  high_buy_at TEXT,
  PRIMARY KEY (item_id, variant)
);

-- Positions you actually took.
--
-- The project's real success metric is platinum earned, and nothing else here
-- records it. Every threshold in the ranking policy is a guess until these rows
-- exist to check them against.
--
-- `expected_margin` is what the tool predicted when the position was opened.
-- Kept deliberately: comparing it against the realised margin is the only way
-- to find out whether the filters are calibrated or merely plausible.
CREATE TABLE IF NOT EXISTS trade (
  id             INTEGER PRIMARY KEY,
  item_id        TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  variant        TEXT NOT NULL DEFAULT '',
  quantity       INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),

  -- Buy leg. A row exists from the moment platinum leaves your account.
  buy_price      INTEGER NOT NULL,
  bought_at      TEXT NOT NULL,
  bought_from    TEXT,

  -- Sell leg. NULL while the position is open.
  sell_price     INTEGER,
  sold_at        TEXT,
  sold_to        TEXT,

  -- What the tool predicted at the time, and which strategy suggested it.
  expected_sell  INTEGER,
  expected_margin INTEGER,
  source         TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('spread','set','alert','manual')),
  note           TEXT
);
CREATE INDEX IF NOT EXISTS trade_open ON trade(sold_at) WHERE sold_at IS NULL;
CREATE INDEX IF NOT EXISTS trade_item ON trade(item_id, variant);
