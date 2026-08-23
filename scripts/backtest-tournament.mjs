#!/usr/bin/env node
/**
 * EGX strategy tournament harness (phase 3 of docs/STRATEGY_BACKTEST_PLAN.md).
 *
 * Runs karim's 7 strategy() scripts + the SMA100-gate baseline through the
 * live TradingView Strategy Tester, one (strategy, symbol) cell at a time,
 * STRICTLY SERIAL (one session per account — estate law 1).
 *
 * Usage:
 *   node scripts/backtest-tournament.mjs [--out DIR] [--only strategyKey] [--dry]
 *
 * Integrity model (docs/STRATEGY_BACKTEST_PLAN.md §5, plus review outcomes):
 *   - replay + blocking-modal guards re-checked after EVERY symbol switch;
 *   - saved-script id+version inventory diffed before and after the whole run
 *     (sol-max pass-5 recommendation — count alone cannot see an overwrite);
 *   - per-strategy G1 clone-fingerprint check across symbols (the 08-18
 *     frozen-feed shape) — checkResultIntegrity lands HERE, called for real;
 *   - NO_TRADES is a loud outcome, never a 0% row;
 *   - metrics are FRACTIONS (net_profit_percent 0.006 = 0.60%);
 *     buy_hold_return is ABSOLUTE currency;
 *   - every cell stores its coverage window (epoch-ms trade bounds) and
 *     screenshots; resumable — existing cell JSONs are skipped.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

const R = new URL('../src/', import.meta.url).pathname;
const chart = await import(join(R, 'core/chart.js'));
const pine = await import(join(R, 'core/pine.js'));
const data = await import(join(R, 'core/data.js'));
const bt = await import(join(R, 'core/backtest.js'));
const cap = await import(join(R, 'core/capture.js'));
const { evaluate, evaluateAsync, disconnect } = await import(join(R, 'connection.js'));

const SRC_DIR = '/home/karim/claude-a15-20260818/pine-audit/sources';

/**
 * Daily set: the 20 EGX names already used by pine-audit/backtest.mjs, so the
 * G4 cross-engine columns line up. Intraday subset: >=100M EGP average daily
 * turnover over the last 60 sessions (computed 2026-08-23 from
 * pine-audit/data/daily_deep.json; natural break at ETEL 100M -> MFPC 89M).
 */
const DAILY_SYMBOLS = ['COMI', 'ABUK', 'EAST', 'HRHO', 'TMGH', 'ETEL', 'FWRY', 'EGAL', 'ORAS', 'ISPH',
  'SWDY', 'MFPC', 'ALCN', 'CLHO', 'SKPC', 'AMOC', 'EFID', 'JUFO', 'ORWE', 'ARCC'];
const INTRADAY_SYMBOLS = ['COMI', 'TMGH', 'ORAS', 'FWRY', 'ABUK', 'ISPH', 'HRHO', 'ETEL'];

/**
 * PER-SYMBOL SMA100 APPROXIMATION — NOT THE BASKET STRATEGY.
 *
 * The real incumbent is an equal-weight N=80 basket whose gate is index/
 * breadth-level, with exactly-N membership, rank-ordered fills and capital
 * rules; its evidence base is the S-01..S-22 study registry on msi, and
 * basket-vs-challenger comparisons run in the estate's own engine against
 * QuestDB, never in the Strategy Tester. This row exists ONLY as a fair
 * per-symbol column against the other tournament rows through the identical
 * TV path. The report must never read as "the incumbent was backtested in TV".
 */
const BASELINE_PINE = `//@version=6
strategy("SMA100 Per-Symbol Approx (NOT the basket)", overlay=true, initial_capital=100000, currency=currency.EGP, commission_type=strategy.commission.percent, commission_value=0.10, pyramiding=0, process_orders_on_close=false, max_bars_back=200)
sma100 = ta.sma(close, 100)
longNow = close > sma100
exitNow = close < sma100
if longNow[1] and strategy.position_size == 0
    strategy.entry("Gate", strategy.long)
if exitNow[1] and strategy.position_size > 0
    strategy.close("Gate")
plot(sma100, "SMA100")
`;

