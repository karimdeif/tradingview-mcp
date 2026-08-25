/** Shared tournament statistics — used by tournament-report.mjs and
 * registry-records.mjs so the leaderboard and the registry cannot drift.
 * Extracted verbatim from tournament-report.mjs (sol-reviewed lineage). */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const SPLIT_MS = Date.UTC(2022, 0, 1);
export const CAPITAL = 100000;

/**
 * The reference series MUST be the one the run was recorded against — the
 * wrong file silently reshapes edges, denominators, flags and verdicts (sol
 * pass 17). initStats(runDir) loads the file named by TV_REF_DATA (or the
 * legacy default) and REFUSES to proceed unless its sha1 matches the run
 * manifest's reference_closes_sha1 (when the manifest carries one).
 */
let REF = null;
export function initStats(runDir) {
  const path = process.env.TV_REF_DATA || '/home/karim/claude-a15-20260818/pine-audit/data/daily_deep.json';
  const raw = readFileSync(path, 'utf8');
  try {
    const man = JSON.parse(readFileSync(join(runDir, 'run-manifest.json'), 'utf8'));
    if (man.reference_closes_sha1) {
      const got = createHash('sha1').update(raw).digest('hex');
      if (got !== man.reference_closes_sha1) {
        throw new Error(`reference file ${path} (sha1 ${got.slice(0, 12)}) does not match the run manifest's reference ${man.reference_closes_sha1.slice(0, 12)} — set TV_REF_DATA to the file the run used`);
      }
    }
  } catch (e) { if (String(e.message).includes('does not match')) throw e; /* no manifest = legacy run, proceed */ }
  REF = JSON.parse(raw);
  return REF;
}
function ref() { if (!REF) throw new Error('initStats(runDir) must be called before any stats computation'); return REF; }

export function refCloseAt(sym, ms) {
  const bars = ref()[sym];
  if (!bars) return null;
  let best = null;
  for (const b of bars) { if (b[0] * 1000 <= ms) best = b[4]; else break; }
  return best;
}
export function refBH(sym, t0, t1) {
  const c0 = refCloseAt(sym, t0);
  const c1 = refCloseAt(sym, t1);
  return c0 && c1 ? c1 / c0 - 1 : null;
}
export const yrs = (t0, t1) => Math.max((t1 - t0) / (365.25 * 86400e3), 1 / 365);
export const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[s.length >> 1] + s[(s.length - 1) >> 1]) / 2 : null; };

export function splitCell(c) {
  const trades = c.trades || [];
  const bare = String(c.symbol).split(':').pop();
  const windows = { is: { t0: null, t1: null, profit: 0, n: 0 }, oos: { t0: null, t1: null, profit: 0, n: 0 } };
  for (const t of trades) {
    if (t.exit_time == null || t.profit == null) continue;
    const w = t.exit_time < SPLIT_MS ? windows.is : windows.oos;
    w.profit += t.profit; w.n += 1;
    const start = t.entry_time ?? t.exit_time;
    if (w.t0 === null || start < w.t0) w.t0 = start;
    if (w.t1 === null || t.exit_time > w.t1) w.t1 = t.exit_time;
  }
  const posSum = { is: 0, oos: 0 };
  for (const t of trades) {
    if (t.exit_time == null || t.profit_pct == null) continue;
    posSum[t.exit_time < SPLIT_MS ? 'is' : 'oos'] += t.profit_pct;
  }
  const out = {};
  for (const k of ['is', 'oos']) {
    const w = windows[k];
    if (!w.n) { out[k] = null; continue; }
    const stratR = w.profit / CAPITAL;
    const bh = refBH(bare, w.t0, w.t1);
    out[k] = {
      n: w.n, years: yrs(w.t0, w.t1), strat_pct: stratR * 100,
      pos_return_pct: posSum[k] * 100,
      bh_pct: bh === null ? null : bh * 100,
      edge_per_year: bh === null ? null : ((posSum[k] - bh) / yrs(w.t0, w.t1)) * 100,
      raw_per_year: (posSum[k] / yrs(w.t0, w.t1)) * 100,
    };
  }
  return out;
}

export function loadCells(dir) {
  return readdirSync(join(dir, 'cells')).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, 'cells', f), 'utf8')));
}

/** Per-strategy row stats — the same numbers the report table carries. */
export function strategyRow(key, sc) {
  const ok = sc.filter((c) => c.outcome === 'OK');
  const splits = ok.map((c) => ({ symbol: c.symbol, coverage: c.coverage, metrics: c.metrics, ...splitCell(c) }));
  const isEdges = splits.map((s) => s.is?.edge_per_year).filter((v) => v !== null && v !== undefined);
  const oosEdges = splits.map((s) => s.oos?.edge_per_year).filter((v) => v !== null && v !== undefined);
  const netPcts = ok.map((c) => (c.metrics?.net_profit_percent ?? 0) * 100);
  const trades = ok.map((c) => c.metrics?.total_trades ?? 0);
  const medIS = median(isEdges); const medOOS = median(oosEdges);
  const flags = [];
  if (median(trades) !== null && median(trades) < 30) flags.push('INSUFFICIENT-EVIDENCE');
  if (isEdges.length === 0 && oosEdges.length > 0) flags.push('OOS-ONLY');
  if (medIS !== null && medOOS !== null && medIS > 0 && medOOS < 0) flags.push('OVERFIT-SUSPECT');
  if (ok.length > 0 && isEdges.length > 0 && isEdges.length < 0.7 * ok.length) flags.push('SPARSE-EDGE-SUBSET');
  return {
    key, cells: sc.length, ok: ok.length,
    no_trades: sc.filter((c) => c.outcome === 'NO_TRADES').length,
    error: sc.filter((c) => c.outcome === 'ERROR').length,
    median_net_pct: median(netPcts), median_trades: median(trades),
    profitable_frac: ok.length ? ok.filter((c) => (c.metrics?.net_profit_percent ?? 0) > 0).length / ok.length : null,
    med_is_edge: medIS, n_is_edge: isEdges.length, med_oos_edge: medOOS, n_oos_edge: oosEdges.length,
    degradation: medIS !== null && medOOS !== null && medIS > 0 ? medOOS / medIS : null,
    med_raw_is: median(splits.map((s) => s.is?.raw_per_year).filter((v) => v != null)),
    med_raw_oos: median(splits.map((s) => s.oos?.raw_per_year).filter((v) => v != null)),
    coverage_min: ok.map((c) => c.coverage?.first_entry_iso).filter(Boolean).sort()[0] ?? null,
    coverage_max: ok.map((c) => c.coverage?.last_exit_iso).filter(Boolean).sort().at(-1) ?? null,
    flags, splits,
  };
}
