# Futures recon via `tradingview-mcp` — what works, what it gives us, what it can't

**Machine:** asus15 (192.168.0.6 / tailnet 100.93.111.7)
**Date:** 2026-08-18, probes run 07:00–07:12 UTC (10:00–10:12 Cairo) — well inside the pre-13:35 window
**Repo:** `karimdeif/tradingview-mcp` @ `8759f80`
**App:** TradingView Desktop 2.14.0 (Electron 38.2.2), relaunched with `--remote-debugging-port=9222`
**Scope:** recon only. Nothing estate-side was touched. **The integration section is a proposal, not an implementation.**

---

## 1. Headline

**Futures data flows, and it is good data — but it is delayed 10 minutes.**
TradingView's own synthetic symbols (`TVC:*`) are real-time; the actual exchange futures (CME/NYMEX/COMEX) are on a ~10-minute delayed feed. That single fact should shape how this gets used: it is fine for pre-open regime context, and unusable for anything reacting inside a 10-minute window.

All 7 priority symbols resolve and return clean OHLCV. Read latency once parked on a symbol is **2–7 ms**. The expensive operation is *switching* symbols (~10.7 s), which sets the real cadence ceiling.

## 2. Security posture actually in force

The `.mcp.json` written at `/home/karim/claude-a15-20260818/.mcp.json` registers the server with `TV_MCP_TOOL_ALLOWLIST=readonly`. Server stderr on every start:

```
TV_MCP_TOOL_ALLOWLIST active: 9 tool(s) registered, 75 withheld.
Registered: tv_health_check, chart_get_state, chart_set_symbol, chart_set_timeframe,
            symbol_info, symbol_search, data_get_ohlcv, quote_get, capture_screenshot
```

Enforcement verified by calling the withheld tools, not by inspection:

```
ui_evaluate  -> MCP error -32602: Tool ui_evaluate not found
alert_create -> MCP error -32602: Tool alert_create not found
```

They are not refused at call time — they do not exist in this process. Every probe below went through that 9-tool surface.

**Port binding** (the check that mattered most):

```
LISTEN 0 10  127.0.0.1:9222  users:(("tradingview",pid=40055,fd=71))
  192.168.0.6:9222   refused/unreachable  OK
  100.93.111.7:9222  refused/unreachable  OK
  127.0.0.1:9222  -> HTTP 200
```

Loopback only. Not reachable from the LAN or the tailnet.

**Sign-in survived the restart** — no re-login, saved layout `zO77jkqA` and the `WKOL 3m VWAP Reversion (B) — Min-Gap Guard` study both intact.

## 3. Symbol resolution — one real gotcha

`symbol_search` returns `full_name` values that **do not work as continuous-contract tickers**. It offered `CME:ES` for the E-mini; `CME:ES1!` sets the chart successfully (`success: true`) but then every read fails with *"Could not retrieve quote. The chart may still be loading"* — indefinitely. The working ticker is `CME_MINI:ES1!`.

This is a silent failure mode: `chart_set_symbol` reports success on a symbol that will never produce data. **Any integration must validate that a quote actually returns, not that the symbol was set.**

| Wanted | Working ticker | Type | Verified last |
|---|---|---|---|
| ES1! | `CME_MINI:ES1!` | futures | 7737.75 |
| NQ1! | `CME_MINI:NQ1!` | futures | 29871.75 |
| DXY | `TVC:DXY` | index | 99.642 |
| BZ1! | `NYMEX:BZ1!` | futures | 91.47 |
| CL1! | `NYMEX:CL1!` | futures | 84.52 |
| GC1! | `COMEX:GC1!` | futures | 4454.1 |
| US10Y | `TVC:US10Y` | bond | 4.74 |

Non-working: `CME:ES1!`, `CME:NQ1!` (wrong exchange prefix for the mini contracts).

## 4. Fields available

`quote_get` returns exactly:

```
success, symbol, time, open, high, low, close, last, volume, description, exchange, type
```

Notes that matter:
- `time` is the **open timestamp of the current in-progress bar**, at the chart's active timeframe — not a tick time. On a 1D chart it is the session open. This is the handle used for the delay measurement in §6.
- `close` and `last` are identical on an in-progress bar.
- `volume` is contract volume and increments live within the bar (observed 634 → 664 → 675, resetting to 1 on rollover). It is `0` for all `TVC:*` synthetics — they carry no volume.
- No bid/ask, no open interest, no settlement. `depth_get` (order book) exists upstream but is **not** in the read-only allowlist.

