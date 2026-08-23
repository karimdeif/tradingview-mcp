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

PASS requires, per symbol: (a) ≥90% of tester trades inside the window
matched by a replay trade within ±1 bar on entry AND exit; (b) per-trade
return difference ≤0.5% absolute on matched trades; (c) ≤2 unmatched replay
trades. Study passes if ≥4 of 5 symbols pass.

FAIL (any symbol beyond those tolerances, or <4/5): the matrix's gate numbers
are quarantined pending a lookahead/replay-integrity investigation, and that
is reported as loudly as a pass.

## Cost & gating

~430 daily steps × 5 symbols ≈ 60–90 min serial on the live session. Runs
only after karim's explicit go — it is a new run class (replay driving).
