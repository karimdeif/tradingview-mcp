#!/usr/bin/env python3
"""Track C — cyclicality & cross-asset study, per docs/PREREG_CAMPAIGN_2026-08-25.md.

Every test in every family F1-F6 is computed and reported, nulls included.
IS/OOS split 2022-01-01. Survival = IS effect keeps sign and >=half its
magnitude OOS. Effect sizes with block-bootstrap 95% CIs (block=10, N=2000).
Data: QuestDB ref universe file (deep-36 equal-weight basket proxy, declared)
+ TV macro series (1W/1M frames). Outputs JSON + Markdown findings.
"""
import json, random, statistics, datetime, sys

random.seed(20260825)  # deterministic bootstrap, declared
REF = json.load(open('/home/karim/claude-a15-20260818/pine-audit/data/ref_universe_2026-08-25.json'))
MACRO = json.load(open('/home/karim/claude-a15-20260818/strategy-tournament/macro-series-2026-08-25.json'))
DEEP = "HRHO COMI ELSH OCDI ADIB HELI ABUK SKPC EGCH EGAL RAYA AMOC PHAR MPCO TMGH PHDC ORHD ZMID NIPH AMER OIH BTFH MASR ETEL SVCE CCAP GBCO ORAS EMFD MPCI ARAB EFID MFPC ISPH DSCW ACAMD".split()
SPLIT = datetime.date(2022, 1, 1).toordinal()

# QuestDB stamps daily bars late in the UTC day (observed 21:00+); a naive
# +12h 'midpoint' shift rolled EVERY date one day forward — the basket showed
# Friday bars on a Sun-Thu exchange, and the whole F1 family measured the
# wrong weekday. The bar's own UTC date IS the trading day.
def day(ts): return datetime.datetime.fromtimestamp(ts, datetime.UTC).date()

# ---- equal-weight deep-36 daily basket returns (long-history index proxy) ----
by_day = {}
for sym in DEEP:
    bars = REF[sym]
    for i in range(1, len(bars)):
        if bars[i-1][4] and bars[i][4]:
            d = day(bars[i][0])
            by_day.setdefault(d, []).append(bars[i][4]/bars[i-1][4] - 1)
basket = sorted((d, statistics.mean(rs)) for d, rs in by_day.items() if len(rs) >= 10)
print(f"basket: {len(basket)} days {basket[0][0]} -> {basket[-1][0]}", file=sys.stderr)

