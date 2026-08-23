#!/usr/bin/env node
/**
 * Tournament comparison report (docs/ANTI_OVERFITTING_PROTOCOL.md P1-P7).
 * Usage: node scripts/tournament-report.mjs <runDir> [--force-unvalidated]
 *
 * Refuses to write a report unless validate-tournament-run.mjs PASSES.
 * IS/OOS split at 2022-01-01; headline degradation is B&H-RELATIVE per year.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SPLIT_MS = Date.UTC(2022, 0, 1);
const CAPITAL = 100000;
const REF = JSON.parse(readFileSync('/home/karim/claude-a15-20260818/pine-audit/data/daily_deep.json', 'utf8'));

const dir = process.argv[2];
if (!dir) { console.error('usage: tournament-report.mjs <runDir>'); process.exit(2); }

// Gate on the validator — the report must never be built from an unqualified run.
let validation;
try {
  validation = JSON.parse(execFileSync('node', [join(import.meta.dirname, 'validate-tournament-run.mjs'), dir], { encoding: 'utf8' }));
} catch (e) {
  validation = JSON.parse(e.stdout || '{}');
  if (!process.argv.includes('--force-unvalidated')) {
    console.error(`VALIDATOR FAILED — no report. Failures:\n${(validation.failures || ['(unparseable)']).join('\n')}`);
    process.exit(1);
  }
}

const cells = readdirSync(join(dir, 'cells')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, 'cells', f), 'utf8')));

/** Reference close at-or-before a UTC ms timestamp. */
function refCloseAt(sym, ms) {
  const bars = REF[sym];
  if (!bars) return null;
  let best = null;
  for (const b of bars) { if (b[0] * 1000 <= ms) best = b[4]; else break; }
  return best;
}
function refBH(sym, t0, t1) {
  const c0 = refCloseAt(sym, t0);
  const c1 = refCloseAt(sym, t1);
  return c0 && c1 ? c1 / c0 - 1 : null;
}
const yrs = (t0, t1) => Math.max((t1 - t0) / (365.25 * 86400e3), 1 / 365);

/** Per-cell IS/OOS: strategy return (sum profit / capital) minus window B&H, per year. */
function splitCell(c) {
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
  // Sum of per-trade POSITION returns per window (tp.p — return on the
  // position itself, independent of the strategy's declared sizing).
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
    // METRIC v2 (unit bug fixed before any ranking was consumed; v1 in git):
    // the edge compares LIKE WITH LIKE — per-trade POSITION returns (sizing-
    // independent timing skill) against the window's B&H, both per year.
    // Portfolio-sized returns divided by fully-invested B&H measured only
    // "how much of the account sat out of a bull market".
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

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[s.length >> 1] + s[(s.length - 1) >> 1]) / 2 : null; };
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? 'n/a' : v.toFixed(d));

const strategies = [...new Set(cells.map((c) => c.strategy))];
const rows = [];
for (const key of strategies) {
  const sc = cells.filter((c) => c.strategy === key);
  const ok = sc.filter((c) => c.outcome === 'OK');
  const splits = ok.map((c) => ({ symbol: c.symbol, coverage: c.coverage, metrics: c.metrics, ...splitCell(c) }));
  const isEdges = splits.map((s) => s.is?.edge_per_year).filter((v) => v !== null && v !== undefined);
  const oosEdges = splits.map((s) => s.oos?.edge_per_year).filter((v) => v !== null && v !== undefined);
  const netPcts = ok.map((c) => (c.metrics?.net_profit_percent ?? 0) * 100);
  const trades = ok.map((c) => c.metrics?.total_trades ?? 0);
  const medIS = median(isEdges); const medOOS = median(oosEdges);
  const flags = [];
  if (median(trades) !== null && median(trades) < 30) flags.push('INSUFFICIENT-EVIDENCE');
  // The edge median is over EDGE-BEARING cells only; a small favorable subset
  // must not pose as breadth (pass 12). Denominators are shown per row, and
  // fewer than 70% of OK cells bearing an IS edge disqualifies from ranking.
  if (ok.length > 0 && isEdges.length > 0 && isEdges.length < 0.7 * ok.length) flags.push('SPARSE-EDGE-SUBSET');
  if (isEdges.length === 0 && oosEdges.length > 0) flags.push('OOS-ONLY');
  if (medIS !== null && medOOS !== null && medIS > 0 && medOOS < 0) flags.push('OVERFIT-SUSPECT');
  const src = sc[0];
  rows.push({
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
    flags, note: src?.note ?? null, source_patch: src?.source_patch ?? null, splits,
  });
}

