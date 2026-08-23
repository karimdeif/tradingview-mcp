# Pre-registration: TV-EV-01 — replay-consistency validation of the SMA100 gate

Registered BEFORE any walk executes (2026-08-23). Feeds S-24/S-25 as
supporting evidence for the incumbent only — explicitly NOT a new strategy
candidate. To be mirrored into STUDY_REGISTRY.md by msi.

## Hypothesis

H1: The Strategy Tester's result for the per-symbol SMA100 gate contains no
lookahead — bar-sequential execution (TradingView bar replay, deciding from
data seen so far only) reproduces the tester's trades on the same window.

This is the honest claim replay can test: replay re-walks HISTORICAL bars, so
it validates the execution path (no full-series precompute artifacts), not new
data. The ~19–21%/yr in-sample position-return figure corroborating the live
basket remains the registered statistic of the completed 105-cell matrix; this
study defends it against the "tester lookahead" objection specifically.

## Fixed parameters

- Symbols (declared now, no substitutions): COMI, TMGH, ORAS, FWRY, ETEL —
  top-5 by the registered 60-session turnover screen, excluding the CLHO/SKPC
  twin pair by construction.
- Timeframe 1D; window 2024-01-02 → 2026-08-20 (clamped per symbol to
  available replay depth; actual clamp recorded per symbol).
- Rule: the exact "SMA100 Per-Symbol Approx (NOT the basket)" Pine source at
  branch commit 0245077 (100% equity, 0.10% commission, next-bar fills).
- Procedure per symbol: replay_start at window start → step bar-by-bar →
  apply the gate mechanically from seen bars only → record entries/exits →
  compare against the Strategy Tester's trade list for the same window
  (already stored in run-2026-08-23 cells).

## Pass / fail (binding, set now)

Per-symbol PASS requires: (a) ≥90% of tester trades in scope matched
one-to-one by a replay trade within ±1 bar on entry AND exit (greedy matching
in entry-time order; each trade matched at most once); (b) per-trade return
difference ≤0.5% absolute on matched trades; (c) ≤2 unmatched replay trades.

**Study verdict is decided solely by the symbol count: PASS iff ≥4 of the 5
symbols pass; otherwise FAIL.** (A single failing symbol does NOT fail the
study — pass-12 review caught the earlier wording contradicting this.)

Scope and measurement, fixed now:
- A trade is IN SCOPE iff its ENTRY bar falls inside the window; exits may
  extend past the window end (the recorded COMI baseline has boundary-crossing
  trades — those with pre-window entries are OUT of scope on both sides).
- The replay walker records its own trade list — entry/exit bar and per-trade
  return computed as exit_fill/entry_fill − 1 from the bar data it steps
  through. The replay API exposes no trade list; none is needed. The tester's
  side comes from the run-2026-08-23 cells' stored per-trade timestamps and
  profit_pct.

FAIL: the matrix's gate numbers are quarantined pending investigation, and
that is reported as loudly as a pass. **Investigation order is fixed now (msi registry addition): the replay
HARNESS is examined FIRST — a driving fault must not masquerade as a
lookahead finding about the tester.** Only a harness given a clean bill
escalates the question to the tester itself.

Registry: entered as DRAFT in the estate study registry (claude-mubasher
PR #213), with both gates explicit — karim's registration of the study AND
his separate GO for the replay run class.

## Cost & gating

~430 daily steps × 5 symbols ≈ 60–90 min serial on the live session. Runs
only after karim's explicit go — it is a new run class (replay driving).
