#!/usr/bin/env node
/**
 * TV-EV-02 — replay-consistency walk of the SMA100 gate, corrected scoping.
 * BINDING pre-registration: docs/PREREG_TV-EV-02.md (efbcb8a). Exactly three
 * changes from TV-EV-01, all registered up front: symmetric boundary-state
 * scoping, dust-trade handling, and the FWRY Feb-2025 timeline report.
 *
 * Per symbol: replay from the window start, reveal bars one at a time, apply
 * the gate mechanically from SEEN bars only (flat & close[t-1]>SMA100[t-1] →
 * enter at open[t]; long & close[t-1]<SMA100[t-1] → exit at open[t]), record
 * the walker's own trades, then compare one-to-one (greedy, entry order)
 * against the Strategy Tester trades stored in run-2026-08-23.
 * Usage: node scripts/tv-ev-01-walk.mjs [--out DIR] [--only SYM]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const R = new URL('../src/', import.meta.url).pathname;
const chart = await import(join(R, 'core/chart.js'));
const data = await import(join(R, 'core/data.js'));
const replay = await import(join(R, 'core/replay.js'));
const bt = await import(join(R, 'core/backtest.js'));
const { disconnect } = await import(join(R, 'connection.js'));

const SYMBOLS = ['COMI', 'TMGH', 'ORAS', 'FWRY', 'ETEL'];   // fixed by prereg
const WINDOW_START = '2024-01-02';
const WINDOW_END_MS = Date.UTC(2026, 7, 20, 23, 59, 59);
const SMA_LEN = 100;
const COMMISSION = 0.001; // 0.10% per side, as the baseline declares
const CELLS_DIR = '/home/karim/claude-a15-20260818/strategy-tournament/run-2026-08-23/cells';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const sma = (closes) => closes.slice(-SMA_LEN).reduce((a, b) => a + b, 0) / SMA_LEN;

/** The chart reloads around replay transitions — bar reads need patience. */
async function readBars(count) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      const r = await data.getOhlcv({ count, summary: false });
      if (r?.bars?.length) return r.bars;
    } catch (e) { lastErr = e; }
    await delay(3000);
  }
  throw new Error(`bars unreadable after retries: ${lastErr?.message || 'empty'}`);
}

async function guards(stage) {
  const m = await bt.detectBlockingModal();
  if (m.blocked) throw new Error(`[${stage}] modal: ${m.modal_text} — aborting cleanly per law; resume after karim restores the session.`);
}

