# Track C — cyclicality & cross-asset findings (2026-08-25)

Pre-registered families: docs/PREREG_CAMPAIGN_2026-08-25.md (frozen at aafcc97,
before any data was examined). Analysis code sol-max reviewed (pass 17: 10
findings, all fixed; pass 18 verification). **PROXY note on every basket
figure: equal-weight deep-36, NOT the live N=80 basket.** IS/OOS at 2022-01-01.

## The denominator first

**27 registered tests ran. 0 candidates cleared an action bar.**
2 results are WEAK-MARGINAL (registered, surviving, below action):

- **Tue-signal → next-day return**: IS -15.82bp (CI [-44.98, 7.97]), OOS -17.73bp.
  The IS CI straddles zero → WEAK-MARGINAL; next quarter's data decides.
- **GOLD(W) → EGX30(+1w), negative as declared**: Pearson −0.167→−0.163, Spearman −0.092→−0.151,
  stable across windows but only 55 IS weeks → WEAK-MARGINAL.
  (An earlier EEM "survivor" died under corrected one-to-one week pairing — its
  apparent OOS strength was partly a target-reuse artifact; recorded as such.)

## Nulls and kills, on the record

- **Momentum 12-1 (registered DECILES): FAILED.** IS −0.35%/mo, OOS +0.72%/mo (after removing a
  right-censored partial final month that alone contributed +34.96%) — no IS edge to validate.
  An UNREGISTERED tercile variant showed +0.44→+0.93%/mo and is recorded as implementation
  drift, not a finding — the prereg caught a false candidate being manufactured.
- **Ramadan** (declared positive): IS -25.26bp, OOS -12.73bp — directional null (observed negative both windows; exploratory note only).
- **Turn-of-month** (declared positive): IS 66.95bp → OOS 8.37bp — the classic IS-mirage collapse.
- **Cross-asset**: Brent, GOLD, DXY, ΔUS10Y, ΔUSDEGP(M) — all null (signs flip or magnitudes collapse OOS).
- **Weekly basket AR(1)**: 0.033→-0.024 — null.
- **Month-of-year**: 7/12 'survive' raw AND demeaned — that many is the signature of
  regime structure + multiple comparisons, not calendar causality → INCONCLUSIVE-SUSPECT, no candidates.

## Exploratory (registered as report-alongside, no hypothesis status)
- **Eid ±5d window**: IS +65.4bp/day (CI [+18.8, +113.5]), OOS +127.1bp/day (CI [+20.6, +359.8]) —
  both CIs exclude zero; the strongest single number in Track C;
  eligible to be REGISTERED as a directional hypothesis for a FUTURE family, nothing more today.

## Data honesty
- QuestDB bar stamps are 14:30Z (session close); an earlier +12h date-shift bug put every
  weekday off by one and was caught before publication (family-wide re-run).
- Weekly/monthly macro frames are 300-bar capped (W→2020-11, M→2001); IS depth varies per family and is stated per test.
- Raw QuestDB closes are unadjusted; TV adjusted — families use returns or within-series structure, not cross-source levels.