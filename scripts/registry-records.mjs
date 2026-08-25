#!/usr/bin/env node
/**
 * Track B — persistent strategy-registry records, schema v1
 * (docs/PREREG_CAMPAIGN_2026-08-25.md). One JSONL record per
 * (strategy, source-digest, universe, timeframe, window) + REGISTRY.md.
 * The graveyard is the point: failures and nulls get records too.
 * Usage: node scripts/registry-records.mjs <runDir> <universeLabel> [--out DIR]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initStats, loadCells, strategyRow } from './lib-tournament-stats.mjs';

const dir = process.argv[2];
const universe = process.argv[3];
if (!dir || !universe) { console.error('usage: registry-records.mjs <runDir> <universeLabel> [--sources roster.json] [--out DIR]'); process.exit(2); }
const srcIdx = process.argv.indexOf('--sources');
/** key -> absolute source path, for recomputing the CRLF-canonical digest the
 * prereg and the attach identity actually use (the manifest stores raw-LF
 * sha1s; labeling those CRLF was wrong — sol pass 17). */
const sourceMap = srcIdx >= 0
  ? Object.fromEntries(JSON.parse(readFileSync(process.argv[srcIdx + 1], 'utf8')).map((r) => [r.key, r.file]))
  : {};
const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(dir, 'registry');
mkdirSync(outDir, { recursive: true });

// Records only from a validated run.
const validation = (() => {
  try { return JSON.parse(execFileSync('node', [join(import.meta.dirname, 'validate-tournament-run.mjs'), dir], { encoding: 'utf8' })); }
  catch (e) { const v = JSON.parse(e.stdout || '{}'); if (v.verdict !== 'QUALIFIED') { console.error(`validator ${v.verdict || 'unparseable'} — no records`); process.exit(1); } return v; }
})();

const manifest = JSON.parse(readFileSync(join(dir, 'run-manifest.json'), 'utf8'));
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
initStats(dir);
const cells = loadCells(dir);
const sha1 = (t) => createHash('sha1').update(t).digest('hex');

/** Verdict per the prereg vocabulary — mechanical, no judgment. */
export function verdictOf(row) {
  // ok===0 splits: cells that RAN and produced zero trades are evidence
  // absence, not unrunnability (sol pass 17).
  if (row.ok === 0) return row.no_trades > 0 ? 'INSUFFICIENT-EVIDENCE' : 'UNRUNNABLE';
  if (row.flags.includes('INSUFFICIENT-EVIDENCE') || row.flags.includes('SPARSE-EDGE-SUBSET') || row.flags.includes('OOS-ONLY')) return 'INSUFFICIENT-EVIDENCE';
  if (row.flags.includes('OVERFIT-SUSPECT')) return 'OVERFIT-SUSPECT';
  if (row.med_is_edge !== null && row.med_is_edge > 0
      && (row.med_oos_edge === null ? false : (row.med_oos_edge > 0 || (row.degradation !== null && row.degradation >= 0)))) return 'WORKS';
  return 'FAILED';
}

