#!/usr/bin/env node
/**
 * Post-hoc integrity validator for a tournament run directory.
 *
 * Purpose: a run executed under an OLDER harness can still be trusted IF the
 * signals the newer guards check in-run are verifiable from its recorded
 * cells. This applies the pass-8/9 checks retroactively:
 *   V1 cross-cell duplicate quote prices (incl. cached cells) — 08-18 signature
 *   V2 NO_TRADES cells must carry a computed buy_hold_return
 *   V3 every OK cell: attach digest present, entity binding recorded,
 *      resolution landed = requested, all three screenshots exist on disk
 *   V4 per-strategy G1 clone fingerprints over OK cells (recomputed)
 *   V5 adjacent-cell frozen-bar heuristic: consecutive cells (by started_at)
 *      for different symbols must not share quote_last
 *   V6 saved-script inventory before == after (id+version)
 * Usage: node scripts/validate-tournament-run.mjs <runDir>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkResultIntegrity, bhOwnershipOk } from './backtest-tournament.mjs';

const dir = process.argv[2];
if (!dir) { console.error('usage: validate-tournament-run.mjs <runDir>'); process.exit(2); }
const cells = readdirSync(join(dir, 'cells')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, 'cells', f), 'utf8')));
const fails = [];
const warn = [];

// V1 (global) — pass-20 semantics, TWO-PASS (sol pass 22: streaming evaluation
// was order-dependent; collision softening must consider every cell of both
// symbols at a price, so evidence is aggregated first, judged second).
// Failure classes: identical completed-bar tail across symbols; a cross-symbol
// price collision where EITHER symbol has ANY tail-less cell at that price.
// Only all-tails-on-both-sides collisions soften to piastre warnings.
const byTail = new Map();
for (const c of cells) {
  if (c.last_bar == null) continue;
  const towner = byTail.get(c.last_bar);
  if (towner && towner !== c.symbol) fails.push(`V1 identical completed-bar tail: ${c.symbol} and ${towner}`);
  else byTail.set(c.last_bar, c.symbol);
}
const priceMap = new Map(); // price -> Map(symbol -> allCellsHaveTail)
for (const c of cells) {
  if (c.quote_last == null) continue;
  if (!priceMap.has(c.quote_last)) priceMap.set(c.quote_last, new Map());
  const m = priceMap.get(c.quote_last);
  m.set(c.symbol, (m.get(c.symbol) ?? true) && c.last_bar != null);
}
for (const [price, m] of priceMap) {
  if (m.size < 2) continue;
  const syms = [...m.entries()];
  const weak = syms.filter(([, hasTail]) => !hasTail).map(([sym]) => sym);
  if (weak.length) fails.push(`V1 duplicate price ${price}: ${syms.map(([sym]) => sym).join(' / ')} (tail evidence missing on ${weak.join(', ')})`);
  else warn.push(`V1 price collision ${price}: ${syms.map(([sym]) => sym).join(' / ')} — piastre quantization (all tails present and distinct)`);
}

// V2
for (const c of cells) {
  if (c.outcome === 'NO_TRADES' && (c.metrics?.buy_hold_return === null || c.metrics?.buy_hold_return === undefined)) {
    fails.push(`V2 ${c.strategy}/${c.symbol}: NO_TRADES without computed buy_hold_return`);
  }
}
// V3
for (const c of cells) {
  if (c.outcome !== 'OK') continue;
  if (!c.attach?.pine_digest) fails.push(`V3 ${c.strategy}/${c.symbol}: no attach digest`);
  if (!c.report_entity_id || c.report_entity_id !== c.attach?.entity_id) fails.push(`V3 ${c.strategy}/${c.symbol}: report/attach entity mismatch`);
  const norm = (tf) => { const t = String(tf || '').toUpperCase(); return t === 'D' ? '1D' : t; };
  if (norm(c.resolution_landed) !== norm(c.timeframe)) fails.push(`V3 ${c.strategy}/${c.symbol}: landed ${c.resolution_landed} != requested ${c.timeframe}`);
  for (const p of [c.attach?.screenshot_before, c.attach?.screenshot_after, c.screenshot_report]) {
    if (typeof p !== 'string' || !existsSync(p)) { fails.push(`V3 ${c.strategy}/${c.symbol}: missing evidence screenshot`); break; }
  }
}
// V4
const byStrat = new Map();
for (const c of cells) { if (!byStrat.has(c.strategy)) byStrat.set(c.strategy, []); byStrat.get(c.strategy).push(c); }
for (const [key, list] of byStrat) {
  const g1 = checkResultIntegrity(list.filter((c) => c.outcome === 'OK').map((c) => ({ symbol: c.symbol, metrics: c.metrics })));
  if (!g1.ok) fails.push(`V4 ${key}: clone fingerprints ${JSON.stringify(g1.clones)}`);
}
// V5
const ordered = [...cells].filter((c) => c.quote_last != null).sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
for (let i = 1; i < ordered.length; i++) {
  if (ordered[i].symbol !== ordered[i - 1].symbol && ordered[i].quote_last === ordered[i - 1].quote_last) {
    fails.push(`V5 consecutive cells share price ${ordered[i].quote_last}: ${ordered[i - 1].symbol} -> ${ordered[i].symbol}`);
  }
}
// V6 — UNVERIFIABLE IS FAIL (pass 10): a run whose inventory cannot be
// checked must not be machine-qualified.
try {
  const before = readFileSync(join(dir, 'saved-scripts-before.json'), 'utf8');
  const after = readFileSync(join(dir, 'saved-scripts-after.json'), 'utf8');
  if (before !== after) fails.push('V6 saved-script inventory changed during the run');
} catch { fails.push('V6 inventory snapshots incomplete — inventory unverifiable, run not qualifiable'); }

// V7 — B&H vs raw reference, WARNING-level: TV's adjusted B&H legitimately
// drifts 2-3x from the raw reference on dividend-heavy names (ABUK measured
// 2.67x while the series fingerprint proved true ownership). A ratio outside
// [0.25, 4] is still suspicious enough to warn loudly; ownership proper is
// the in-run series fingerprint (new runs) plus V1/V5 dedupe and the in-run
// price band (this run).
for (const c of cells) {
  if (c.outcome !== 'OK' || String(c.timeframe).toUpperCase() !== '1D') continue;
  const bare = String(c.symbol).split(':').pop();
  const own = bhOwnershipOk(bare, c.metrics?.buy_hold_return);
  if (own !== null && own !== true && (own.ratio < 0.25 || own.ratio > 4)) {
    warn.push(`V7 ${c.strategy}/${c.symbol}: TV B&H ${own.tv_bh_pct.toFixed(0)}% vs raw ref ${own.ref_bh_pct.toFixed(0)}% (ratio ${own.ratio.toFixed(2)}) — corroborate ownership`);
  }
}

// V8 — manifest PROVENANCE (pass 12: 85 cells predated the fingerprint/tuple
// stack yet the validator said an unqualified PASS). Cells are grouped by the
// harness manifest they ran under; a mixed run is never a plain PASS — it is
// QUALIFIED, and the segments must be disclosed wherever results are used.
let currentManifest = null;
try { currentManifest = JSON.parse(readFileSync(join(dir, 'run-manifest.json'), 'utf8')).manifest_hash; } catch { /* absent */ }
const segments = {};
for (const c of cells) {
  const h = c.manifest_hash || '(none)';
  segments[h] = (segments[h] || 0) + 1;
}
const segmentKeys = Object.keys(segments);
const mixed = segmentKeys.length > 1 || (currentManifest && !segments[currentManifest]);
if (mixed) {
  warn.push(`V8 mixed provenance: ${segmentKeys.map((k) => `${k.slice(0, 12)}×${segments[k]}`).join(', ')} (run-manifest ${currentManifest ? currentManifest.slice(0, 12) : 'missing'}) — segments ran under DIFFERENT guard stacks; disclose per-segment guarantees. Inventory snapshots cover only the LAST segment; earlier segments' own runs each reported inventory unchanged in their logs.`);
}

