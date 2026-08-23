# Plan: driving TradingView's Strategy Tester from the MCP arm

Status: **PLAN ONLY — nothing built, nothing run.** Written 2026-08-23 on asus15.
Requested by the `msi-fable5` peer session on karim's behalf ("really make use of
TradingView and running strategies and backtests").

Every claim below marked *(verified)* was checked on this box today. Claims from
the incoming brief that turned out to be wrong are corrected in §0 — read that
first, because two of them change the shape of the work.

---

## 0. Ground truth (verified today, 2026-08-23)

**0.1 CDP is up.** *(verified)* `curl http://127.0.0.1:9222/json/version` →
TradingView/2.14.0, Electron 38.2.2, Chrome 140. Single browser target.

**0.2 The corpus is local, and it is 7 strategies, not 12.** *(verified)*
The `.pine` sources are already on this box at
`~/claude-a15-20260818/pine-audit/sources/` — no GitHub fetch needed. There are
12 files, but only **7 carry a `strategy()` declaration** and can be backtested
at all:

| backtestable | file | pine |
|---|---|---|
| ✅ | `ABUK_1m_Long_Only_SMA_70_250_.pine` | v6 |
| ✅ | `Conservative_Structure-Based_Long_Strategy.pine` | v6 |
| ✅ | `EGX_Pro_Stack_Strategy_No_Look_Ahead_.pine` | v6 |
| ✅ | `EMA20_SMA50_SMA200_Cross.pine` | v6 |
| ✅ | `ORHD-VWAP_Bounce_..._filter_.pine` | v6 |
| ✅ | `ORHD-VWAP_Bounce_..._filter_copy.pine` | v6 |
| ✅ | `WKOL_3m_VWAP_Reversion_B_.pine` | v5 |
| ❌ indicator | `egx-30-screener.pine` | v5 |
| ❌ indicator | `EGX_MA_Cross_Watchlist_20_50_200_RSI_Action.pine` | v6 |
| ❌ indicator | `EGX_rVol_5D_VWAP_Entry_Helper.pine` | v6 |
| ❌ indicator | `PDH_PDL.pine` | v6 |
| ❌ **no declaration at all** | `egx-gaines-losers.pine` | v5 |

The two `ORHD-…` files are **not** duplicates *(verified: 320-line diff)* — the
`copy` is a materially different variant. So the matrix is 7 rows, and the four
indicators need a decision (§6, open question OQ-1) rather than a backtest.

**0.3 This has been attempted before, and the attempt documented why it failed.**
*(verified)* `~/claude-a15-20260818/pine-audit/backtest.mjs` (184 lines, with
`backtest-output.txt` results for Golden Cross and EGX Pro Stack across 20 EGX
symbols) **deliberately abandoned the Strategy Tester** and re-implemented each
rule in JavaScript over QuestDB `daily_ohlcv`. Its header states the reason
verbatim:

> `pine_smart_compile` clicks the editor's Save button rather than "Add to
> chart" in this build (it reports `study_added:false` while still returning
> `success:true`), so the strategy never attaches and
> `data_get_strategy_results` silently returns whatever other strategy is on
> the chart.

That is the exact failure mode in [[success-claims-by-failed-code]]. It is also
**the one real blocker**, and it is a ~15-line fix (§2).

**0.4 The blocker is still present in the code.** *(verified)*
`src/core/pine.js:290` and `:452` both scan `document.querySelectorAll('button')`
only. In TV Desktop 2.14.0 the "Add to chart" control is a `<span>`, so the scan
misses it, falls through to `saveBtn`, clicks **Save** — which persists to
karim's TradingView cloud account — and returns `success: true`.

**0.5 Deliverable (b) is ~90% already built.** *(verified)* `src/core/data.js`
already reads TradingView's internal report API, not the DOM:

- `ensureStrategyTesterReady()` (`data.js:216`) auto-opens the panel, auto-unhides
  hidden strategies (TV never computes a report for a hidden strategy), and polls
  for `reportData` to populate.
- `findStrategy()` (`data.js:50`) prefers the strategy whose report is *actually
  computed*, and returns `strategy_count` — so multi-strategy contamination is
  at least detectable.
- `data_get_strategy_results` already returns everything asked for and more:
  `net_profit_percent`, `max_drawdown_percent`, `total_trades`,
  `percent_profitable`, `profit_factor`, `sharpe_ratio`, `sortino_ratio`,
  `buy_hold_return`, `commission_paid`, plus `strategy` (the name) and `currency`.
- `data_get_trades` and `data_get_equity` exist alongside it.

So this plan is **not** "build a Strategy Tester integration". It is: fix one
button lookup, add one teardown tool, add a per-cycle integrity gate, and write
a harness. That is the honest scope.

