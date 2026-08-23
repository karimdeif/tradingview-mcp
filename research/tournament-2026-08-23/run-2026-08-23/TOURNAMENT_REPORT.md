# EGX Strategy Tournament — comparison report

Run: `/home/karim/claude-a15-20260818/strategy-tournament/run-2026-08-23` · 105 cells · validator: **QUALIFIED** (warnings: V7 baseline-sma100/EGX:HRHO: TV B&H 10023% vs raw ref 1689% (ratio 5.66) — corroborate ownership; V7 baseline-sma100/EGX:MFPC: TV B&H 806% vs raw ref -1% (ratio 9.18) — corroborate ownership; V7 baseline-sma100/EGX:ORWE: TV B&H 3724% vs raw ref 703% (ratio 4.76) — corroborate ownership; V7 baseline-sma100/EGX:SKPC: TV B&H 71% vs raw ref 1201% (ratio 0.13) — corroborate ownership; V7 baseline-sma100/EGX:TMGH: TV B&H 3045% vs raw ref 637% (ratio 4.26) — corroborate ownership; V7 conservative/EGX:MFPC: TV B&H 486% vs raw ref -1% (ratio 5.94) — corroborate ownership; V7 conservative/EGX:ORWE: TV B&H 3321% vs raw ref 703% (ratio 4.26) — corroborate ownership; V7 conservative/EGX:SKPC: TV B&H 119% vs raw ref 1201% (ratio 0.17) — corroborate ownership; V7 golden-cross/EGX:HRHO: TV B&H 7211% vs raw ref 1689% (ratio 4.09) — corroborate ownership; V7 golden-cross/EGX:MFPC: TV B&H 607% vs raw ref -1% (ratio 7.17) — corroborate ownership; V7 golden-cross/EGX:ORWE: TV B&H 3321% vs raw ref 703% (ratio 4.26) — corroborate ownership; V7 golden-cross/EGX:SKPC: TV B&H 66% vs raw ref 1201% (ratio 0.13) — corroborate ownership; V7 pro-stack/EGX:JUFO: TV B&H 250% vs raw ref 3461% (ratio 0.10) — corroborate ownership; V7 pro-stack/EGX:MFPC: TV B&H 838% vs raw ref -1% (ratio 9.51) — corroborate ownership; V7 pro-stack/EGX:SKPC: TV B&H 53% vs raw ref 1201% (ratio 0.12) — corroborate ownership; V8 mixed provenance: 058a8e3a4460×85, 4bb203a21620×20 (run-manifest 4bb203a21620) — segments ran under DIFFERENT guard stacks; disclose per-segment guarantees. Inventory snapshots cover only the LAST segment; earlier segments' own runs each reported inventory unchanged in their logs.)

**Provenance (disclosed per protocol):** the validator returned QUALIFIED — cells were not all produced under the run manifest's harness version, so guard stacks differ per segment:
- manifest `058a8e3a4460`: 85 cells — EARLIER harness; qualified post-hoc by V1–V5 plus the in-run guards that version carried (see git history for that manifest's guard set)
- manifest `4bb203a21620`: 20 cells — CURRENT harness (full in-run guard stack)
- run-manifest: `4bb203a21620`. Inventory snapshots cover only the final segment; earlier segments' own run logs each reported the inventory unchanged.

## Page 1 — the incumbent, and the honest caveats

| row | Sharpe | return/yr | max DD | basis |
|---|---|---|---|---|
| **Incumbent: SMA100-gate N=80 basket (LIVE)** | ≈1.14 | ≈19%/yr | ≈−33% | live-clock numbers, NOT a backtest |
| Per-symbol SMA100 approx (backtest, NOT the basket) | — | median net 766.47% (full period) | — | identical TV path as every row below |

- Live-clock and backtest numbers answer different questions; never compare them cell-to-cell.
- The 20-name symbol set is today's liquid survivors — every backtest here inherits survivorship shine.
- **The OOS window (2022→) is a single macro-regime** (float shocks → 2024-26 bull): survival is necessary evidence, not sufficient. The genuinely unseen test is the bar-replay forward-walk for the finalists.
- Headline degradation is **B&H-relative per year**: per-trade POSITION returns (sizing-independent) minus window B&H, per year; raw position-return/yr sits beside it. Metric v2 — v1 compared portfolio-sized returns to fully-invested B&H, a unit mismatch fixed before any ranking was consumed (v1 preserved in git history). Parameters were never tuned (P1); ranking uses IS only (P2); scores are medians across symbols (P3).

## Ranking — daily breadth strategies (by median IS edge vs B&H, %/yr)

| rank | strategy | cells OK | median net (full) | win frac | IS edge/yr (n) | OOS edge/yr (n) | degradation | raw IS/yr | raw OOS/yr | median trades | coverage | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | baseline-sma100 | 20/20 | 766.47% | 100% | 9.02 (12/20) | -56.70 (20/20) | -6.29 | 20.57 | 45.22 | 98 | 2001-10-09 → 2026-08-23 | SPARSE-EDGE-SUBSET OVERFIT-SUSPECT |
| — | conservative | 20/20 | 0.43% | 70% | 1.37 (12/20) | -95.02 (20/20) | -69.51 | 0.09 | 0.55 | 12 | 2001-07-29 → 2026-08-20 | INSUFFICIENT-EVIDENCE SPARSE-EDGE-SUBSET OVERFIT-SUSPECT |
| — | golden-cross | 20/20 | 0.16% | 55% | -4.12 (13/20) | -68.77 (20/20) | n/a | -0.25 | 0.32 | 12 | 2002-08-07 → 2026-08-23 | INSUFFICIENT-EVIDENCE SPARSE-EDGE-SUBSET |
| — | pro-stack | 20/20 | 0.79% | 70% | -14.95 (11/20) | -74.53 (19/20) | n/a | 0.65 | 2.55 | 5 | 2003-02-05 → 2026-08-23 | INSUFFICIENT-EVIDENCE SPARSE-EDGE-SUBSET |
| — | abuk-1m | 0/1 | n/a% | n/a% | n/a (0/0) | n/a (0/0) | n/a | n/a | n/a | n/a | n/a → n/a | — |
| — | orhd-5m-copy | 8/8 | -26.74% | 0% | n/a (0/8) | -122.14 (8/8) | n/a | n/a | -18.93 | 179 | 2023-04-27 → 2026-08-23 | OOS-ONLY |
| — | orhd-5m | 8/8 | -21.97% | 0% | n/a (0/8) | -119.84 (8/8) | n/a | n/a | -14.96 | 179 | 2023-04-27 → 2026-08-23 | OOS-ONLY |
| — | wkol-3m | 8/8 | -0.98% | 0% | n/a (0/8) | -68.30 (8/8) | n/a | n/a | -5.24 | 72 | 2024-08-12 → 2026-08-23 | OOS-ONLY |

Unranked rows: OOS-ONLY (no in-sample trades — intraday depth), INSUFFICIENT-EVIDENCE (median <30 trades), errors, or the baseline.

## Per-strategy cell detail

### baseline-sma100 — Per-symbol SMA100 approximation — NOT the basket strategy. The incumbent N=80 basket is gated at index/breadth level; its numbers come from the live clock and the estate engine, not from TV.

| symbol | net% (full) | trades | maxDD% | B&H% (full) | IS edge/yr | OOS edge/yr | coverage |
|---|---|---|---|---|---|---|---|
| MFPC | 655.83 | 43 | 40.34 | 806 | 33.53 | -45.28 | 2017-02-07 → 2026-06-16 |
| EFID | 791.43 | 45 | 27.49 | 321 | 22.07 | -85.17 | 2015-09-08 → 2026-08-23 |
| JUFO | 899.02 | 64 | 49.21 | 914 | 19.49 | -65.73 | 2010-11-08 → 2026-08-23 |
| AMOC | 161.92 | 109 | 54.81 | 103 | 19.13 | -26.13 | 2006-07-12 → 2026-08-23 |
| ORAS | 572.09 | 42 | 33.00 | 1217 | 11.07 | -131.92 | 2016-03-28 → 2026-08-23 |
| SWDY | 4163.94 | 100 | 51.47 | 5044 | 9.13 | -175.21 | 2006-11-05 → 2026-08-23 |
| TMGH | 2365.08 | 69 | 33.42 | 3045 | 8.91 | -165.97 | 2009-03-22 → 2026-08-23 |
| ARCC | 741.51 | 53 | 60.01 | 476 | 8.82 | -224.05 | 2014-08-31 → 2026-08-23 |
| ISPH | 108.19 | 35 | 41.51 | 94 | 7.00 | -7.88 | 2018-05-10 → 2026-08-23 |
| SKPC | 52.23 | 96 | 59.27 | 71 | 6.29 | -21.01 | 2005-12-11 → 2026-08-23 |
| FWRY | 685.09 | 42 | 41.22 | 890 | -5.59 | -70.70 | 2020-02-10 → 2026-08-23 |
| CLHO | 265.64 | 60 | 56.89 | 1212 | -19.34 | -29.67 | 2016-09-18 → 2026-08-23 |
| ABUK | 2571.62 | 123 | 41.27 | 7409 | n/a | -31.11 | 2001-10-09 → 2026-08-19 |
| ALCN | 2530.90 | 120 | 70.76 | 24231 | n/a | -102.38 | 2003-03-11 → 2026-08-23 |
| COMI | 10526.16 | 114 | 27.04 | 21588 | n/a | -41.26 | 2002-03-07 → 2026-08-23 |
| EAST | 13043.30 | 100 | 48.54 | 7329 | n/a | -47.67 | 2001-10-21 → 2026-06-24 |
| EGAL | 10429.86 | 111 | 78.20 | 21610 | n/a | -226.94 | 2002-07-17 → 2026-08-23 |
| ETEL | 241.49 | 105 | 54.01 | 778 | n/a | -92.68 | 2006-09-21 → 2026-08-23 |
| HRHO | 8929.12 | 123 | 62.82 | 10023 | n/a | -38.47 | 2002-04-17 → 2026-08-17 |
| ORWE | 515.97 | 126 | 58.77 | 3724 | n/a | -27.43 | 2001-12-27 → 2026-08-23 |

### conservative — Named "100-Tick"; run on 1D as the closest available chart — flagged, not hidden.

| symbol | net% (full) | trades | maxDD% | B&H% (full) | IS edge/yr | OOS edge/yr | coverage |
|---|---|---|---|---|---|---|---|
| MFPC | 0.70 | 19 | 0.28 | 486 | 40.14 | -112.76 | 2018-11-27 → 2026-03-30 |
| ISPH | 0.50 | 9 | 0.08 | 64 | 26.32 | -100.26 | 2019-04-11 → 2026-03-10 |
| ARCC | -0.12 | 6 | 0.16 | 324 | 22.43 | -172.64 | 2015-03-29 → 2026-03-16 |
| EFID | 0.54 | 24 | 0.13 | 328 | 13.54 | -89.78 | 2015-08-20 → 2024-11-27 |
| SKPC | -0.10 | 11 | 0.33 | 119 | 11.14 | -77.34 | 2013-12-26 → 2026-01-18 |
| ORAS | 0.80 | 17 | 0.12 | 820 | 3.87 | -146.93 | 2015-11-05 → 2025-11-25 |
| AMOC | -0.14 | 12 | 0.20 | 374 | -1.13 | 13.78 | 2009-03-15 → 2025-11-27 |
| EGAL | 0.36 | 11 | 0.11 | 5570 | -3.81 | -236.81 | 2004-07-28 → 2025-09-07 |
| JUFO | 0.15 | 15 | 0.31 | 1116 | -7.29 | -106.42 | 2012-07-29 → 2026-03-25 |
| SWDY | -0.14 | 11 | 0.32 | 5345 | -9.91 | 16.84 | 2007-01-23 → 2025-08-27 |
| CLHO | 0.17 | 7 | 0.12 | 1242 | -88.27 | -20.79 | 2016-07-19 → 2025-03-27 |
| ETEL | -0.02 | 6 | 0.21 | 938 | -255.69 | -101.67 | 2021-02-23 → 2026-03-10 |
| ABUK | 0.58 | 36 | 0.38 | 9018 | n/a | -53.59 | 2001-11-28 → 2026-06-23 |
| ALCN | 1.23 | 21 | 0.14 | 26258 | n/a | -145.78 | 2002-10-14 → 2026-06-29 |
| COMI | 1.35 | 22 | 0.18 | 17926 | n/a | -120.55 | 2001-09-13 → 2026-08-20 |
| EAST | 0.76 | 44 | 1.33 | 8567 | n/a | -80.71 | 2001-07-29 → 2026-07-15 |
| FWRY | 0.13 | 5 | 0.07 | 234 | n/a | -42.85 | 2022-01-26 → 2026-01-05 |
| HRHO | -0.17 | 9 | 0.57 | 4438 | n/a | -47.78 | 2001-10-21 → 2026-08-20 |
| ORWE | 0.91 | 19 | 0.17 | 3321 | n/a | -49.74 | 2002-04-03 → 2025-11-25 |
| TMGH | 0.56 | 9 | 0.05 | 963 | n/a | -248.02 | 2023-03-07 → 2026-03-04 |

### golden-cross

| symbol | net% (full) | trades | maxDD% | B&H% (full) | IS edge/yr | OOS edge/yr | coverage |
|---|---|---|---|---|---|---|---|
| MFPC | -1.39 | 4 | 1.39 | 607 | 24.00 | 2.98 | 2019-11-18 → 2025-11-25 |
| ARCC | 1.08 | 7 | 2.91 | 913 | 8.53 | -81.46 | 2017-01-04 → 2024-10-22 |
| SKPC | 0.10 | 17 | 4.09 | 66 | 4.16 | -73.82 | 2006-12-27 → 2026-03-08 |
| AMOC | -0.91 | 16 | 2.40 | 82 | 2.73 | -31.83 | 2006-08-28 → 2026-03-26 |
| EFID | -1.56 | 8 | 2.30 | 249 | -1.15 | -85.74 | 2016-05-08 → 2025-09-10 |
| CLHO | 0.33 | 7 | 2.24 | 312 | -1.60 | -24.46 | 2018-12-11 → 2025-08-25 |
| TMGH | -0.15 | 15 | 3.25 | 2164 | -4.12 | -181.95 | 2009-05-28 → 2025-08-14 |
| EGAL | 0.99 | 12 | 3.15 | 5283 | -5.44 | -299.84 | 2004-04-27 → 2022-11-22 |
| JUFO | -2.78 | 10 | 3.37 | 1079 | -6.76 | -79.95 | 2012-07-19 → 2025-12-28 |
| ORAS | 0.22 | 8 | 2.02 | 1118 | -7.05 | -123.81 | 2016-09-04 → 2025-07-16 |
| SWDY | -0.47 | 12 | 1.95 | 2900 | -11.99 | -185.05 | 2009-07-08 → 2026-02-19 |
| ALCN | 3.84 | 12 | 1.45 | 6490 | -21.95 | -133.72 | 2007-04-26 → 2025-12-15 |
| ISPH | -0.61 | 6 | 2.61 | 77 | -646.60 | -63.72 | 2019-02-10 → 2026-06-21 |
| ABUK | -2.12 | 13 | 2.90 | 4906 | n/a | -63.14 | 2003-04-09 → 2026-02-12 |
| COMI | 0.60 | 12 | 1.06 | 16827 | n/a | -45.99 | 2003-02-04 → 2025-07-15 |
| EAST | 1.07 | 13 | 1.25 | 9479 | n/a | -77.97 | 2002-09-04 → 2024-10-01 |
| ETEL | 1.60 | 14 | 2.55 | 726 | n/a | -39.70 | 2006-11-20 → 2025-01-14 |
| FWRY | 0.52 | 2 | 0.53 | 271 | n/a | -0.99 | 2022-12-19 → 2024-01-24 |
| HRHO | -2.68 | 22 | 3.77 | 7211 | n/a | -31.61 | 2002-10-28 → 2026-02-26 |
| ORWE | 1.04 | 15 | 2.75 | 3321 | n/a | -45.82 | 2002-08-07 → 2026-08-23 |

### pro-stack

| symbol | net% (full) | trades | maxDD% | B&H% (full) | IS edge/yr | OOS edge/yr | coverage |
|---|---|---|---|---|---|---|---|
| MFPC | 1.14 | 8 | 1.21 | 838 | 96.62 | -74.53 | 2020-11-25 → 2025-12-30 |
| ARCC | -0.58 | 4 | 1.37 | 307 | 20.14 | -255.88 | 2015-05-11 → 2025-11-02 |
| SKPC | -0.27 | 3 | 1.04 | 53 | 17.51 | 1433.97 | 2017-12-20 → 2024-01-17 |
| AMOC | 0.59 | 8 | 1.40 | 48 | 13.68 | -92.56 | 2017-09-17 → 2024-01-22 |
| SWDY | 1.84 | 3 | 0.55 | 1260 | -4.01 | -105.97 | 2017-05-28 → 2024-01-17 |
| ABUK | 1.15 | 8 | 1.20 | 1052 | -14.95 | -122.44 | 2007-06-04 → 2023-04-09 |
| HRHO | 0.55 | 4 | 1.21 | 3232 | -25.49 | n/a | 2004-01-22 → 2016-10-11 |
| CLHO | 0.81 | 5 | 0.80 | 623 | -116.70 | -50.85 | 2017-03-20 → 2026-05-17 |
| EGAL | 5.43 | 7 | 0.53 | 2525 | -304.88 | -124.75 | 2017-06-20 → 2026-08-23 |
| COMI | -0.12 | 15 | 1.60 | 12994 | -320.44 | -67.90 | 2004-01-22 → 2026-08-11 |
| ALCN | 2.47 | 9 | 1.26 | 14962 | -328.90 | 237.60 | 2005-01-23 → 2023-12-28 |
| EAST | 0.02 | 8 | 1.89 | 7483 | n/a | -52.99 | 2003-02-05 → 2025-08-04 |
| EFID | 2.32 | 4 | 0.91 | 189 | n/a | -56.90 | 2023-10-16 → 2026-08-16 |
| ETEL | 0.77 | 10 | 0.77 | 702 | n/a | -133.05 | 2007-02-19 → 2026-04-30 |
| FWRY | -1.10 | 5 | 1.19 | 228 | n/a | -71.14 | 2023-05-01 → 2026-08-13 |
| ISPH | 2.53 | 4 | 0.88 | 470 | n/a | -180.49 | 2023-10-30 → 2026-08-11 |
| JUFO | 3.23 | 5 | 0.47 | 250 | n/a | -43.28 | 2023-04-09 → 2026-08-23 |
| ORAS | -0.47 | 3 | 0.95 | 537 | n/a | -125.30 | 2023-09-20 → 2026-02-19 |
| ORWE | 2.48 | 10 | 1.78 | 1006 | n/a | -35.98 | 2003-09-17 → 2026-02-19 |
| TMGH | -0.66 | 5 | 1.47 | 935 | n/a | -321.44 | 2023-06-01 → 2026-05-10 |

### abuk-1m — Source hard-locks execution to EGX:ABUK (active = isSymbolOK && isTfOK) — other symbols are disabled by construction, so only ABUK is run (sol-max pass 7).
> 1 NO_TRADES cell(s) — computed reports with zero round trips.

| symbol | net% (full) | trades | maxDD% | B&H% (full) | IS edge/yr | OOS edge/yr | coverage |
|---|---|---|---|---|---|---|---|

### orhd-5m-copy

| symbol | net% (full) | trades | maxDD% | B&H% (full) | IS edge/yr | OOS edge/yr | coverage |
|---|---|---|---|---|---|---|---|
| ABUK | -13.17 | 132 | 17.84 | 64 | n/a | -30.29 | 2023-06-13 → 2026-08-13 |
| COMI | -2.24 | 56 | 6.79 | 113 | n/a | -44.91 | 2023-11-09 → 2026-07-08 |
| ETEL | -33.03 | 184 | 33.56 | 353 | n/a | -133.86 | 2023-06-07 → 2026-08-16 |
| FWRY | -28.92 | 200 | 31.71 | 230 | n/a | -110.41 | 2023-05-28 → 2026-05-10 |
| HRHO | -11.60 | 112 | 15.01 | 65 | n/a | -36.30 | 2023-06-05 → 2026-03-01 |
| ISPH | -49.26 | 306 | 52.26 | 501 | n/a | -201.89 | 2023-06-01 → 2026-08-20 |
| ORAS | -25.87 | 174 | 25.87 | 638 | n/a | -211.44 | 2023-04-27 → 2026-08-23 |
| TMGH | -27.61 | 220 | 30.34 | 981 | n/a | -349.67 | 2023-05-29 → 2026-07-20 |

### orhd-5m

| symbol | net% (full) | trades | maxDD% | B&H% (full) | IS edge/yr | OOS edge/yr | coverage |
|---|---|---|---|---|---|---|---|
| ABUK | -14.75 | 132 | 19.78 | 64 | n/a | -31.44 | 2023-06-13 → 2026-08-13 |
| COMI | -0.92 | 56 | 7.35 | 113 | n/a | -43.88 | 2023-11-09 → 2026-07-08 |
| ETEL | -29.91 | 184 | 31.06 | 353 | n/a | -131.00 | 2023-06-07 → 2026-08-16 |
| FWRY | -27.15 | 200 | 28.79 | 230 | n/a | -108.68 | 2023-05-28 → 2026-05-10 |
| HRHO | -12.93 | 112 | 16.02 | 65 | n/a | -37.39 | 2023-06-05 → 2026-03-01 |
| ISPH | -47.18 | 306 | 50.87 | 501 | n/a | -199.26 | 2023-06-01 → 2026-08-20 |
| ORAS | -21.87 | 174 | 23.83 | 638 | n/a | -208.25 | 2023-04-27 → 2026-08-23 |
| TMGH | -22.07 | 220 | 28.40 | 981 | n/a | -344.93 | 2023-05-29 → 2026-07-20 |

### wkol-3m
> source_patch: `input.bool(true, "Signals only (no orders)") -> input.bool(false, "Signals only (no orders)")`

| symbol | net% (full) | trades | maxDD% | B&H% (full) | IS edge/yr | OOS edge/yr | coverage |
|---|---|---|---|---|---|---|---|
| ABUK | -0.99 | 68 | 1.02 | 25 | n/a | -20.56 | 2024-09-26 → 2026-08-18 |
| COMI | -0.97 | 82 | 1.24 | 79 | n/a | -48.39 | 2024-09-26 → 2026-08-09 |
| ETEL | -0.65 | 83 | 0.65 | 249 | n/a | -122.36 | 2024-08-12 → 2026-08-20 |
| FWRY | -0.82 | 71 | 1.44 | 160 | n/a | -88.21 | 2024-09-09 → 2026-08-10 |
| HRHO | -0.85 | 69 | 0.94 | 12 | n/a | -12.87 | 2024-09-09 → 2026-08-12 |
| ISPH | -1.75 | 72 | 1.98 | 276 | n/a | -148.96 | 2024-09-04 → 2026-08-23 |
| ORAS | -1.23 | 71 | 1.26 | 191 | n/a | -98.34 | 2024-08-14 → 2026-08-23 |
| TMGH | -1.50 | 72 | 1.50 | 63 | n/a | -43.61 | 2024-09-19 → 2026-08-19 |

---
Protocol: docs/ANTI_OVERFITTING_PROTOCOL.md (P1–P7). G4 cross-engine reference: pine-audit/backtest-output.txt. Generated 2026-08-23T16:17:01.410Z.