`data_get_ohlcv` with `summary: true` returns `bar_count`, `period{from,to}`, `open/high/low/close`, `range`, `change`, `change_pct`, `avg_volume`, and `last_5_bars[]`.

## 5. Snapshot vs streaming

**Snapshot polling only.** There is no push path through the MCP surface. The repo does ship `src/core/stream.js` with a `pollLoop` (quote/bars/values/lines/labels/tables), but it is a CLI feature, not an MCP tool — and it is internally a poller too, not a subscription. Nothing here delivers events.

Practical consequence: we poll, and each poll reads whatever the chart has already rendered. Reads are essentially free (2–7 ms) because they are reading the in-memory series; the cost is entirely in getting the chart onto the symbol.

## 6. ⚠ The delay finding

Measured by comparing wall clock to the in-progress **1-minute** bar's open stamp, so one bar-width (60 s) is expected and anything beyond that is feed delay:

| Symbol | lag | beyond bar width | verdict |
|---|---|---|---|
| `CME_MINI:ES1!` | 657 s | 597 s | **delayed ~10 min** |
| `NYMEX:CL1!` | 614 s | 554 s | **delayed ~9 min** |
| `COMEX:GC1!` | 632 s | 572 s | **delayed ~10 min** |
| `TVC:DXY` | 49 s | 0 s | **real-time** |
| `TVC:US10Y` | 66 s | 6 s | **real-time** |

The account has no CME/NYMEX/COMEX real-time entitlement. TradingView's own synthetic feeds are unrestricted.

**Real-time alternatives that cover the same macro ground, 24h:**

| Symbol | lag | covers |
|---|---|---|
| `TVC:USOIL` | 16 s | WTI crude — real-time stand-in for `CL1!` |
| `TVC:UKOIL` | 33 s | Brent — real-time stand-in for `BZ1!` |
| `TVC:GOLD` | 59 s | spot gold — real-time stand-in for `GC1!` |
| `TVC:DXY` | 49 s | dollar index |
| `TVC:US10Y` | 66 s | 10Y yield |

**There is no real-time free equivalent for the equity-index futures.** `TVC:SPX` and `TVC:NDQ` are *cash* indices — their last bars stamp to 2026-08-17 20:03 and 19:58 UTC, i.e. the 16:00 ET cash close, while the probe ran at 03:09 ET. They are **closed, not delayed**, and they do not move overnight. So for the "markets ahead of us" equity signal specifically, the choice is `CME_MINI:ES1!`/`NQ1!` at 10 minutes stale, or nothing.

For a pre-EGX-open read at ~09:30 Cairo, a 10-minute-old overnight futures print is materially the same information as a live one. The delay only bites intraday.

## 7. Historical bars

Default 100 bars; `count` is honoured up to an observed ceiling of **300** (requested 1000 → returned 300). Note the repo's own `CLAUDE.md` claims a 500-bar cap — not what this build does, at least not with only 300 bars loaded into the chart.

Span at 100 bars, `CME_MINI:ES1!`:

| TF | bars | span | window |
|---|---|---|---|
| 1 | 100 | 0.1 d | 05:16 → 06:55 same day |
| 5 | 100 | 0.3 d | prior 22:40 → 06:55 |
| 15 | 100 | 1.1 d | 1 day back |
| 60 | 100 | 6.3 d | ~1 week |
| 240 | 100 | 24.5 d | ~3.5 weeks |
| 1D | 100 | 144 d | 2026-03-26 → 2026-08-17 |
| 1W | 100 | 693 d | 2024-09-22 → 2026-08-16 |

So ~2 years of weekly, ~5 months of daily per fetch, extendable to 300 bars. Adequate for regime context; **not** a bulk historical backfill source — and we would not want it to be, given the QuestDB import rule.

## 8. Latency and a polite cadence

| Operation | Cost |
|---|---|
| `chart_set_symbol` + settle | **~10.7 s** |
| `chart_set_timeframe` + settle | ~4 s |
| `quote_get` | **2–7 ms** |
| `data_get_ohlcv` (summary) | **2–3 ms** |

The symbol switch dominates completely. A full 7-symbol sweep costs **~90–95 s**, essentially all of it chart loading.