---

## 1. Objective and success criterion

Produce one comparison report over the 7 tournament strategies against the
SMA100-gate baseline, where **every number is either corroborated by a second
independent engine or explicitly flagged as uncorroborated.**

The second engine already exists: `pine-audit/backtest.mjs`. TradingView's
Strategy Tester and the JS re-implementation are independent computations of the
same published rules. Where they agree, the number is trustworthy. Where they
diverge, that divergence is itself the finding (fill timing, corporate-action
adjustment, bar-count depth) and gets reported, not averaged away.

This is the design answer to [[success-claims-by-failed-code]]: we do not accept
a `success: true` from the component that would be lying.

---

## 2. (a) Loading a `.pine` strategy onto the chart

**Flow, per strategy:** clear chart → set symbol → set timeframe →
`pine_set_source` (editor buffer) → **`pine_add_to_chart`** (new) → verify one
strategy attached and its name matches → read report.

**The one new tool — `pine_add_to_chart`.** Takes **no selectors and no DOM
hints**. Signature is `{ expect_name?: string }` — a *content assertion*, not a
locator. Its own code:

1. Snapshots `chart.getAllStudies().length` before.
2. Scans **all elements** for an exact text match on `Add to chart` /
   `Update on chart` / `Save and add to chart`, case-insensitive, trimmed —
   node type irrelevant, which is what fixes 0.4. Requires `offsetParent !== null`
   so an invisible control is never clicked.
3. Explicitly **refuses to fall back to the Save button.** If no add control is
   found it returns `success: false`. Never persisting to karim's cloud scripts
   is a hard property, not a preference.
4. Re-reads the study list after, and returns `success` only if the count
   increased **and** the new study's name is a strategy **and**, when
   `expect_name` was supplied, it matches. Count-delta plus name is verification
   at a level the button-lookup bug cannot reach.
