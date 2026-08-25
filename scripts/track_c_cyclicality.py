#!/usr/bin/env python3
"""Track C — cyclicality & cross-asset study, per docs/PREREG_CAMPAIGN_2026-08-25.md.

Rewritten after sol pass 17 (10 findings): F1 classifies the NEXT-day return by
the signal day's weekday as registered; F3/F4 boundary arithmetic corrected;
F5 pairs by positional next trading week with tie-averaged Spearman and
MONTHLY USDEGP per the frozen text; F6 runs on the declared weekly BASKET and
uses DECILES; survives() requires a nonzero same-sign product; the bootstrap
resamples the full flagged series and reports the on-minus-off effect CI, for
every family. All tests reported, nulls included. IS/OOS split 2022-01-01
(a pair is OOS if EITHER side falls on/after the split — no boundary leakage).
"""
import json, random, statistics, datetime, sys

random.seed(20260825)
REF = json.load(open('/home/karim/claude-a15-20260818/pine-audit/data/ref_universe_2026-08-25.json'))
MACRO = json.load(open('/home/karim/claude-a15-20260818/strategy-tournament/macro-series-2026-08-25.json'))
DEEP = "HRHO COMI ELSH OCDI ADIB HELI ABUK SKPC EGCH EGAL RAYA AMOC PHAR MPCO TMGH PHDC ORHD ZMID NIPH AMER OIH BTFH MASR ETEL SVCE CCAP GBCO ORAS EMFD MPCI ARAB EFID MFPC ISPH DSCW ACAMD".split()
SPLIT = datetime.date(2022, 1, 1).toordinal()

def day(ts):
    """UTC date of the bar stamp (verified 14:30Z session-close stamps)."""
    return datetime.datetime.fromtimestamp(ts, datetime.UTC).date()

# ---- equal-weight deep-36 daily basket (PROXY — not the N=80 basket) ----
by_day = {}
for sym in DEEP:
    bars = REF[sym]
    for i in range(1, len(bars)):
        if bars[i-1][4] and bars[i][4]:
            d = day(bars[i][0])
            by_day.setdefault(d, []).append(bars[i][4]/bars[i-1][4] - 1)
basket = sorted((d, statistics.mean(rs)) for d, rs in by_day.items() if len(rs) >= 10)
bdates = [d for d, _ in basket]

def pair_split(d1, d2=None):
    """OOS if EITHER involved date is on/after the split."""
    late = d1.toordinal() >= SPLIT or (d2 is not None and d2.toordinal() >= SPLIT)
    return 'oos' if late else 'is'

def survives(is_eff, oos_eff):
    if is_eff != is_eff or oos_eff != oos_eff: return False
    if is_eff * oos_eff <= 0: return False          # nonzero, same sign (sol 17)
    return abs(oos_eff) >= abs(is_eff) / 2

def effect_ci(flagged, n=2000, block=10):
    """Block bootstrap of the ON-minus-OFF mean over the full flagged series
    [(ret, on_flag)], including the final block start (sol 17)."""
    if len(flagged) < block * 3: return (float('nan'), float('nan'))
    diffs = []
    for _ in range(n):
        smp = []
        while len(smp) < len(flagged):
            i = random.randrange(0, len(flagged) - block + 1)
            smp.extend(flagged[i:i+block])
        smp = smp[:len(flagged)]
        on = [r for r, f in smp if f]; off = [r for r, f in smp if not f]
        if on and off: diffs.append(statistics.mean(on) - statistics.mean(off))
    diffs.sort()
    return (diffs[int(0.025*len(diffs))], diffs[int(0.975*len(diffs))]) if diffs else (float('nan'), float('nan'))

def on_off_family(label_fn, scale=1e4, series=None):
    """Generic on/off family: IS/OOS effects + bootstrap CIs on both windows.
    Rows may be (date, ret) or (date, ret, target_date); the split uses BOTH
    dates when a target exists (sol 18: a 2021-12-30 signal with a 2022-01-02
    payoff is OOS)."""
    src = series if series is not None else basket
    out = {}
    for w in ('is', 'oos'):
        flagged = [(row[1], label_fn(row[0])) for row in src
                   if pair_split(row[0], row[2] if len(row) > 2 else None) == w]
        on = [r for r, f in flagged if f]; off = [r for r, f in flagged if not f]
        if not on or not off: out[w] = None; continue
        lo, hi = effect_ci(flagged)
        out[w] = {"eff": (statistics.mean(on)-statistics.mean(off))*scale,
                  "ci": [lo*scale, hi*scale], "n_on": len(on)}
    return out