/**
 * sigOnly note: WKOL ships input.bool(true, "Signals only (no orders)") — it
 * produces ZERO orders as published, and indicator_set_inputs fails silently
 * on this build (memory: tradingview-mcp-gotchas). The injected copy flips
 * that one DEFAULT so the strategy actually trades; recorded per cell as
 * source_patch. Nothing else in any source is modified.
 */
const STRATEGIES = [
  { key: 'golden-cross', file: 'EMA20_SMA50_SMA200_Cross.pine', timeframe: '1D', symbols: DAILY_SYMBOLS, xengine: 'Golden Cross (SMA50/200)' },
  { key: 'pro-stack', file: 'EGX_Pro_Stack_Strategy_No_Look_Ahead_.pine', timeframe: '1D', symbols: DAILY_SYMBOLS, xengine: 'EGX Pro Stack' },
  { key: 'conservative', file: 'Conservative_Structure-Based_Long_Strategy.pine', timeframe: '1D', symbols: DAILY_SYMBOLS, note: 'Named "100-Tick"; run on 1D as the closest available chart — flagged, not hidden.' },
  { key: 'abuk-1m', file: 'ABUK_1m_Long_Only_SMA_70_250_.pine', timeframe: '1', symbols: ['ABUK'], note: 'Source hard-locks execution to EGX:ABUK (active = isSymbolOK && isTfOK) — other symbols are disabled by construction, so only ABUK is run (sol-max pass 7).' },
  { key: 'wkol-3m', file: 'WKOL_3m_VWAP_Reversion_B_.pine', timeframe: '3', symbols: INTRADAY_SYMBOLS, patch: { from: 'input.bool(true, "Signals only (no orders)")', to: 'input.bool(false, "Signals only (no orders)")' } },
  { key: 'orhd-5m', file: 'ORHD-VWAP_Bounce_Selective_Long_Only_5_min_partial_TP_day_range_filter_.pine', timeframe: '5', symbols: INTRADAY_SYMBOLS },
  { key: 'orhd-5m-copy', file: 'ORHD-VWAP_Bounce_Selective_Long_Only_5_min_partial_TP_day_range_filter_copy.pine', timeframe: '5', symbols: INTRADAY_SYMBOLS },
  { key: 'baseline-sma100', inline: BASELINE_PINE, timeframe: '1D', symbols: DAILY_SYMBOLS, note: 'Per-symbol SMA100 approximation — NOT the basket strategy. The incumbent N=80 basket is gated at index/breadth level; its numbers come from the live clock and the estate engine, not from TV.' },
];