const records = [];
const keys = [...new Set(cells.map((c) => c.strategy))];
for (const key of keys) {
  const sc = cells.filter((c) => c.strategy === key);
  const row = strategyRow(key, sc);
  const stratMan = manifest.strategies.find((s) => s.key === key);
  // CRLF-canonical source digest, recomputed from the actual source file —
  // fail CLOSED when unavailable (a made-up digest is worse than none).
  // FAIL CLOSED, whole-run (sol pass 18): a partial registry written with
  // success invites silent gaps; and the mapped file must BE the run's source
  // — its raw sha1 is cross-checked against the manifest's recorded hash.
  if (!sourceMap[key]) { console.error(`ABORT: ${key} has no --sources mapping — no partial registries`); process.exit(1); }
  const srcText = readFileSync(sourceMap[key], 'utf8');
  if (stratMan?.source_sha1 && sha1(srcText) !== stratMan.source_sha1) {
    console.error(`ABORT: ${key}: mapped file ${sourceMap[key]} (raw sha1 ${sha1(srcText).slice(0, 12)}) is not the run's source (manifest ${stratMan.source_sha1.slice(0, 12)})`);
    process.exit(1);
  }
  const crlf = sha1(srcText.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  const digest12 = crlf.slice(0, 12);
  const tf = sc[0]?.timeframe ?? 'na';
  const window = `${(row.coverage_min || 'na').slice(0, 10)}..${(row.coverage_max || 'na').slice(0, 10)}`;
  // Direct comparison of two absolute-EGP fields — net −5 beating B&H −10
  // counts (sol pass 17's exact case).
  const okBH = sc.filter((c) => c.outcome === 'OK' && c.metrics?.buy_hold_return != null && c.metrics?.net_profit != null);
  const beatBH = okBH.length
    ? okBH.filter((c) => c.metrics.net_profit > c.metrics.buy_hold_return).length / okBH.length
    : null;
  records.push({
    registry_id: `${key}@${digest12}#${universe}#${tf}#${window}`,
    date: new Date().toISOString().slice(0, 10),
    family: key.replace(/-[0-9].*$/, ''),
    title: sc[0]?.title ?? null,
    source_sha1_crlf: crlf,
    source_sha1_raw_manifest: stratMan?.source_sha1 ?? null,
    params: 'frozen-published',
    universe, timeframe: sc[0]?.timeframe ?? null,
    window: { start: row.coverage_min, end: row.coverage_max },
    cells: { ok: row.ok, no_trades: row.no_trades, error: row.error },
    metrics: {
      median_net_pct: row.median_net_pct, win_frac: row.profitable_frac,
      med_is_edge_py: row.med_is_edge, n_is_edge: `${row.n_is_edge}/${row.ok}`,
      med_oos_edge_py: row.med_oos_edge, n_oos_edge: `${row.n_oos_edge}/${row.ok}`,
      degradation: row.degradation, med_raw_is_py: row.med_raw_is,
      med_raw_oos_py: row.med_raw_oos, median_trades: row.median_trades,
    },
    incumbent_bars: { beat_bh_cell_frac: beatBH, note: 'vs per-symbol SMA100 approx: see leaderboard bar row' },
    coverage: { min: row.coverage_min, max: row.coverage_max },
    flags: row.flags,
    verdict: verdictOf(row),
    rig: { commit, tv_build: manifest.tv_build, manifest: manifest.manifest_hash },
    run_dir: dir,
    validation: validation.verdict,
  });
}
records.sort((a, b) => (b.metrics.med_is_edge_py ?? -1e9) - (a.metrics.med_is_edge_py ?? -1e9));

writeFileSync(join(outDir, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
const L = ['# TV strategy registry — leaderboard', '',
  `Universe \`${universe}\` · validator **${validation.verdict}** · rig ${commit} · ${new Date().toISOString().slice(0, 10)}`, '',
  '| verdict | strategy | IS edge/yr (n) | OOS edge/yr (n) | degr | net% med | trades med | flags |',
  '|---|---|---|---|---|---|---|---|'];
const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? 'n/a' : (+v).toFixed(d));
for (const r of records) {
  L.push(`| **${r.verdict}** | ${r.registry_id} | ${fmt(r.metrics.med_is_edge_py)} (${r.metrics.n_is_edge}) | ${fmt(r.metrics.med_oos_edge_py)} (${r.metrics.n_oos_edge}) | ${fmt(r.metrics.degradation)} | ${fmt(r.metrics.median_net_pct)} | ${fmt(r.metrics.median_trades, 0)} | ${r.flags.join(' ') || '—'} |`);
}
L.push('', `Evidence denominator: cells with ≥30 trades per family are in each record's metrics; <30 median flags INSUFFICIENT-EVIDENCE.`, '');
writeFileSync(join(outDir, 'REGISTRY.md'), L.join('\n'));
console.log(`registry: ${records.length} records -> ${outDir}`);