findings = {"prereg": "docs/PREREG_CAMPAIGN_2026-08-25.md", "split": "2022-01-01",
            "proxy_note": "PROXY basket = equal-weight deep-36, NOT the N=80 live basket", "families": {}}

# ---- F1: NEXT-day return classified by the SIGNAL day's weekday (as registered) ----
nextday = []  # (signal_date, next_day_return, target_date)
for i in range(len(basket)-1):
    nextday.append((basket[i][0], basket[i+1][1], basket[i+1][0]))
f1 = []
for wd, name in [(6,'Sun'),(0,'Mon'),(1,'Tue'),(2,'Wed'),(3,'Thu')]:
    fam = on_off_family(lambda d, wd=wd: d.weekday() == wd, series=nextday)
    if not fam['is'] or not fam['oos']: continue
    f1.append({"signal_day": name, "is_bp": round(fam['is']['eff'],2), "is_ci": [round(x,2) for x in fam['is']['ci']],
               "oos_bp": round(fam['oos']['eff'],2), "oos_ci": [round(x,2) for x in fam['oos']['ci']],
               "n_is": fam['is']['n_on'], "n_oos": fam['oos']['n_on'],
               "survives": survives(fam['is']['eff'], fam['oos']['eff'])})
findings["families"]["F1_nextday_by_signal_weekday"] = f1

# ---- F2: month-of-year, 25y monthly index + demeaned decomposition ----
mi = MACRO['egx30']['M']
mrets = [(day(mi[i][0]), mi[i][1]/mi[i-1][1]-1) for i in range(1, len(mi)) if mi[i-1][1]]
dem = [(mrets[i][0], mrets[i][1] - statistics.mean(x for _, x in mrets[i-12:i])) for i in range(12, len(mrets))]
def month_family(series, scale=100):
    rows = []
    for m in range(1, 13):
        fam = on_off_family(lambda d, m=m: d.month == m, scale=scale, series=series)
        if not fam['is'] or not fam['oos'] or fam['is']['n_on'] < 5 or fam['oos']['n_on'] < 2: continue
        rows.append({"month": m, "is_pct": round(fam['is']['eff'],2), "is_ci": [round(x,2) for x in fam['is']['ci']],
                     "oos_pct": round(fam['oos']['eff'],2), "oos_ci": [round(x,2) for x in fam['oos']['ci']],
                     "n_is": fam['is']['n_on'], "n_oos": fam['oos']['n_on'],
                     "survives": survives(fam['is']['eff'], fam['oos']['eff'])})
    return rows
findings["families"]["F2_month_of_year"] = month_family(mrets)
findings["families"]["F2b_month_demeaned_12m"] = month_family(dem)

# ---- F3: Ramadan (30-day end-EXCLUSIVE windows) + Eid ±5d after true end, control excludes Eid ----
RAMADAN_STARTS = ["2005-10-04","2006-09-24","2007-09-13","2008-09-01","2009-08-22","2010-08-11",
  "2011-08-01","2012-07-20","2013-07-09","2014-06-28","2015-06-18","2016-06-06","2017-05-27",
  "2018-05-16","2019-05-06","2020-04-24","2021-04-13","2022-04-02","2023-03-23","2024-03-11",
  "2025-03-01","2026-02-18"]
ram = [(datetime.date.fromisoformat(s), datetime.date.fromisoformat(s)+datetime.timedelta(days=30)) for s in RAMADAN_STARTS]
def in_ram(d): return any(a <= d < b for a, b in ram)          # end-exclusive → 30 days
eidset = set()
for _, b in ram:
    for k in range(-5, 6): eidset.add(b + datetime.timedelta(days=k))  # ±5 around the true end (prereg literal)
base_noeid = [(d, r) for d, r in basket if d not in eidset]
famR = on_off_family(in_ram, series=base_noeid)
famE = on_off_family(lambda d: d in eidset, series=[(d, r) for d, r in basket if not in_ram(d)])
findings["families"]["F3_ramadan"] = {
  "declared_direction": "positive",
  "is_bp": round(famR['is']['eff'],2) if famR['is'] else None, "is_ci": [round(x,2) for x in famR['is']['ci']] if famR['is'] else None,
  "oos_bp": round(famR['oos']['eff'],2) if famR['oos'] else None,
  "oos_ci": [round(x,2) for x in famR['oos']['ci']] if famR['oos'] else None,
  "survives": bool(famR['is'] and famR['oos'] and survives(famR['is']['eff'], famR['oos']['eff']) and famR['is']['eff'] > 0),
  "eid_is_bp": round(famE['is']['eff'],2) if famE['is'] else None,
  "eid_is_ci": [round(x,2) for x in famE['is']['ci']] if famE['is'] else None,
  "eid_oos_bp": round(famE['oos']['eff'],2) if famE['oos'] else None,
  "eid_oos_ci": [round(x,2) for x in famE['oos']['ci']] if famE['oos'] else None,
  "note": "30d end-exclusive windows; Eid = 5 days from window end; controls exclude the other regime"}

