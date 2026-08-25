#!/usr/bin/env node
/**
 * Tournament comparison report (docs/ANTI_OVERFITTING_PROTOCOL.md P1-P7).
 * Usage: node scripts/tournament-report.mjs <runDir> [--force-unvalidated]
 *
 * Refuses to write a report unless validate-tournament-run.mjs PASSES.
 * IS/OOS split at 2022-01-01; headline degradation is B&H-RELATIVE per year.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStats, loadCells, strategyRow, CAPITAL } from './lib-tournament-stats.mjs';

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

initStats(dir);
const cells = loadCells(dir);

const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? 'n/a' : v.toFixed(d));

const strategies = [...new Set(cells.map((c) => c.strategy))];
const rows = [];
for (const key of strategies) {
  const sc = cells.filter((c) => c.strategy === key);
  const src = sc[0];
  rows.push({ ...strategyRow(key, sc), note: src?.note ?? null, source_patch: src?.source_patch ?? null });
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