def block_bootstrap_ci(xs, n=2000, block=10):
    if len(xs) < block * 3: return (float('nan'), float('nan'))
    means = []
    nb = max(1, len(xs)//block)
    for _ in range(n):
        sample = []
        for _ in range(nb):
            i = random.randrange(0, len(xs)-block)
            sample.extend(xs[i:i+block])
        means.append(statistics.mean(sample))
    means.sort()
    return (means[int(0.025*n)], means[int(0.975*n)])

def split_is_oos(pairs):  # pairs: [(date, ret)]
    return [r for d, r in pairs if d.toordinal() < SPLIT], [r for d, r in pairs if d.toordinal() >= SPLIT]

def survives(is_eff, oos_eff):
    if is_eff != is_eff or oos_eff != oos_eff: return False
    return (is_eff > 0) == (oos_eff > 0) and abs(oos_eff) >= abs(is_eff)/2

findings = {"prereg": "docs/PREREG_CAMPAIGN_2026-08-25.md", "split": "2022-01-01", "families": {}}

# ---- F1 day-of-week (all 5) ----
f1 = []
for wd, name in [(6,'Sun'),(0,'Mon'),(1,'Tue'),(2,'Wed'),(3,'Thu')]:
    on = [(d, r) for d, r in basket if d.weekday() == wd]
    off = [(d, r) for d, r in basket if d.weekday() != wd]
    is_on, oos_on = split_is_oos(on); is_off, oos_off = split_is_oos(off)
    if not is_on or not oos_on: continue
    eff_is = (statistics.mean(is_on) - statistics.mean(is_off)) * 1e4
    eff_oos = (statistics.mean(oos_on) - statistics.mean(oos_off)) * 1e4
    lo, hi = block_bootstrap_ci([r*1e4 for r in is_on])
    f1.append({"day": name, "is_bp": round(eff_is,2), "oos_bp": round(eff_oos,2),
               "is_ci_bp": [round(lo-statistics.mean(is_off)*1e4,2), round(hi-statistics.mean(is_off)*1e4,2)],
               "n_is": len(is_on), "n_oos": len(oos_on), "survives": survives(eff_is, eff_oos)})
findings["families"]["F1_day_of_week"] = f1

# ---- F2 month-of-year (all 12), 25y monthly index ----
mi = MACRO['egx30'].get('M', [])
f2 = []
if len(mi) > 60:
    mrets = [(day(mi[i][0]), mi[i][1]/mi[i-1][1]-1) for i in range(1, len(mi)) if mi[i-1][1]]
    for m in range(1, 13):
        on = [(d, r) for d, r in mrets if d.month == m]; off = [(d, r) for d, r in mrets if d.month != m]
        is_on, oos_on = split_is_oos(on); is_off, _ = split_is_oos(off)
        if len(is_on) < 5 or len(oos_on) < 2: continue
        eff_is = (statistics.mean(is_on) - statistics.mean(is_off)) * 100
        eff_oos = (statistics.mean(oos_on) - statistics.mean([r for d, r in off if d.toordinal() >= SPLIT])) * 100
        f2.append({"month": m, "is_pct": round(eff_is,2), "oos_pct": round(eff_oos,2),
                   "n_is": len(is_on), "n_oos": len(oos_on), "survives": survives(eff_is, eff_oos)})
findings["families"]["F2_month_of_year"] = f2

# ---- F3 Ramadan (declared POSITIVE) + Eid windows ----
RAMADAN_STARTS = ["2005-10-04","2006-09-24","2007-09-13","2008-09-01","2009-08-22","2010-08-11",
  "2011-08-01","2012-07-20","2013-07-09","2014-06-28","2015-06-18","2016-06-06","2017-05-27",
  "2018-05-16","2019-05-06","2020-04-24","2021-04-13","2022-04-02","2023-03-23","2024-03-11",
  "2025-03-01","2026-02-18"]
ram = []
for s in RAMADAN_STARTS:
    d0 = datetime.date.fromisoformat(s); ram.append((d0, d0 + datetime.timedelta(days=30)))
def in_ram(d): return any(a <= d <= b for a, b in ram)
on = [(d, r) for d, r in basket if in_ram(d)]; off = [(d, r) for d, r in basket if not in_ram(d)]
is_on, oos_on = split_is_oos(on); is_off, oos_off = split_is_oos(off)
eff_is = (statistics.mean(is_on)-statistics.mean(is_off))*1e4; eff_oos = (statistics.mean(oos_on)-statistics.mean(oos_off))*1e4
eid = []
for _, b in ram:
    for k in range(1, 6):
        eid.append(b + datetime.timedelta(days=k))
eidset = set(eid)
on_e = [(d, r) for d, r in basket if d in eidset]
is_e, oos_e = split_is_oos(on_e)
findings["families"]["F3_ramadan"] = {
  "declared_direction": "positive", "is_bp_per_day": round(eff_is,2), "oos_bp_per_day": round(eff_oos,2),
  "n_is": len(is_on), "n_oos": len(oos_on), "survives": survives(eff_is, eff_oos) and eff_is > 0,
  "eid_5d_is_bp": round((statistics.mean(is_e)-statistics.mean(is_off))*1e4,2) if is_e else None,
  "eid_5d_oos_bp": round((statistics.mean(oos_e)-statistics.mean(oos_off))*1e4,2) if oos_e else None,
  "note": "30-day windows from tabulated starts (approximation declared)"}

# ---- F4 turn-of-month (declared POSITIVE): days -1..+3 ----
tom = []
bdays = [d for d, _ in basket]
bset = {d: i for i, d in enumerate(bdays)}
rets = dict(basket)
month_first = {}
for d in bdays:
    key = (d.year, d.month)
    if key not in month_first: month_first[key] = d
tom_days = set()
for key, first in month_first.items():
    i = bset[first]
    for off_i in (-1, 0, 1, 2):
        j = i + off_i
        if 0 <= j < len(bdays): tom_days.add(bdays[j])
on = [(d, r) for d, r in basket if d in tom_days]; off = [(d, r) for d, r in basket if d not in tom_days]
is_on, oos_on = split_is_oos(on); is_off, oos_off = split_is_oos(off)
eff_is = (statistics.mean(is_on)-statistics.mean(is_off))*1e4; eff_oos = (statistics.mean(oos_on)-statistics.mean(oos_off))*1e4
findings["families"]["F4_turn_of_month"] = {"declared_direction":"positive","is_bp_per_day":round(eff_is,2),
  "oos_bp_per_day":round(eff_oos,2),"n_is":len(is_on),"n_oos":len(oos_on),
  "survives": survives(eff_is, eff_oos) and eff_is > 0}

# ---- F5 cross-asset lead-lag, weekly lag-1, declared directions ----
def weekly_rets(series):
    out = []
    for i in range(1, len(series)):
        if series[i-1][1]:
            out.append((day(series[i][0]), series[i][1]/series[i-1][1]-1))
    return out
def weekly_diffs(series):
    return [(day(series[i][0]), series[i][1]-series[i-1][1]) for i in range(1, len(series))]
egxw = weekly_rets(MACRO['egx30']['W'])
def corr(xs, ys):
    n = len(xs)
    if n < 8: return float('nan')
    mx, my = statistics.mean(xs), statistics.mean(ys)
    sx, sy = statistics.stdev(xs), statistics.stdev(ys)
    if sx == 0 or sy == 0: return float('nan')
    return sum((x-mx)*(y-my) for x, y in zip(xs, ys)) / ((n-1)*sx*sy)
def spearman(xs, ys):
    rx = {v: i for i, v in enumerate(sorted(xs))}; ry = {v: i for i, v in enumerate(sorted(ys))}
    return corr([rx[x] for x in xs], [ry[y] for y in ys])
PAIRS = [("brent","positive",weekly_rets),("gold","negative",weekly_rets),("dxy","negative",weekly_rets),
         ("eem","positive",weekly_rets),("us10y","negative",weekly_diffs),("usdegp","negative",weekly_rets)]
f5 = []
egx_by_week = {d.isocalendar()[:2]: r for d, r in egxw}
for key, direction, fn in PAIRS:
    src = fn(MACRO[key]['W'])
    xs, ys = [], []
    for d, x in src:
        wk = d.isocalendar()[:2]
        y_, m_ = wk
        nxt = (datetime.date.fromisocalendar(y_, m_, 1) + datetime.timedelta(weeks=1)).isocalendar()[:2]
        if nxt in egx_by_week:
            xs.append((d, x)); ys.append(egx_by_week[nxt])
    is_x = [x for d, x in xs if d.toordinal() < SPLIT]; is_y = [y for (d, _), y in zip(xs, ys) if d.toordinal() < SPLIT]
    oos_x = [x for d, x in xs if d.toordinal() >= SPLIT]; oos_y = [y for (d, _), y in zip(xs, ys) if d.toordinal() >= SPLIT]
    pi, po = corr(is_x, is_y), corr(oos_x, oos_y)
    si, so = spearman(is_x, is_y), spearman(oos_x, oos_y)
    want = 1 if direction == "positive" else -1
    sv = (pi==pi and po==po and (pi>0)==(want>0) and (po>0)==(want>0) and (si>0)==(want>0) and (so>0)==(want>0) and abs(po)>=abs(pi)/2)
    f5.append({"pair": f"{key}->egx30(+1w)", "declared": direction,
               "pearson_is": round(pi,3), "pearson_oos": round(po,3),
               "spearman_is": round(si,3), "spearman_oos": round(so,3),
               "n_is": len(is_x), "n_oos": len(oos_x), "survives": bool(sv)})
findings["families"]["F5_cross_asset"] = f5

# ---- F6 autocorrelation + momentum deciles ----
w_r = [r for _, r in egxw]
ar1 = corr(w_r[:-1], w_r[1:])
is_w = [(d, r) for d, r in egxw if d.toordinal() < SPLIT]; oos_w = [(d, r) for d, r in egxw if d.toordinal() >= SPLIT]
ar1_is = corr([r for _, r in is_w][:-1], [r for _, r in is_w][1:]) if len(is_w) > 10 else float('nan')
ar1_oos = corr([r for _, r in oos_w][:-1], [r for _, r in oos_w][1:]) if len(oos_w) > 10 else float('nan')
# momentum: monthly, deep-36, 12m lookback skip 1m, top-vs-bottom tercile fwd 1m
mclose = {}
for sym in DEEP:
    for t, o, h, l, c, v in REF[sym]:
        d = day(t); mclose.setdefault(sym, {})[(d.year, d.month)] = c
months = sorted(set(k for v in mclose.values() for k in v))
spread_is, spread_oos = [], []
for i in range(13, len(months)-1):
    m0, m12, m1, mf = months[i], months[i-13], months[i-1], months[i+1]
    scored = []
    for sym in DEEP:
        mc = mclose[sym]
        if all(k in mc for k in (m0, m12, m1, mf)) and mc[m12] and mc[m0]:
            scored.append((mc[m1]/mc[m12]-1, mc[mf]/mc[m0]-1, sym))
    if len(scored) < 15: continue
    scored.sort(key=lambda x: x[0])
    k = len(scored)//3
    spread = statistics.mean(x[1] for x in scored[-k:]) - statistics.mean(x[1] for x in scored[:k])
    (spread_is if datetime.date(m0[0], m0[1], 1).toordinal() < SPLIT else spread_oos).append(spread)
mom_is = statistics.mean(spread_is)*100 if spread_is else float('nan')
mom_oos = statistics.mean(spread_oos)*100 if spread_oos else float('nan')
findings["families"]["F6_autocorr_momentum"] = {
  "weekly_ar1_full": round(ar1,3), "weekly_ar1_is": round(ar1_is,3), "weekly_ar1_oos": round(ar1_oos,3),
  "ar1_survives": survives(ar1_is, ar1_oos),
  "momentum_12_1_tercile_spread_is_pct_mo": round(mom_is,2), "momentum_oos_pct_mo": round(mom_oos,2),
  "n_months_is": len(spread_is), "n_months_oos": len(spread_oos),
  "momentum_survives": survives(mom_is, mom_oos)}

out = '/home/karim/claude-a15-20260818/strategy-tournament/track-c-findings-2026-08-25.json'
json.dump(findings, open(out, 'w'), indent=1)
print(json.dumps(findings, indent=1)[:200], file=sys.stderr)
print(f"wrote {out}", file=sys.stderr)
survivors = []
for fam, res in findings["families"].items():
    items = res if isinstance(res, list) else [res]
    for it in items:
        for k, v in it.items():
            if k.endswith("survives") and v is True:
                survivors.append((fam, it.get('day') or it.get('month') or it.get('pair') or k))
print("SURVIVORS:", survivors, file=sys.stderr)