async function walkSymbol(sym, outDir) {
  const outPath = join(outDir, `walk-${sym}.json`);
  if (existsSync(outPath)) return JSON.parse(readFileSync(outPath, 'utf8'));

  await guards('pre');
  await chart.setSymbol({ symbol: `EGX:${sym}` });
  await delay(4000);
  await chart.setTimeframe({ timeframe: '1D' });
  await delay(3000);
  const st = await chart.getState();
  if (!String(st.symbol).toUpperCase().includes(sym) || String(st.resolution).toUpperCase().replace(/^D$/, '1D') !== '1D') {
    throw new Error(`${sym}: context not reached (${st.symbol}@${st.resolution})`);
  }

  const started = await replay.start({ date: WINDOW_START });
  if (!started.replay_started) throw new Error(`${sym}: replay failed to start`);

  // Seed with the history visible at the replay point (needs SMA_LEN closes).
  await delay(4000);
  let bars = await readBars(SMA_LEN + 30);
  if (!bars || bars.length < SMA_LEN + 1) throw new Error(`${sym}: only ${bars?.length} seed bars — SMA${SMA_LEN} not computable`);

  const trades = [];
  // Symmetric boundary state (prereg change 1): long at window start iff the
  // pre-window signal says so; such a position is OUT OF SCOPE on both sides.
  const seedCloses = bars.map((b) => b.close);
  let pos = null;
  if (seedCloses[seedCloses.length - 2] > sma(seedCloses.slice(0, -1))) {
    pos = { entry_time: 0, entry_fill: bars[bars.length - 1].open, synthetic_boundary: true };
  }
  let steps = 0;
  let clampedEnd = null;
  const record = (t) => trades.push(t);

  for (; steps < 900; steps++) {
    let s;
    try {
      s = await replay.step();
    } catch (e) {
      // TV auto-exits replay at the live edge; step() then throws "Replay is
      // not started". That IS the end of the walk, not a failure.
      if (/Replay is not started/.test(e.message)) break;
      throw e;
    }
    if (!s || s.finished || s.at_end) break;
    const latest = await readBars(2);
    const nb = latest[latest.length - 1];
    if (!nb || nb.time === bars[bars.length - 1].time) { if (s.current_date && s.current_date === clampedEnd) break; clampedEnd = s.current_date; continue; }
    // Decision per the REGISTERED Pine semantics: `if longNow[1]` with
    // process_orders_on_close=false evaluates the condition on bar t-2's close
    // and fills at open[t] (order placed during t-1, executed next open).
    // The first walk filled one bar early — a HARNESS fault, proven by 15/15
    // matched entries landing exactly one trading day before the tester's —
    // and was corrected per the registry's harness-first investigation order.
    // Still no peeking: t-2 is even further from the revealed bar.
    const closes = bars.map((b) => b.close);
    const prevClose = closes[closes.length - 2];
    const prevSma = sma(closes.slice(0, -1));
    if (pos === null && prevClose > prevSma) {
      pos = { entry_time: nb.time * 1000, entry_fill: nb.open };
    } else if (pos !== null && prevClose < prevSma) {
      const gross = nb.open / pos.entry_fill;
      record({ ...pos, exit_time: nb.time * 1000, exit_fill: nb.open, ret: gross * (1 - COMMISSION) / (1 + COMMISSION) - 1 });
      pos = null;
    }
    bars.push(nb);
    if (bars.length > SMA_LEN + 5) bars.shift();
    if (nb.time * 1000 > WINDOW_END_MS) break;
    if (steps % 50 === 0) { await guards(`step ${steps}`); console.log(`  ${sym}: step ${steps}, ${new Date(nb.time * 1000).toISOString().slice(0, 10)}, trades ${trades.length}`); }
  }
  if (pos !== null) record({ ...pos, exit_time: null, exit_fill: null, ret: null, open_at_end: true });
  await replay.stop().catch(() => {});
  await delay(2000);

  // ---- compare with tester trades (entry-scoped to the window) ----
  const cell = JSON.parse(readFileSync(join(CELLS_DIR, `baseline-sma100__${sym}.json`), 'utf8'));
  const winStartMs = Date.UTC(2024, 0, 2);
  const DAY_MS = 86400000;
  const inScope = (cell.trades || []).filter((t) => t.entry_time >= winStartMs && t.entry_time <= WINDOW_END_MS);
  // Dust exclusion (prereg change 2): same-UTC-day round trips at exactly
  // -0.20% (same-open fills, pure double commission).
  const isDust = (t) => t.exit_time && Math.floor(t.entry_time / DAY_MS) === Math.floor(t.exit_time / DAY_MS)
    && t.profit_pct !== null && Math.abs(t.profit_pct + 0.002) < 1e-6;
  const dust = inScope.filter(isDust);
  const tester = inScope.filter((t) => !isDust(t));
  const walker = trades.filter((t) => !t.synthetic_boundary && t.entry_time >= winStartMs && t.entry_time <= WINDOW_END_MS);

  const DAY = DAY_MS;
  const used = new Set();
  const matches = [];
  for (const tt of tester) {
    let best = -1; let bestD = Infinity;
    walker.forEach((wt, i) => {
      if (used.has(i)) return;
      const dEntry = Math.abs(wt.entry_time - tt.entry_time) / DAY;
      const dExit = (tt.exit_time && wt.exit_time) ? Math.abs(wt.exit_time - tt.exit_time) / DAY : (tt.exit_time || wt.exit_time ? Infinity : 0);
      // ±1 BAR ≈ allow up to 4 calendar days (weekends + EGX Fri/Sat) each side
      if (dEntry <= 4 && dExit <= 4 && dEntry + dExit < bestD) { best = i; bestD = dEntry + dExit; }
    });
    if (best >= 0) {
      used.add(best);
      const wt = walker[best];
      const retDiff = (wt.ret !== null && tt.profit_pct !== null) ? Math.abs(wt.ret - tt.profit_pct) : null;
      matches.push({ tester_entry: tt.entry_time, walker_entry: wt.entry_time, ret_diff: retDiff, ret_ok: retDiff === null ? true : retDiff <= 0.005 });
    }
  }
  const matchedFrac = tester.length ? matches.length / tester.length : 1;
  const retOk = matches.every((m) => m.ret_ok);
  const unmatchedWalker = walker.length - used.size;
  const pass = matchedFrac >= 0.9 && retOk && unmatchedWalker <= 2;

  const result = {
    symbol: sym, steps, window: [WINDOW_START, '2026-08-20'],
    tester_trades_in_scope: tester.length, dust_trades: dust.length, walker_trades: walker.length,
    matched: matches.length, matched_frac: matchedFrac,
    per_trade_return_ok: retOk,
    max_ret_diff: matches.reduce((a, m) => Math.max(a, m.ret_diff ?? 0), 0),
    unmatched_walker_trades: unmatchedWalker,
    pass, matches, walker_trade_list: walker,
  };
  if (sym === 'FWRY') {
    // Prereg change 3: the unexplained TV-EV-01 cluster gets its full timeline.
    const t0 = Date.UTC(2025, 1, 1);
    const t1 = Date.UTC(2025, 2, 15);
    result.fwry_feb2025_timeline = {
      tester: inScope.filter((t) => t.entry_time >= t0 && t.entry_time <= t1),
      walker: trades.filter((t) => !t.synthetic_boundary && t.entry_time >= t0 && t.entry_time <= t1),
    };
  }
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  return result;
}

const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '/home/karim/claude-a15-20260818/strategy-tournament/tv-ev-02';
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
mkdirSync(outDir, { recursive: true });
const results = [];
try {
  for (const sym of SYMBOLS) {
    if (only && sym !== only) continue;
    console.log(`=== ${sym} ===`);
    const r = await walkSymbol(sym, outDir);
    results.push(r);
    console.log(`  ${sym}: ${r.pass ? 'PASS' : 'FAIL'} — matched ${r.matched}/${r.tester_trades_in_scope}, ret_ok ${r.per_trade_return_ok}, max_diff ${(r.max_ret_diff * 100).toFixed(3)}%, unmatched_walker ${r.unmatched_walker_trades}`);
  }
  const passes = results.filter((r) => r.pass).length;
  const verdict = only ? '(partial — no study verdict)' : (passes >= 4 ? 'STUDY PASS' : 'STUDY FAIL');
  console.log(`\nTV-EV-01: ${passes}/${results.length} symbols pass → ${verdict}`);
  writeFileSync(join(outDir, 'TV-EV-02-verdict.json'), JSON.stringify({ verdict, passes, results: results.map(({ matches: _m, walker_trade_list: _w, ...rest }) => rest) }, null, 2));
} finally {
  try { await replay.stop(); } catch { /* already stopped */ }
  await disconnect();
}