// Ranking: daily breadth strategies only, by median IS B&H-relative edge (P2/P3).
const rankable = rows.filter((r) => !r.flags.includes('OOS-ONLY') && !r.flags.includes('INSUFFICIENT-EVIDENCE')
  && !r.flags.includes('SPARSE-EDGE-SUBSET')
  && r.ok >= 5 && r.med_is_edge !== null && r.key !== 'baseline-sma100');
rankable.sort((a, b) => b.med_is_edge - a.med_is_edge);

const L = [];
L.push('# EGX Strategy Tournament — comparison report');
L.push('');
L.push(`Run: \`${dir}\` · ${cells.length} cells · validator: **${validation.verdict}**${validation.warnings?.length ? ` (warnings: ${validation.warnings.join('; ')})` : ''}`);
// The provenance block is gated on the VERDICT, not on segment count: a
// single segment that mismatches run-manifest.json is also QUALIFIED and
// must be disclosed (pass 13).
if (validation.verdict === 'QUALIFIED' && validation.provenance_segments) {
  let currentManifest = null;
  try { currentManifest = JSON.parse(readFileSync(join(dir, 'run-manifest.json'), 'utf8')).manifest_hash; } catch { /* absent */ }
  L.push('');
  L.push('**Provenance (disclosed per protocol):** the validator returned QUALIFIED — cells were not all produced under the run manifest\'s harness version, so guard stacks differ per segment:');
  for (const [h, n] of Object.entries(validation.provenance_segments)) {
    const isCurrent = currentManifest && h === currentManifest;
    L.push(`- manifest \`${h.slice(0, 12)}\`: ${n} cells — ${isCurrent ? 'CURRENT harness (full in-run guard stack)' : 'EARLIER harness; qualified post-hoc by V1–V5 plus the in-run guards that version carried (see git history for that manifest\'s guard set)'}`);
  }
  L.push(`- run-manifest: \`${currentManifest ? currentManifest.slice(0, 12) : 'missing'}\`. Inventory snapshots cover only the final segment; earlier segments' own run logs each reported the inventory unchanged.`);
}
L.push('');
L.push('## Page 1 — the incumbent, and the honest caveats');
L.push('');
L.push('| row | Sharpe | return/yr | max DD | basis |');
L.push('|---|---|---|---|---|');
L.push('| **Incumbent: SMA100-gate N=80 basket (LIVE)** | ≈1.14 | ≈19%/yr | ≈−33% | live-clock numbers, NOT a backtest |');
const base = rows.find((r) => r.key === 'baseline-sma100');
if (base && base.ok > 0) {
  L.push(`| Per-symbol SMA100 approx (backtest, NOT the basket) | — | median net ${fmt(base.median_net_pct)}% (full period) | — | identical TV path as every row below |`);
} else {
  L.push('| Per-symbol SMA100 approx | — | (cells pending/errored) | — | identical TV path |');
}
L.push('');
L.push('- Live-clock and backtest numbers answer different questions; never compare them cell-to-cell.');
L.push('- The 20-name symbol set is today\'s liquid survivors — every backtest here inherits survivorship shine.');
L.push('- **The OOS window (2022→) is a single macro-regime** (float shocks → 2024-26 bull): survival is necessary evidence, not sufficient. The genuinely unseen test is the bar-replay forward-walk for the finalists.');
L.push('- Headline degradation is **B&H-relative per year**: per-trade POSITION returns (sizing-independent) minus window B&H, per year; raw position-return/yr sits beside it. Metric v2 — v1 compared portfolio-sized returns to fully-invested B&H, a unit mismatch fixed before any ranking was consumed (v1 preserved in git history). Parameters were never tuned (P1); ranking uses IS only (P2); scores are medians across symbols (P3).');
L.push('');
L.push('## Ranking — daily breadth strategies (by median IS edge vs B&H, %/yr)');
L.push('');
L.push('| rank | strategy | cells OK | median net (full) | win frac | IS edge/yr (n) | OOS edge/yr (n) | degradation | raw IS/yr | raw OOS/yr | median trades | coverage | flags |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
rows.sort((a, b) => (b.med_is_edge ?? -1e9) - (a.med_is_edge ?? -1e9));
let rank = 0;
for (const r of rows) {
  const ranked = rankable.includes(r);
  const label = r.key === 'baseline-sma100' ? 'baseline' : (ranked ? String(++rank) : '—');
  L.push(`| ${label} | ${r.key} | ${r.ok}/${r.cells} | ${fmt(r.median_net_pct)}% | ${fmt(r.profitable_frac === null ? null : r.profitable_frac * 100, 0)}% | ${fmt(r.med_is_edge)} (${r.n_is_edge ?? 0}/${r.ok}) | ${fmt(r.med_oos_edge)} (${r.n_oos_edge ?? 0}/${r.ok}) | ${fmt(r.degradation)} | ${fmt(r.med_raw_is)} | ${fmt(r.med_raw_oos)} | ${fmt(r.median_trades, 0)} | ${r.coverage_min?.slice(0, 10) ?? 'n/a'} → ${r.coverage_max?.slice(0, 10) ?? 'n/a'} | ${r.flags.join(' ') || '—'} |`);
}
L.push('');
L.push('Unranked rows: OOS-ONLY (no in-sample trades — intraday depth), INSUFFICIENT-EVIDENCE (median <30 trades), errors, or the baseline.');
L.push('');
L.push('## Per-strategy cell detail');
for (const r of rows) {
  L.push('');
  L.push(`### ${r.key}${r.note ? ` — ${r.note}` : ''}`);
  if (r.source_patch) L.push(`> source_patch: \`${r.source_patch}\``);
  if (r.error) L.push(`> ${r.error} ERROR cell(s) — excluded, listed in the run directory.`);
  if (r.no_trades) L.push(`> ${r.no_trades} NO_TRADES cell(s) — computed reports with zero round trips.`);
  L.push('');
  L.push('| symbol | net% (full) | trades | maxDD% | B&H% (full) | IS edge/yr | OOS edge/yr | coverage |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const s of r.splits.sort((a, b) => (b.is?.edge_per_year ?? -1e9) - (a.is?.edge_per_year ?? -1e9))) {
    const m = s.metrics || {};
    L.push(`| ${String(s.symbol).split(':').pop()} | ${fmt((m.net_profit_percent ?? 0) * 100)} | ${m.total_trades ?? 'n/a'} | ${fmt((m.max_drawdown_percent ?? 0) * 100)} | ${fmt(m.buy_hold_return != null ? m.buy_hold_return / CAPITAL * 100 : null, 0)} | ${fmt(s.is?.edge_per_year)} | ${fmt(s.oos?.edge_per_year)} | ${s.coverage?.first_entry_iso?.slice(0, 10) ?? '—'} → ${s.coverage?.last_exit_iso?.slice(0, 10) ?? '—'} |`);
  }
}
L.push('');
L.push('---');
L.push(`Protocol: docs/ANTI_OVERFITTING_PROTOCOL.md (P1–P7). G4 cross-engine reference: pine-audit/backtest-output.txt. Generated ${new Date().toISOString()}.`);

const out = join(dir, 'TOURNAMENT_REPORT.md');
writeFileSync(out, L.join('\n'));
console.log(`report: ${out} (${rows.length} strategies, ${rankable.length} ranked)`);