Proposed cadence: **one sweep every 15 minutes**, and never faster than every 5. Rationale — the futures leg is 10 minutes stale anyway, so sub-10-minute polling buys nothing on 5 of 7 symbols; and each sweep drives 7 real symbol loads against TradingView's servers through karim's own session. Fifteen minutes is ~96 sweeps/day, which is unremarkable for a desktop client a human might drive by hand.

Do **not** use `quote_get`'s optional `symbol` parameter in a loop: it switches the chart and restores it, paying the ~10.7 s twice and serialising against any parallel call.

## 9. Limitations, honestly stated

1. **10-minute delay on all real exchange futures.** The central constraint.
2. **No real-time overnight equity-index option** (§6).
3. **The chart is a single global cursor.** One symbol at a time; every read is "whatever the chart is currently showing." Two things driving this concurrently will corrupt each other. Needs a mutex if anything else ever touches it.
4. **Reads mutate visible state.** Sweeping flips karim's chart through 7 symbols. His view was restored to as-found here, but any scheduled job would leave the chart wherever it finished. Worth a dedicated layout or tab if this becomes routine.
5. **Depends on a GUI app staying logged in and running.** A restart, a session expiry, or a TradingView internals change breaks it. `api_available` in `tv_health_check` is the canary.
6. **Silent-success failure mode** on bad tickers (§3) — must validate on quote, not on set.
7. **ToS.** This automates a desktop client against karim's personal subscription. Fine for personal decision support; redistributing or republishing the data is a different question and I have not assessed it.
8. **No bid/ask, no OI, no settlement** through the read-only surface.

## 10. Proposed integration path — PROPOSAL ONLY, NOT BUILT

Nothing below was implemented. No estate host was contacted, no QuestDB connection opened, nothing written anywhere but this machine.

**Shape:** a collector on asus15 — *not* on ts-17, ts-15, or legion — running a 15-minute sweep, writing JSONL rows to local disk in the estate's news/GMS staging shape:

```
{ts_utc, symbol, tv_symbol, last, open, high, low, close, volume,
 bar_ts, timeframe, feed_lag_s, realtime: bool, source: "tradingview-mcp"}
```

`feed_lag_s` and `realtime` are carried **per row**, not assumed — a consumer must be able to tell a real-time `TVC:DXY` print from a 10-minute-old `ES1!` print without knowing the symbol taxonomy.

**Staging, then promotion.** Rows land as files. Promotion into QuestDB happens later, through msi + the normal review process, via whatever the sanctioned insert path is — explicitly **not** a bulk HTTP import, which is the current crash trigger.

**Observe-only under §8.** World context may **veto or reduce** a buy; it may never add or accelerate one. This feed is well suited to that asymmetry: a stale-by-10-minutes risk-off signal is still a valid reason to stand down, whereas the same staleness makes it unfit to justify entering. I'd propose the §8 wiring be explicitly one-directional in code, not by convention.

**Suggested first increment**, if this proceeds: run the collector for a week writing only to local JSONL, and compare its overnight signal against what the 17:00 gate already concluded. That tells us whether the futures leg adds anything before any estate surface is touched at all.

**Open questions for karim:**
- Is a paid CME real-time add-on worth it, or is 10-minute delay acceptable given this is pre-open context? (I'd argue acceptable — see §6.)
- Should the collector use a dedicated TradingView layout/tab so sweeps don't disturb his working chart?
- Does the §8 law want the real-time `TVC:*` legs and the delayed futures legs weighted differently?

## 11. What was deliberately not done

- No estate host contacted — ts-17, ts-15/questdb.lan, legion all untouched.
- No QuestDB connection of any kind.
- No writes to karim's TradingView cloud account. The alert/watchlist/Pine writers were never registered, so this is enforced rather than promised.
- No broker or order action. There is no broker linked to the account, and the UI-driver tools are withheld.
- No integration code written.
- Chart restored to as-found: `TVC:USOIL`, 1D, WKOL study present.

## Appendix — reproducing this

Driver: `/home/karim/claude-a15-20260818/tv-client.mjs` — a minimal MCP stdio client that spawns the registered server with `TV_MCP_TOOL_ALLOWLIST=readonly`, so any reuse inherits the same enforced surface.

Evidence screenshot: `tradingview-mcp/screenshots/tv_chart_2026-08-18T07-11-49-625Z.png`.

One incidental observation from it: TVC CFD symbols render SELL/BUY widgets in the chart header (84.13 / 84.14 on USOIL). They are inert without a linked broker, and the tools that could click them are withheld — but it is a visible reminder that this app has an order surface one broker-link away.