/** First string argument of strategy(...) — positional or title= — is the exact study name. */
export function parseStrategyTitle(source) {
  const m = source.match(/strategy\s*\(\s*(?:title\s*=\s*)?"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : null;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function savedScriptInventory() {
  return evaluateAsync(`
    window.TradingViewApi._pineEditorApi.listSavedScripts().then(function(list){
      return list.map(function(x){ return { id: x.scriptIdPart || x.id || null, ver: x.version || null }; })
                 .sort(function(a,b){ return String(a.id).localeCompare(String(b.id)); });
    })
  `);
}

async function guardsClear(stage) {
  const modal = await bt.detectBlockingModal();
  if (modal.blocked) return { ok: false, error: `[${stage}] blocking modal: ${modal.modal_text}` };
  const replay = await bt.checkReplayState();
  if (replay.replay_active !== false) return { ok: false, error: `[${stage}] replay state not clear: ${JSON.stringify(replay)}` };
  return { ok: true };
}

/** '1D' and 'D' are the same resolution; intraday numerics compare directly. */
export const normTf = (tf) => {
  const t = String(tf || '').toUpperCase();
  return t === 'D' ? '1D' : t;
};

async function setContextVerified(symbol, timeframe) {
  await chart.setSymbol({ symbol });
  await delay(4000);
  await chart.setTimeframe({ timeframe });
  await delay(3000);
  // Guards RE-CHECKED after the switch: replay has been seen ACTIVATING on a
  // symbol change with isReplayStarted() false beforehand (2026-08-23).
  const g = await guardsClear(`after ${symbol}@${timeframe}`);
  if (!g.ok) return g;
  const st = await chart.getState();
  // EXACT symbol match — substring matching accepted stale charts (pass 7).
  if (String(st.symbol || '').toUpperCase() !== symbol.toUpperCase()) {
    return { ok: false, error: `symbol did not land: wanted ${symbol}, chart shows ${st.symbol}` };
  }
  // The REQUESTED timeframe must be what actually landed — setTimeframe()
  // reports success even when readiness is false (pass 7).
  if (normTf(st.resolution) !== normTf(timeframe)) {
    return { ok: false, error: `timeframe did not land: wanted ${timeframe}, chart shows ${st.resolution}` };
  }
  let quote = null;
  for (let i = 0; i < 8; i++) {
    try { quote = await data.getQuote({}); if (quote && (quote.last ?? quote.price) != null) break; } catch { /* retry */ }
    await delay(2500);
  }
  if (!quote || (quote.last ?? quote.price) == null) return { ok: false, error: `quote never loaded for ${symbol}` };
  // A MISSING quote symbol is a failure, not a pass (pass 7).
  if (String(quote.symbol || '').toUpperCase() !== symbol.toUpperCase()) {
    return { ok: false, error: `quote is for ${quote.symbol ?? '(none)'}, not ${symbol} — stale chart` };
  }
  return { ok: true, last: quote.last ?? quote.price, resolution: st.resolution };
}

export function cellOutcome(results) {
  const m = results?.metrics || {};
  if (!results?.success) return 'ERROR';
  if ((m.total_trades ?? 0) === 0) return 'NO_TRADES';
  return 'OK';
}

async function runCell({ strat, symbol, source, title, outDir, manifestHash }) {
  const cellPath = join(outDir, 'cells', `${strat.key}__${symbol}.json`);
  // A cached cell is trusted ONLY if it succeeded under the SAME manifest —
  // a config change (patch, symbols, timeframe, source edit, harness edit,
  // TV build) must invalidate it, and ERROR/NO_TRADES cells are retried
  // (sol-max pass 7).
  if (existsSync(cellPath)) {
    try {
      const cached = JSON.parse(readFileSync(cellPath, 'utf8'));
      if (cached.manifest_hash === manifestHash && cached.outcome === 'OK') return { skipped: true, cellPath };
    } catch { /* unreadable cache — re-run */ }
  }

  const record = {
    strategy: strat.key, title, symbol: `EGX:${symbol}`, timeframe: strat.timeframe,
    manifest_hash: manifestHash,
    started_at: new Date().toISOString(),
    ...(strat.patch && { source_patch: strat.patch.from + ' -> ' + strat.patch.to }),
    ...(strat.note && { note: strat.note }),
  };
  try {
    const clear = await bt.clearStudies();
    if (!clear.success) throw new Error(`clearStudies failed: ${JSON.stringify(clear)}`);

    const ctx = await setContextVerified(`EGX:${symbol}`, strat.timeframe);
    if (!ctx.ok) { record.guard_failure = /replay|modal/.test(ctx.error || ''); throw new Error(ctx.error); }
    record.resolution_landed = ctx.resolution;

    const set = await bt.setDraftSource({ source });
    if (!set.success) throw new Error(`setDraftSource failed: ${set.error}`);
    record.source_digest = set.digest;

    const add = await bt.addToChart({ expect_name: title });
    record.attach = {
      success: add.success, script_id: add.script_id, pine_digest: add.pine_digest,
      entity_id: add.entity_id,
      screenshot_before: add.screenshot_before, screenshot_after: add.screenshot_after,
      ...(add.problems && { problems: add.problems }), ...(add.error && { error: add.error }),
    };
    if (!add.success) throw new Error(`attach failed: ${JSON.stringify(add.problems || add.error)}`);
    // G2 evidence is mandatory, not decorative (pass 7).
    if (!add.screenshot_before || !add.screenshot_after) throw new Error('attach screenshots missing — evidence requirement not met.');
    if (add.pine_digest !== set.digest) throw new Error(`attached digest ${add.pine_digest} != injected source ${set.digest}`);

    await delay(4000);
    let results = null;
    for (let i = 0; i < 6; i++) {
      results = await data.getStrategyResults();
      if (results.success) break;
      await delay(3000);
    }
    // Report PROVENANCE: the report must name our strategy AND come from the
    // entity we attached — absence of either is an ERROR, never a pass
    // (pass 7: a stale report or missing read-back was recorded as OK).
    if (!results?.strategy) throw new Error('report read-back has no strategy name — provenance unverifiable');
    if (results.strategy !== title) throw new Error(`report is for "${results.strategy}", expected "${title}" (A1 violation)`);
    if (!results.entity_id || results.entity_id !== add.entity_id) {
      throw new Error(`report entity ${results.entity_id ?? '(none)'} != attached entity ${add.entity_id} — wrong or stale report`);
    }
    const shotReport = await cap.captureScreenshot({ region: 'strategy_tester', filename: `cell_${strat.key}_${symbol}` });
    if (!shotReport?.file_path) throw new Error('report screenshot failed — evidence requirement not met.');
    record.screenshot_report = shotReport.file_path;

    // Per-trade list (entry/exit epoch-ms + P&L): the anti-overfitting
    // substrate. Parameters are NEVER tuned in this tournament, so an
    // after-the-fact in-sample/out-of-sample split of these trades is
    // methodologically sound — the only fitting risk left is SELECTION, and
    // the report handles that by ranking on the IS window and validating on
    // OOS. Bound to the same entity as the report.
    const rt = await data.getReportTrades({});
    if (rt.entity_id && rt.entity_id !== add.entity_id) {
      throw new Error(`trade list entity ${rt.entity_id} != attached ${add.entity_id}`);
    }
    record.trades = rt.trades || [];
    record.trades_truncated = rt.truncated || false;

    record.outcome = cellOutcome(results);
    record.strategy_name_read_back = results.strategy;
    record.report_entity_id = results.entity_id;
    record.metrics = results.metrics || {};
    record.currency = results.currency || null;
    record.coverage = results.coverage || null;
  } catch (err) {
    record.outcome = 'ERROR';
    record.error = err.message;
  }
  record.finished_at = new Date().toISOString();
  // Atomic: never leave a half-written cell for the resume logic to trust.
  writeFileSync(cellPath + '.tmp', JSON.stringify(record, null, 2));
  renameSync(cellPath + '.tmp', cellPath);
  return { record, cellPath };
}

/** G1, landed here as promised in pass 4: identical fingerprints across symbols fail the set. */
export function checkResultIntegrity(runs) {
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const FIELDS = ['net_profit_percent', 'total_trades', 'max_drawdown_percent'];
  const seen = new Map(); const clones = []; const skipped = [];
  for (const r of runs || []) {
    const m = r?.metrics || {};
    const vals = FIELDS.map((f) => num(m[f]));
    if (vals.every((v) => v === null)) { skipped.push(r?.symbol ?? null); continue; }
    const key = JSON.stringify(vals);
    if (seen.has(key)) clones.push({ symbols: [seen.get(key), r.symbol], fingerprint: key });
    else seen.set(key, r.symbol);
  }
  return { ok: clones.length === 0, clone_count: clones.length, clones, ...(skipped.length && { skipped_no_metrics: skipped }) };
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : '/home/karim/claude-a15-20260818/strategy-tournament/run-' + new Date().toISOString().slice(0, 10);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const dry = args.includes('--dry');
  mkdirSync(join(outDir, 'cells'), { recursive: true });

  const plan = STRATEGIES.filter((s) => !only || s.key === only);

  // Run manifest: any change to the harness, a source file, a patch, a symbol
  // set or the TV build invalidates cached cells (sol-max pass 7).
  const tvBuild = await evaluate(`(navigator.userAgent.match(/TVDesktop\\/[0-9.]+/) || [null])[0]`);
  const manifest = {
    harness_sha1: createHash('sha1').update(readFileSync(new URL(import.meta.url).pathname, 'utf8')).digest('hex'),
    tv_build: tvBuild,
    strategies: STRATEGIES.map((s) => ({
      key: s.key, timeframe: s.timeframe, symbols: s.symbols, patch: s.patch ?? null,
      source_sha1: createHash('sha1').update(s.inline ?? readFileSync(join(SRC_DIR, s.file), 'utf8')).digest('hex'),
    })),
  };
  const manifestHash = createHash('sha1').update(JSON.stringify(manifest)).digest('hex');
  writeFileSync(join(outDir, 'run-manifest.json'), JSON.stringify({ manifest_hash: manifestHash, ...manifest }, null, 2));
  console.log(`tournament: ${plan.length} strategies, out=${outDir}, manifest ${manifestHash.slice(0, 12)}${dry ? ' (DRY)' : ''}`);

  const inventoryBefore = await savedScriptInventory();
  writeFileSync(join(outDir, 'saved-scripts-before.json'), JSON.stringify(inventoryBefore, null, 2));

  const g0 = await guardsClear('preflight');
  if (!g0.ok) { console.error(g0.error); process.exitCode = 1; await disconnect(); return; }

  try {
    outer: for (const strat of plan) {
      let source = strat.inline ?? readFileSync(join(SRC_DIR, strat.file), 'utf8');
      if (strat.patch) {
        if (!source.includes(strat.patch.from)) throw new Error(`${strat.key}: patch anchor not found`);
        source = source.replace(strat.patch.from, strat.patch.to);
      }
      const title = parseStrategyTitle(source);
      if (!title) throw new Error(`${strat.key}: could not parse strategy() title`);
      console.log(`\n=== ${strat.key} — "${title}" @${strat.timeframe} × ${strat.symbols.length} symbols ===`);
      if (dry) continue;

      const cells = [];
      for (const symbol of strat.symbols) {
        const res = await runCell({ strat, symbol, source, title, outDir, manifestHash });
        if (res.skipped) { console.log(`  ${symbol}: (cached OK)`); cells.push(JSON.parse(readFileSync(res.cellPath, 'utf8'))); continue; }
        cells.push(res.record);
        const m = res.record.metrics || {};
        console.log(`  ${symbol}: ${res.record.outcome}` + (res.record.outcome === 'OK'
          ? ` net ${(m.net_profit_percent * 100).toFixed(2)}% trades ${m.total_trades} dd ${(m.max_drawdown_percent * 100).toFixed(2)}%`
          : ` ${res.record.error || ''}`));
        // A replay/modal guard failure means the SESSION is compromised — the
        // next cell would be just as poisoned. Abort the sweep (pass 7).
        if (res.record.guard_failure) {
          console.error('GUARD FAILURE — aborting the entire sweep; the session needs karim.');
          process.exitCode = 4;
          break outer;
        }
      }

      // G1 across this strategy's OK cells. NO_TRADES clones are NOT counted
      // as contamination: identical legitimate absence is expected (ABUK on
      // non-ABUK symbols proved this), and the provenance binding above makes
      // a stale-report NO_TRADES impossible to record — it fails A1/entity
      // checks as ERROR instead. The 08-18 incident shape is identical
      // NON-ZERO values, which is what the fingerprint catches.
      const g1 = checkResultIntegrity(cells.filter((c) => c.outcome === 'OK').map((c) => ({ symbol: c.symbol, metrics: c.metrics })));
      const noTrades = cells.filter((c) => c.outcome === 'NO_TRADES').length;
      const summary = { ok: cells.filter((c) => c.outcome === 'OK').length, no_trades: noTrades, error: cells.filter((c) => c.outcome === 'ERROR').length, g1 };
      writeFileSync(join(outDir, `integrity-${strat.key}.json`), JSON.stringify(summary, null, 2));
      if (noTrades > 0) console.log(`  NOTE: ${noTrades}/${cells.length} cells NO_TRADES — reported loudly, see integrity-${strat.key}.json`);
      if (!g1.ok) {
        console.error(`G1 FAILED for ${strat.key}: ${JSON.stringify(g1.clones)} — aborting the sweep, cells kept for diagnosis.`);
        process.exitCode = 2;
        break;
      }
    }
  } finally {
    // The inventory diff and disconnect must run even on an abort — an
    // unchecked run is exactly when the inventory matters most (pass 7).
    try {
      const inventoryAfter = await savedScriptInventory();
      writeFileSync(join(outDir, 'saved-scripts-after.json'), JSON.stringify(inventoryAfter, null, 2));
      const drift = JSON.stringify(inventoryBefore) !== JSON.stringify(inventoryAfter);
      console.log(`\nsaved-script inventory: ${drift ? '*** CHANGED — INVESTIGATE ***' : 'unchanged (id+version)'}`);
      if (drift) process.exitCode = 3;
    } catch (err) {
      console.error(`saved-script inventory check FAILED: ${err.message} — treat the run as unverified.`);
      process.exitCode = process.exitCode || 5;
    }
    await disconnect();
  }
}

const isMain = process.argv[1] && basename(process.argv[1]) === 'backtest-tournament.mjs';
if (isMain) await main();