// V9 — COMPLETENESS (sol pass 17): every strategy×symbol pair in the run
// manifest must have a cell on disk; an aborted partial run must not be
// certifiable, and an empty run must not QUALIFY.
try {
  const man = JSON.parse(readFileSync(join(dir, 'run-manifest.json'), 'utf8'));
  const have = new Set(cells.map((c) => `${c.strategy}__${String(c.symbol).split(':').pop()}`));
  const missing = [];
  for (const st of man.strategies || []) {
    for (const sym of st.symbols || []) {
      if (!have.has(`${st.key}__${sym}`)) missing.push(`${st.key}__${sym}`);
    }
  }
  if (missing.length) fails.push(`V9 incomplete run: ${missing.length} manifest cells missing (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''})`);
  if (!cells.length) fails.push('V9 empty run: no cells at all');
} catch { fails.push('V9 run-manifest unreadable — completeness unverifiable'); }

const okCells = cells.filter((c) => c.outcome === 'OK').length;
const verdict = fails.length ? 'FAIL' : (mixed ? 'QUALIFIED' : 'PASS');
console.log(JSON.stringify({
  run: dir, cells: cells.length, ok: okCells,
  no_trades: cells.filter((c) => c.outcome === 'NO_TRADES').length,
  error: cells.filter((c) => c.outcome === 'ERROR').length,
  provenance_segments: segments,
  verdict, failures: fails, warnings: warn,
}, null, 2));
process.exit(fails.length ? 1 : 0);
