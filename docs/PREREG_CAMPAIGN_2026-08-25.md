# Pre-registration: campaign 2026-08-25/26 — discovery, registry, cyclicality

Karim's order (via the chief, 2026-08-25): find the best TradingView
strategies for EGX30/EGX70; lots of tests; a durable record of what worked and
what didn't; keep adding; NO overfitting; plus cyclicality and cross-asset
relationships. Window: Tue+Wed (Thu = EGX holiday). Everything below is frozen
BEFORE any cell runs; this commit is the freeze.

## Track A — round 1 candidates (all frozen; textbook defaults; long/flat)

10 canonical families in `research/strategies-canonical/` (CRLF-canonical
sha1s in `round1-digests.json`; roster in `round1-config.json`):
supertrend-10-3 · donchian-20-10 · donchian-55-20 · boll-revert-20-2 ·
rsi2-connors (SMA200 filter, RSI2<5, exit >SMA5) · macd-12-26-9 · tsmom-252 ·
golden-cross-50-200 · keltner-break-20-2 · psar-002-02. Conventions identical
to the validated baseline: decisions on [1], next-open fills, 0.10%/side,
100% equity, long/flat (EGX shorting impractical — declared universe-wide).

**Universe (44):** top-45 by `market_reference.avg_daily_cash` (latest ts)
minus KORA (50 bars): 36 deep-history names (≥1800 daily bars → full IS/OOS)
+ 8 post-2019 listings (auto-flagged by coverage; OOS-heavy by construction).
Timeframe 1D only in round 1. **440 cells**, strictly serial through the
existing validated matrix path (attested attach, fingerprint ownership with
the 44-symbol reference extension `pine-audit/data/ref_universe_2026-08-25.json`
via TV_REF_DATA, G1, inventory diffs).

**Scoring exactly as the tournament:** IS-only ranking at the 2022-01-01
split; headline = B&H-relative position-return edge/yr with denominators;
median across symbols; <30 trades median = INSUFFICIENT-EVIDENCE; bars =
per-cell B&H and the per-symbol SMA100 approximation (existing 20-cell run;
extended to the new symbols only if a round-2 rerun is separately approved).
Round 2 (Wed) may ADD families (same freeze discipline, new prereg section);
round-1 verdicts are never re-scored.

## Track B — persistent strategy registry (schema v1)

One JSONL record per (strategy, source-digest, universe, timeframe, window):

```json
{"registry_id":"<key>@<digest12>#<window>","date":"","family":"","title":"",
 "source_sha1_crlf":"","params":"frozen-published","universe":"egx-top44-2026-08-25",
 "timeframe":"1D","window":{"start":"","end":""},
 "cells":{"ok":0,"no_trades":0,"error":0},
 "metrics":{"median_net_pct":0,"win_frac":0,"med_is_edge_py":0,"n_is_edge":"x/y",
   "med_oos_edge_py":0,"n_oos_edge":"x/y","degradation":0,"med_raw_is_py":0,
   "med_raw_oos_py":0,"median_trades":0},
 "incumbent_bars":{"beat_bh_cell_frac":0,"note":"vs per-symbol SMA100 approx"},
 "coverage":{"min":"","max":""},"flags":[],"verdict":"",
 "rig":{"commit":"","tv_build":"","manifest":""},"run_dir":""}
```

Verdicts: **WORKS** (positive median IS edge, OOS edge not collapsed
[degradation ≥ 0 or OOS edge > 0], no disqualifying flags) / **FAILED** /
**INSUFFICIENT-EVIDENCE** / **OVERFIT-SUSPECT** / **UNRUNNABLE**. The
graveyard is the point: every candidate ever run gets a record, nulls
included — the ledger is the multiple-comparisons control. Records + a
REGISTRY.md leaderboard go to the chief for the PRIVATE claude-mubasher repo
(`research/tv-strategy-registry/`), never the public fork. QuestDB table:
proposal only, deferred.

## Track C — cyclicality & cross-asset (hypothesis families, ALL declared now)

Data: QuestDB dailies 2003→ for the 44 names (+ equal-weight deep-36 basket as
the long-history index proxy, declared here); TV EGX30 index + GOLD, UKOIL
(Brent), DXY, US10Y, EEM, USDEGP at 1D(14mo)/1W(5.7y)/1M(25y) — pulled before
the matrix window, `strategy-tournament/macro-series-2026-08-25.json`.
IS/OOS split 2022-01-01 everywhere. EVERY test in a family is reported,
nulls included. Effect sizes + block-bootstrap 95% CIs; a family "survives"
only if the IS effect keeps sign and ≥half its magnitude OOS.

- **F1 day-of-week:** mean next-day basket return by weekday (all 5 tested).
- **F2 month-of-year:** all 12 months tested on the 25y monthly index.
- **F3 Ramadan:** daily basket mean inside Ramadan vs outside (Hijri ranges
  2005–2026 tabulated in the analysis script); declared direction POSITIVE
  (documented Muslim-market anomaly). ±5-day Eid windows reported alongside.
- **F4 turn-of-month:** days −1..+3 vs rest; declared direction POSITIVE.
- **F5 cross-asset lead-lag, weekly non-overlapping, lag 1w, directions
  declared:** Brent→EGX30 POSITIVE (GCC-liquidity channel) · GOLD→EGX30
  NEGATIVE (risk-off) · DXY→EGX30 NEGATIVE · EEM→EGX30 POSITIVE ·
  ΔUS10Y→EGX30 NEGATIVE · ΔUSDEGP→EGX30(EGP) monthly NEGATIVE (managed-float
  caveat flagged). Pearson + Spearman both reported; sign agreement required.
- **F6 autocorrelation:** basket weekly AR(1); 12-month momentum decile spread
  (deep-36, monthly rebalance, IS deciles → OOS spread).

Anything surviving F1–F6 becomes a REGISTERED CANDIDATE for a future strategy
round — never a same-day strategy.

## Standing constraints (unchanged)

One-session law with run windows flagged to the chief; draft-only writes +
saved-scripts inventory checks; replay walker stays PAUSED; codex sol-max on
new rig code (this round's rig diff: TV_REF_DATA override + --config roster —
under review before launch); §8 veto-only; nothing touches the trading path.
