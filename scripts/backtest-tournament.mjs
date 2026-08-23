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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const R = new URL('../src/', import.meta.url).pathname;
const chart = await import(join(R, 'core/chart.js'));
const pine = await import(join(R, 'core/pine.js'));
const data = await import(join(R, 'core/data.js'));
const bt = await import(join(R, 'core/backtest.js'));
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
  { key: 'abuk-1m', file: 'ABUK_1m_Long_Only_SMA_70_250_.pine', timeframe: '1', symbols: INTRADAY_SYMBOLS, note: 'Authored for ABUK specifically; other symbols measure generalisation.' },
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

async function setSymbolVerified(symbol) {
  await chart.setSymbol({ symbol });
  await delay(4000);
  // Guards RE-CHECKED after the switch: replay has been seen ACTIVATING on a
  // symbol change with isReplayStarted() false beforehand (2026-08-23).
  const g = await guardsClear(`after ${symbol}`);
  if (!g.ok) return g;
  const st = await chart.getState();
  if (!String(st.symbol || '').toUpperCase().includes(symbol.split(':').pop())) {
    return { ok: false, error: `symbol did not land: wanted ${symbol}, chart shows ${st.symbol}` };
  }
  // Validate on quote, never on set (gotchas): the quote must be for THIS symbol.
  let quote = null;
  for (let i = 0; i < 8; i++) {
    try { quote = await data.getQuote({}); if (quote && (quote.last ?? quote.price) != null) break; } catch { /* retry */ }
    await delay(2500);
  }
  if (!quote || (quote.last ?? quote.price) == null) return { ok: false, error: `quote never loaded for ${symbol}` };
  if (quote.symbol && !String(quote.symbol).toUpperCase().includes(symbol.split(':').pop())) {
    return { ok: false, error: `quote is for ${quote.symbol}, not ${symbol} — stale chart` };
  }
  return { ok: true, last: quote.last ?? quote.price };
}

export function cellOutcome(results) {
  const m = results?.metrics || {};
  if (!results?.success) return 'ERROR';
  if ((m.total_trades ?? 0) === 0) return 'NO_TRADES';
  return 'OK';
}

async function runCell({ strat, symbol, source, title, outDir }) {
  const cellPath = join(outDir, 'cells', `${strat.key}__${symbol}.json`);
  if (existsSync(cellPath)) return { skipped: true, cellPath };

  const record = {
    strategy: strat.key, title, symbol: `EGX:${symbol}`, timeframe: strat.timeframe,
    started_at: new Date().toISOString(),
    ...(strat.patch && { source_patch: strat.patch.from + ' -> ' + strat.patch.to }),
    ...(strat.note && { note: strat.note }),
  };
  try {
    const clear = await bt.clearStudies();
    if (!clear.success) throw new Error(`clearStudies failed: ${JSON.stringify(clear)}`);

    const sym = await setSymbolVerified(`EGX:${symbol}`);
    if (!sym.ok) throw new Error(sym.error);
    await chart.setTimeframe({ timeframe: strat.timeframe });
    await delay(3000);
    const g = await guardsClear('after timeframe');
    if (!g.ok) throw new Error(g.error);

    await pine.setSource({ source });
    await delay(1500);

    const add = await bt.addToChart({ expect_name: title });
    record.attach = {
      success: add.success, script_id: add.script_id, pine_digest: add.pine_digest,
      entity_id: add.entity_id, screenshot_after: add.screenshot_after,
      ...(add.problems && { problems: add.problems }), ...(add.error && { error: add.error }),
    };
    if (!add.success) throw new Error(`attach failed: ${JSON.stringify(add.problems || add.error)}`);

    await delay(4000);
    let results = null;
    for (let i = 0; i < 6; i++) {
      results = await data.getStrategyResults();
      if (results.success) break;
      await delay(3000);
    }
    record.outcome = cellOutcome(results);
    record.strategy_name_read_back = results?.strategy || null;
    if (results?.strategy && results.strategy !== title) {
      record.outcome = 'ERROR';
      record.error = `report is for "${results.strategy}", expected "${title}" (A1 violation)`;
    }
    record.metrics = results?.metrics || {};
    record.currency = results?.currency || null;
    record.coverage = results?.coverage || null;
  } catch (err) {
    record.outcome = 'ERROR';
    record.error = err.message;
  }
  record.finished_at = new Date().toISOString();
  writeFileSync(cellPath, JSON.stringify(record, null, 2));
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
  console.log(`tournament: ${plan.length} strategies, out=${outDir}${dry ? ' (DRY)' : ''}`);

  const inventoryBefore = await savedScriptInventory();
  writeFileSync(join(outDir, 'saved-scripts-before.json'), JSON.stringify(inventoryBefore, null, 2));

  const g0 = await guardsClear('preflight');
  if (!g0.ok) { console.error(g0.error); process.exitCode = 1; await disconnect(); return; }

  for (const strat of plan) {
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
      const res = await runCell({ strat, symbol, source, title, outDir });
      if (res.skipped) { console.log(`  ${symbol}: (cached)`); cells.push(JSON.parse(readFileSync(res.cellPath, 'utf8'))); continue; }
      cells.push(res.record);
      const m = res.record.metrics || {};
      console.log(`  ${symbol}: ${res.record.outcome}` + (res.record.outcome === 'OK'
        ? ` net ${(m.net_profit_percent * 100).toFixed(2)}% trades ${m.total_trades} dd ${(m.max_drawdown_percent * 100).toFixed(2)}%`
        : ` ${res.record.error || ''}`));
    }

    // G1 across this strategy's symbol set — a contaminated cycle aborts the run.
    const g1 = checkResultIntegrity(cells.filter((c) => c.outcome === 'OK').map((c) => ({ symbol: c.symbol, metrics: c.metrics })));
    writeFileSync(join(outDir, `integrity-${strat.key}.json`), JSON.stringify(g1, null, 2));
    if (!g1.ok) {
      console.error(`G1 FAILED for ${strat.key}: ${JSON.stringify(g1.clones)} — aborting the sweep, cells kept for diagnosis.`);
      process.exitCode = 2;
      break;
    }
  }

  const inventoryAfter = await savedScriptInventory();
  writeFileSync(join(outDir, 'saved-scripts-after.json'), JSON.stringify(inventoryAfter, null, 2));
  const drift = JSON.stringify(inventoryBefore) !== JSON.stringify(inventoryAfter);
  console.log(`\nsaved-script inventory: ${drift ? '*** CHANGED — INVESTIGATE ***' : 'unchanged (id+version)'}`);
  if (drift) process.exitCode = 3;

  await disconnect();
}

const isMain = process.argv[1] && basename(process.argv[1]) === 'backtest-tournament.mjs';
if (isMain) await main();