5. Captures a `chart` screenshot before and after and returns both paths
   (karim's vision law, §5).

**Why this is not `ui_click` renamed** — the codex review question. The caller
cannot express *what* is clicked. There is no selector, no coordinate, no index,
no text parameter. The target is defined inside the tool by a fixed literal set
of three strings, and the click is only accepted if an independent post-condition
(study count + study name) confirms the intended effect. `expect_name` can only
make the tool *stricter*; it can never redirect it at a different control.

**Second new tool — `chart_clear_studies`.** No arguments at all. Removes every
study from the chart so each run starts from exactly one strategy. Needed because
`findStrategy()` picks *a* strategy with a computed report — with leftovers from a
prior run it will happily read the wrong one and return `success: true`. Returns
the before/after counts and the names removed.

That is **two** new tools. Nothing else is required.

---

## 3. (b) Driving the tester and extracting results

Use the existing `data_get_strategy_results` / `data_get_trades` /
`data_get_equity`. No new extraction tool. The harness adds three assertions that
those tools do not make for us:

- **A1 — right strategy.** `results.strategy` must equal the name we just
  attached. Guards the 0.3 failure directly.
- **A2 — sole strategy.** `strategy_count` must be 1. Otherwise fail the run.
- **A3 — real coverage window.** Record the first and last trade timestamps from
  `data_get_trades`. Without this, a 20-year daily backtest and a 3-week 5m
  backtest land in the same table looking comparable. Three of the seven
  strategies are intraday (ABUK 1m, WKOL 3m, ORHD 5m) and EGX intraday history is
  shallow — the coverage window is a headline column, not a footnote.

Note *(verified, per [[tradingview-mcp-gotchas]])*: the Strategy Tester computes
over the **full server-side feed**, not the ~300 lazily-loaded chart bars. The
300-bar ceiling applies to reading bars, not to backtesting — which is precisely
why this path is worth the work versus the QuestDB re-implementation.

---

## 4. (c) The harness

`scripts/backtest-tournament.mjs` — a plain node script **outside** the MCP
server, driving the existing CLI. It is a client; it gets no privileges.

- **Matrix:** 7 strategies × agreed symbols × the strategy's own native
  timeframe. Timeframe is a property of the strategy (ABUK is a 1m system), not
  a free axis — sweeping ABUK on daily bars produces numbers that mean nothing.
- **Baseline:** SMA100-gate, run through the identical path so it is comparable
  by construction.
- **Strictly serial.** One CDP client, one chart, no parallelism —
  [[tradingview-arm-constraints]] law 1.
- **Resumable.** One JSON per (strategy, symbol) written as it completes, so an
  aborted run loses one cell, not the sweep.
- **Output:** one markdown comparison report + the raw JSONs, with a
  side-by-side column against `pine-audit/backtest-output.txt` where the strategy
  exists in both.

**Cost note:** the full matrix is the expensive part. It is Phase 3 in §7 and
does not start without karim's explicit word.

---

## 5. Integrity gate (karim's vision law + the 08-18 near-miss)

Per-cycle, judged across the symbol set — never per-row, because every 08-18
row was individually well-formed:

- **G1 — no cloned result sets.** If two different symbols return identical
  `net_profit_percent` + `total_trades` + `max_drawdown_percent`, fail the whole
  cycle. This is the direct analogue of the all-symbols-same-price near-miss.
- **G2 — screenshots before and after every attach and every report read**,
  saved to disk and **inspected**, not just captured. A re-login or disconnect
  modal aborts the sweep and alerts. It is never clicked through — recovery
  needs karim, per [[tradingview-arm-constraints]] law 1.
- **G3 — no silent zeroes.** A strategy that returns 0 trades is reported as
  `NO_TRADES` with its coverage window, never as a 0% return in the table.
  Absence must be loud.
- **G4 — cross-engine check.** Divergence beyond a stated tolerance against
  `backtest.mjs` is flagged in the report, not smoothed.

---

## 6. (d) Security shape

**Two independent gates.** The new tools register only when
`TV_MCP_ALLOW_SCOPED_WRITERS=1` **and** the allowlist names them. Either one
missing → the tools do not exist in `tools/list` at all
(`applyAllowlist` gates at registration, `src/allowlist.js`).

**New preset `backtest`** = `READONLY_TOOLS` + exactly:
`pine_set_source`, `pine_add_to_chart` (new), `chart_clear_studies` (new),
`data_get_strategy_results`, `data_get_trades`, `data_get_equity`.

**The `readonly` and `harvest` presets are untouched.** The world-context daemon
keeps running on `readonly` exactly as today.

**Still withheld, deliberately:** `ui_evaluate` (arbitrary JS in the
authenticated page), `ui_click` and every other `ui_*`, **`pine_save`** (never
persist to karim's cloud scripts), `alert_*`, all watchlist writers,
`draw_shape`/`draw_clear`, `batch_run`, `tv_launch`, `tv_update`, and
`ui_open_panel`'s `trading` target. **No broker linking, ever** — nothing in this
set can reach an order path, and signals stay §8 veto-only.

**OQ-2 (blocking, cheap):** confirm by reading `src/core/pine.js` that
`pine_set_source` writes only the editor buffer and does not persist to the cloud
script. If it persists, it is replaced by a buffer-only variant before anything
ships. Nothing in this plan may write to karim's TradingView account.

**Review:** codex `gpt-5.6-sol` max effort before merge, squash-only,
`codex exec … < /dev/null`. The review question I am putting to it explicitly:
*"does `pine_add_to_chart` let a caller choose what gets clicked?"*

**Tests** (mirroring the existing `chart_indicator` / `pine_analyze` style):
`allowlist.test.js` extended for the `backtest` preset and the double gate; a new
`strategy_backtest.test.js` covering the span-vs-button lookup, the
never-fall-back-to-Save property, A1/A2/A3, and G1 with a cloned-results fixture
— one named regression test per past incident.

---

## 7. Phasing and cost

Karim's standing hold ([[standing-hold-no-autonomous-runs]]) is in force: paid
credits until Sunday, nothing runs without his word. A peer session's request is
not that word.

| phase | what | cost | gate |
|---|---|---|---|
| 0 | this plan | done, free | — |
| 1 | 2 tools + preset + tests, no chart touched | small | karim |
| 2 | pilot: 1 strategy × 1 symbol, end to end, screenshots inspected | small | karim |
| 3 | full matrix + report | **the expensive one** | karim, explicitly |

Phase 2 is the real proof. If the pilot cannot attach one strategy and read back
its own name, phase 3 is worthless — and the honest fallback is the one already
sitting in `pine-audit/`.

---

## 8. Open questions for karim

- **OQ-1** — the 4 indicators (+1 undeclared) in the corpus: convert to
  strategies, or drop them from the tournament and report them as
  screening/context tools only? Converting means writing entry/exit rules that
  karim never wrote, which would be my invention presented as his strategy. My
  recommendation: **drop them from the backtest**, list them separately.
- **OQ-2** — see §6; I resolve this myself in phase 1 by reading the code.
- **OQ-3** — which symbols? `backtest-output.txt` used 20 EGX names; the intraday
  strategies need liquid ones with real 1m/5m depth. Suggest the 20-name daily
  set for the daily strategies and a liquidity-screened subset for intraday.
- **OQ-4** — the two `ORHD` variants differ in presets and window toggles. Run
  both as separate rows (my assumption), or is one superseded?
