# Anti-overfitting protocol — EGX strategy tournament

Karim's directive (2026-08-23): "most important thing is no overfitting. Be
very careful overfitting." This document is the binding protocol for the
tournament and its report; the harness enforces what it can mechanically.

## The overfitting risks in THIS tournament, honestly stated

We are not fitting parameters — every strategy runs exactly as published, one
run per (strategy, symbol). That kills the classic risk. What remains:

1. **Selection bias.** Picking the best of 8 strategies × up to 20 symbols is
   itself a fit: with ~105 cells, something will look great by luck.
2. **Survivor symbols.** The 20-name set contains today's liquid survivors —
   every backtest on it inherits survivorship shine. This cannot be fixed in
   TV; it is stated on the report's first page.
3. **Deep-history seduction.** 20 years of daily data includes regimes (2004-08
   boom, 2011, 2016 float, 2020, 2023-26) that no longer exist. A strategy
   whose profit is one regime is not "good", it is lucky-once.

## The protocol

**P1 — Parameters are frozen.** Published defaults only. No sweeps, no tuning,
no "just try length=90". (The one disclosed source patch — WKOL's
signals-only toggle — enables order emission; it changes no logic parameter.)

**P2 — Selection on in-sample, validation on out-of-sample.** Every cell
stores its full round-trip trade list (entry/exit epoch-ms + P&L). The report
splits at **2022-01-01**:
  - IS = trades exiting before the split (≈2003–2021, multiple regimes),
  - OOS = trades exiting after (≈2022–2026, includes the 2023–26 bull run and
    the float-devaluation shocks).
Ranking happens on IS. The OOS column then answers "did the ranking survive
data the ranker never saw". The **degradation ratio** (OOS avg-trade / IS
avg-trade) is a headline column; a great IS row that collapses OOS is
labelled OVERFIT-SUSPECT, not celebrated.

**P3 — Breadth over peaks.** Per-strategy score = MEDIAN across symbols +
fraction of symbols profitable, never the best cell. A strategy that only
works on one symbol is a fitted anecdote (ABUK's row is the honest extreme:
its source hard-locks to one symbol and is reported as such, not ranked
against breadth strategies).

**P4 — Minimum evidence.** A cell with < 30 round trips carries an
INSUFFICIENT-EVIDENCE flag; a strategy whose median cell is under-evidenced
is not rankable. Intraday cells state their real coverage window — EGX
intraday history is shallow and a 3-week sample proves nothing.

**P5 — Beat something that matters.** Comparisons are against (a) buy & hold
per cell, (b) the per-symbol SMA100 approximation through the identical
path, and (c) the live incumbent row (labelled: live-clock numbers, not a
backtest). "Positive" is not the bar; "better than what we already run,
out-of-sample, across symbols" is.

**P6 — Costs stay real.** Declared commissions kept; strategies declaring
slippage=0 on intraday timeframes get a SLIPPAGE-OPTIMISTIC flag (EGX
intraday spreads are not zero).

**P7 — One shot.** The matrix runs once per manifest. If a strategy is edited
after seeing results, its next run is a NEW strategy (new source digest, new
manifest) and its previous OOS window is burned — noted in the report so
nobody quietly iterates against the validation set.

## What TradingView premium is actually best at, in this design

- **Deep server-side history** (2001→ daily) — the IS window's regimes.
- **TV's own execution engine** as the arbiter of fills/commissions — plus the
  independent JS engine (pine-audit) as the G4 cross-check where both exist.
- **Bar replay** (later, §candidates): the surviving 1–2 strategies get a
  replay-driven forward-walk on bars the Strategy Tester run never displayed —
  a cheap second OOS. Not part of this run.