# ---- F4: turn-of-month −1..+3 relative to the first trading day ----
idx = {d: i for i, d in enumerate(bdates)}
month_first = {}
for d in bdates:
    month_first.setdefault((d.year, d.month), d)
tom_days = set()
for first in month_first.values():
    i = idx[first]
    for off in (-1, 0, 1, 2, 3):                                # −1..+3 (sol 17: +3 was missing)
        if 0 <= i+off < len(bdates): tom_days.add(bdates[i+off])
famT = on_off_family(lambda d: d in tom_days)
findings["families"]["F4_turn_of_month"] = {
  "declared_direction": "positive",
  "is_bp": round(famT['is']['eff'],2) if famT['is'] else None, "is_ci": [round(x,2) for x in famT['is']['ci']] if famT['is'] else None,
  "oos_bp": round(famT['oos']['eff'],2) if famT['oos'] else None,
  "oos_ci": [round(x,2) for x in famT['oos']['ci']] if famT['oos'] else None,
  "survives": bool(famT['is'] and famT['oos'] and survives(famT['is']['eff'], famT['oos']['eff']) and famT['is']['eff'] > 0)}

# ---- F5: cross-asset lead-lag — positional next trading week; monthly USDEGP ----
def series_points(key, tf, diff=False):
    src = MACRO[key][tf]
    # Dedupe to the LAST bar per date FIRST, then compute returns over the
    # deduped level series (sol 18: return-then-overwrite lost information).
    levels = {}
    for t, v in src:
        levels[day(t)] = v
    lv = sorted(levels.items())
    pts = []
    for i in range(1, len(lv)):
        if not diff and not lv[i-1][1]: continue
        v = (lv[i][1]-lv[i-1][1]) if diff else (lv[i][1]/lv[i-1][1]-1)
        pts.append((lv[i][0], v))
    return pts
egx_w = series_points('egx30', 'W')
egx_dates = [d for d, _ in egx_w]
def next_week_target(d):
    """First EGX weekly bar strictly after d + 2 days (positional, not calendar)."""
    for ed, er in egx_w:
        if ed > d + datetime.timedelta(days=2): return ed, er
    return None
def rankdata(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0]*len(xs); i = 0
    while i < len(order):
        j = i
        while j+1 < len(order) and xs[order[j+1]] == xs[order[i]]: j += 1
        avg = (i + j)/2 + 1
        for k in range(i, j+1): ranks[order[k]] = avg             # tie-averaged (sol 17)
        i = j+1
    return ranks
def corr(a, b):
    if len(a) < 8: return float('nan')
    ma, mb = statistics.mean(a), statistics.mean(b); sa, sb = statistics.stdev(a), statistics.stdev(b)
    if sa == 0 or sb == 0: return float('nan')
    return sum((x-ma)*(y-mb) for x, y in zip(a, b))/((len(a)-1)*sa*sb)
def spearman(a, b): return corr(rankdata(a), rankdata(b))
PAIRS = [("brent","positive","W",False),("gold","negative","W",False),("dxy","negative","W",False),
         ("eem","positive","W",False),("us10y","negative","W",True),("usdegp","negative","M",False)]
