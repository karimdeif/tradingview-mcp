# World-context arm — deployment notes

Status as of **2026-08-18**: code complete, **not deployed**. QuestDB sink is off,
no systemd unit installed, no estate host contacted.

---

## ⛔ Blocking finding: TradingView allows one active session per account

Mid-run on 2026-08-18 the desktop session was terminated by TradingView with:

> **Session disconnected.** Your account was accessed from another browser or device.
> To comply with market data regulations, only one active session is allowed per user.

This is not a bug we can engineer around. It has three consequences that shape the
whole design:

**1. The arm and human use of TradingView are mutually exclusive.**
Anyone signing into this TradingView account anywhere — phone, msi, a browser tab —
kills the arm's data feed. Conversely, reconnecting the arm will kick that other
device off. A realtime arm that a phone login can silently disable is not something to
put under a live trading path without a decision about who owns the session.

**2. It fails silently, and every obvious health signal lies.**
After disconnection the app kept running and kept answering:

| Signal | Reported | Reality |
|---|---|---|
| `tv_health_check` | `success: true, cdp_connected: true, api_available: true` | session dead |
| `chart_get_state` | correct symbol after every switch | correct, but meaningless |
| `quote_get` | `success: true`, plausible price | **frozen last value** |

Two full cycles wrote 20 rows in which ES1!, NQ1!, DXY, gold and the treasury leg all
carried the **oil price, 84.38**. Those rows are quarantined at
`data/spool/QUARANTINE-contaminated-2026-08-18T11-25Z.jsonl` and **must not be
migrated** into `tv_world_quotes`.

**3. Recovery needs a UI click the allowlist deliberately withholds.**
Dismissing the modal and pressing **Connect** requires `ui_click`, which is excluded
from the read-only allowlist precisely because `ui_*` composes into an order-entry
path. Self-healing therefore costs some of the safety property. That is a real
trade-off and a decision for karim, not a default — see *Open decisions* below.

### What now detects it

`src/world/integrity.js` judges each cycle as a **set** of rows, since every individual
row was well-formed. It fails the cycle when unrelated instruments share a price, when
all symbols share one bar timestamp, or when several expected-real-time symbols go
stale together. A failed cycle is **discarded, not written**, and is not fed to the
shock detector. `tests/world_integrity.test.js` replays the real incident.

---

## Table DDL

Commit-tracked in `src/world/questdb.js` (exported as `DDL`) so docs and code cannot drift.

```sql
CREATE TABLE IF NOT EXISTS tv_world_quotes (
  ts TIMESTAMP,
  symbol SYMBOL CAPACITY 64 CACHE,
  tv_symbol SYMBOL CAPACITY 64 CACHE,
  role SYMBOL CAPACITY 32 CACHE,
  last DOUBLE,
  session_open DOUBLE,
  session_change_pct DOUBLE,
  session_high DOUBLE,
  session_low DOUBLE,
  volume LONG,
  volume_available BOOLEAN,
  bar_ts TIMESTAMP,
  feed_lag_s INT,
  delay_est_s INT,
  realtime BOOLEAN,
  realtime_drift BOOLEAN,
  exchange SYMBOL CAPACITY 32 CACHE,
  instrument_type SYMBOL CAPACITY 32 CACHE,
  source SYMBOL CAPACITY 16 CACHE,
  collector_cycle LONG,
  replayed BOOLEAN
) TIMESTAMP(ts) PARTITION BY DAY WAL
DEDUP UPSERT KEYS(ts, symbol);
```

### Field semantics that are easy to get wrong

- **`session_change_pct`** is the move since the current session's open. It is the
  field a study should use. It is **not** `data_get_ohlcv`'s `change_pct`, which spans
  the whole returned window (~144 days) — that mistake showed ES1! at **+18.4%** when
  the real session move was **−0.37%**, an inverted risk signal.
- **`volume` is NULL, never 0, when unavailable.** TVC synthetics report 0 meaning
  "not published". `volume_available` disambiguates. Averaging those zeros would drag a
  volume series toward zero.
- **`realtime` / `delay_est_s` are measured per row, never assumed.** CME/NYMEX/COMEX
  run ~10 min delayed on this account; TVC synthetics are real-time.
- **`realtime_drift`** means a symbol stopped matching its expected freshness. It is a
  health signal, not a market signal.

## Write path rules

- **Single-row `INSERT` via `/exec` only.** `/imp` bulk import is the current QuestDB
  crash trigger; there is deliberately no batch path in `src/world/questdb.js`.
- Host addressed as **`questdb.lan`**, never by IP.
- This service writes **`tv_world_quotes`** and staging rows into
  **`news_events_staging`**. It must never write or delete `trades`, `daily_ohlcv`,
  `regime_gate`, or `news_events*`.
- Sink is **disabled unless `--questdb` is passed**. It does not connect at construction.

## Outage spool

QuestDB is the only data interface. The local JSONL is a transient spool written **only**
when an insert fails, drained on reconnect with original timestamps (`replayed=true`),
and deleted once empty. `DEDUP UPSERT KEYS(ts, symbol)` makes replay idempotent, so a
partial drain that is retried cannot double-count. Nothing else may read it.

## Shock detector

Deterministic, no LLM. `src/world/detector.js`. Four guards, each of which exists
because a naive threshold misfires: **staleness** (a dead feed is never read as calm),
**min-samples** (a restart is not a shock), **hysteresis** (a market parked below the
line fires once, not every cycle), **cooldown**.

Starting thresholds — deliberately unvalidated, see *Open decisions*:

| Rule | Condition | Window |
|---|---|---|
| `us10y_yield_shock` | \|Δ yield\| ≥ 5bp | 15 min |
| `dxy_shock` | \|Δ\| ≥ 0.3% | 15 min |
| `gold_shock` | \|Δ\| ≥ 1.0% | 15 min |
| `es_session_drawdown` | session ≤ −1.5%, re-arm above −1.0% | level |
| `nq_session_drawdown` | session ≤ −1.5%, re-arm above −1.0% | level |

Events carry `advisory_only: true` and `machine_requires_review: true`, and ES/NQ events
carry a `freshness_warning` stating the condition may have begun ~10 min earlier.

## Measured cost

| | |
|---|---|
| Cycle time | **106.5 s** for 10 symbols (was 510 s before session opens were moved out of the hot loop) |
| Chart occupancy | ~100% — the daemon owns the chart cursor continuously |
| Session-open pass | once at startup, then every 6 h or on rollover |

## Host prerequisites (asus15) — audit 2026-08-18

| Setting | Value | Effect |
|---|---|---|
| `sleep-inactive-ac-timeout` | `0` | ✅ no idle suspend on AC |
| `sleep-inactive-battery-timeout` | `900` | ⚠️ **suspends after 15 min idle on battery** |
| `HandleLidSwitch` | `suspend` | ⚠️ **closing the lid kills the arm** |
| `IdleAction` | `ignore` | ✅ |
| Chassis | laptop | — |

Both warnings must be resolved before the arm is load-bearing, and both are changes to
karim's machine, so they are his to make:

```bash
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-timeout 0
sudo systemctl edit --force logind.conf   # or /etc/systemd/logind.conf: HandleLidSwitch=ignore
```

**Untested risk:** even with suspend disabled, Chromium throttles occluded/background
renderers. Whether the chart keeps updating with the lid shut or the screen locked has
**not** been verified, and it cannot be verified without disrupting karim's session.
Do this before trusting the arm overnight.

## Install (deliberate, not automatic)

```bash
cp deploy/tv-world-daemon.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tv-world-daemon
```

## Open decisions for karim

1. **Session ownership.** Does the arm own the TradingView login exclusively? If yes, he
   stops using TradingView on other devices while it runs. If no, the arm needs to
   tolerate being kicked off — which means either accepting gaps or allowing reconnect.
2. **Reconnect capability.** Self-healing requires re-admitting `ui_click` (narrowly
   scoped to the Connect button at minimum). That reopens part of the surface the
   allowlist closed. A middle path: keep the allowlist closed, detect disconnection via
   the integrity gate, and alert a human to reconnect.
3. **Threshold validation.** The five thresholds above are guesses. They should be
   back-tested against history before any study relies on them.
4. **ToS.** Continuous automation of a desktop client against a personal subscription,
   at ~850 symbol loads/day, is a heavier pattern than the earlier batch design. Not
   assessed here.