f5 = []
egx_m = series_points('egx30', 'M')
for key, direction, tf, isdiff in PAIRS:
    pts = series_points(key, tf, diff=isdiff)
    buckets = {"is": ([], []), "oos": ([], [])}
    # ONE-TO-ONE non-overlapping pairing (sol 18: two predictor weeks were
    # reusing one payoff bar): a target pointer only advances.
    tgt = egx_w if tf == 'W' else egx_m
    gap = datetime.timedelta(days=2 if tf == 'W' else 5)
    ti = 0
    for d, x in pts:
        while ti < len(tgt) and tgt[ti][0] <= d + gap: ti += 1
        if ti >= len(tgt): break
        ed, er = tgt[ti]; ti += 1
        b = buckets[pair_split(d, ed)]
        b[0].append(x); b[1].append(er)
    (ix, iy), (ox, oy) = buckets['is'], buckets['oos']
    pi, po, si, so = corr(ix, iy), corr(ox, oy), spearman(ix, iy), spearman(ox, oy)
    want = 1 if direction == "positive" else -1
    ok = lambda v: v == v and (v > 0) == (want > 0)
    sv = ok(pi) and ok(po) and ok(si) and ok(so) and abs(po) >= abs(pi)/2
    f5.append({"pair": f"{key}({tf})->egx30(+1)", "declared": direction,
               "pearson_is": round(pi,3), "pearson_oos": round(po,3),
               "spearman_is": round(si,3), "spearman_oos": round(so,3),
               "n_is": len(ix), "n_oos": len(ox), "survives": bool(sv)})
findings["families"]["F5_cross_asset"] = f5

# ---- F6: BASKET weekly AR(1); DECILE momentum, calendar months, payoff-month bucketing ----
wk = {}
for d, r in basket:
    key = d.isocalendar()[:2]
    wk.setdefault(key, []).append((d, r))
def _compound(rs): 
    p = 1.0
    for x in rs: p *= (1 + x)
    return p - 1
bweek = sorted((max(v)[0], _compound([x for _, x in v])) for _, v in wk.items())
def ar1_of(pairs):
    xs = [r for _, r in pairs]
    return corr(xs[:-1], xs[1:]) if len(xs) > 10 else float('nan')
ar_is = ar1_of([(d, r) for d, r in bweek if d.toordinal() < SPLIT])
ar_oos = ar1_of([(d, r) for d, r in bweek if d.toordinal() >= SPLIT])
mclose = {}
for sym in DEEP:
    for t, o, h, l, c, v in REF[sym]:
        d = day(t); mclose.setdefault(sym, {})[(d.year, d.month)] = c
def month_add(ym, k):
    y, m = ym; m += k
    return (y + (m-1)//12, (m-1) % 12 + 1)
months = sorted(set(k for v in mclose.values() for k in v))
LAST_COMPLETE = months[-2] if len(months) > 1 else None  # final month is partial (right-censoring, sol 18)
spread = {"is": [], "oos": []}
for m0 in months:
    m12, m1, mf = month_add(m0, -13), month_add(m0, -1), month_add(m0, 1)   # calendar arithmetic (sol 17)
    scored = []
    for sym in DEEP:
        mc = mclose[sym]
        if all(k in mc for k in (m0, m12, m1, mf)) and mc[m12] and mc[m0]:
            scored.append((mc[m1]/mc[m12]-1, mc[mf]/mc[m0]-1))
    if len(scored) < 20 or (LAST_COMPLETE and mf > LAST_COMPLETE): continue
    scored.sort(key=lambda x: x[0])
    k = max(2, len(scored)//10)                                            # deciles per prereg (sol 17)
    sp = statistics.mean(x[1] for x in scored[-k:]) - statistics.mean(x[1] for x in scored[:k])
    payoff_date = datetime.date(mf[0], mf[1], 1)                            # bucket by PAYOFF month
    spread['oos' if payoff_date.toordinal() >= SPLIT else 'is'].append(sp)
mom_is = statistics.mean(spread['is'])*100 if spread['is'] else float('nan')
mom_oos = statistics.mean(spread['oos'])*100 if spread['oos'] else float('nan')
findings["families"]["F6_autocorr_momentum"] = {
  "weekly_basket_ar1_is": round(ar_is,3), "weekly_basket_ar1_oos": round(ar_oos,3),
  "ar1_survives": survives(ar_is, ar_oos),
  "momentum_12_1_DECILE_spread_is_pct_mo": round(mom_is,2), "momentum_oos_pct_mo": round(mom_oos,2),
  "n_months_is": len(spread['is']), "n_months_oos": len(spread['oos']),
  "momentum_survives": survives(mom_is, mom_oos)}

out = '/home/karim/claude-a15-20260818/strategy-tournament/track-c-findings-2026-08-25.json'
json.dump(findings, open(out, 'w'), indent=1)
survivors = []
for fam, res in findings["families"].items():
    for it in (res if isinstance(res, list) else [res]):
        if isinstance(it, dict):
            for k, v in it.items():
                if k.endswith("survives") and v is True:
                    survivors.append((fam, it.get('signal_day') or it.get('month') or it.get('pair') or k))
print("SURVIVORS:", survivors, file=sys.stderr)
print(f"wrote {out}", file=sys.stderr)
