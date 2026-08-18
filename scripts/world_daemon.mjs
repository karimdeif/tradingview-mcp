#!/usr/bin/env node
/**
 * World-context realtime arm — continuous daemon (karimdeif fork).
 *
 * Sweeps the macro symbol set continuously through the TradingView chart and
 * streams one row per symbol per cycle into QuestDB, running a deterministic
 * shock detector alongside. Replaces the batch collector's file-first model:
 * under estate law QuestDB is the only data interface and the local JSONL is
 * demoted to a transient outage spool, drained and deleted on reconnect.
 *
 * SAFETY PROPERTIES, all deliberate:
 *
 *  - Read-only by construction. The MCP child is spawned with
 *    TV_MCP_TOOL_ALLOWLIST=readonly, so no writer or ui_* driver exists in it.
 *  - No order path. Nothing here can reach a broker; the tools do not exist.
 *  - QuestDB sink is OFF unless --questdb is passed. Single-row /exec inserts
 *    only, never /imp.
 *  - Absence of data is never silence. Staleness is emitted explicitly, so a
 *    dead feed cannot be mistaken for a calm market.
 *  - Chart cursor is restored on clean shutdown.
 *
 * §8: everything produced here is advisory. World context may veto or reduce,
 * never add or accelerate. This daemon emits observations, not instructions.
 *
 * Usage:
 *   node scripts/world_daemon.mjs [--questdb] [--questdb-host questdb.lan]
 *                                 [--spool PATH] [--cycles N] [--dry-run]
 */
import { spawn } from 'child_process';
import { join } from 'path';
import { SYMBOLS, classify } from './futures_collector.mjs';
import { createDetector } from '../src/world/detector.js';
import { createSink } from '../src/world/questdb.js';
import { assessFeedIntegrity, integrityAlarmText } from '../src/world/integrity.js';

const HOME = process.env.HOME || '/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Session-open cache: refreshed only when the session bar rolls over. */
const SESSION_CACHE_MAX_AGE_S = 6 * 3600;

function parseArgs(argv) {
  const a = {
    questdb: false,
    host: 'questdb.lan',
    port: 9000,
    spool: join(HOME, 'claude-a15-20260818', 'data', 'spool', 'tv_world_quotes.spool.jsonl'),
    cycles: Infinity,
    dryRun: false,
    settleSymbolMs: 11000,
    settleTfMs: 4500,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--questdb') a.questdb = true;
    else if (v === '--questdb-host') a.host = argv[++i];
    else if (v === '--spool') a.spool = argv[++i];
    else if (v === '--cycles') a.cycles = Number(argv[++i]);
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--settle') a.settleSymbolMs = Number(argv[++i]);
  }
  return a;
}

function openClient() {
  const p = spawn('node', [join(import.meta.dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, TV_MCP_TOOL_ALLOWLIST: 'readonly' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* banner */ }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); } }, 60000);
  });
  return {
    proc: p,
    async init() {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'world-daemon', version: '1' } });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    async call(name, args = {}) {
      const r = await rpc('tools/call', { name, arguments: args });
      if (r.error) return { success: false, error: `${r.error.code}: ${r.error.message}` };
      const text = r.result?.content?.map((c) => c.text).join('') ?? '';
      try { return JSON.parse(text); } catch { return { success: false, error: 'unparseable' }; }
    },
    close() { p.kill(); },
  };
}

/**
 * Wait until the chart actually reports the requested symbol/timeframe.
 *
 * A fixed settle sleep is not enough and failing it is dangerous, not merely
 * slow. Observed live: reading a quote before a 1D->1m switch landed returned
 * the DAILY bar, whose open stamp is ~13h old. That made every real-time TVC
 * symbol classify as `realtime:false` with a 47000s lag, which in turn trips
 * the detector's staleness guard and silently suppresses every shock rule.
 * A dead arm that looks like a calm market is the worst failure this system
 * has, so the state is confirmed rather than assumed.
 */
export async function confirmChart(client, { symbol, timeframe }, { tries = 25, gapMs = 600 } = {}) {
  for (let i = 0; i < tries; i++) {
    const st = await client.call('chart_get_state');
    if (st?.success
      && (!symbol || st.symbol === symbol)
      && (!timeframe || String(st.resolution) === String(timeframe))) return { ok: true, waited: i * gapMs, state: st };
    await sleep(gapMs);
  }
  const st = await client.call('chart_get_state');
  return { ok: false, waited: tries * gapMs, state: st };
}

/**
 * Read a quote and verify it belongs to the symbol we asked for.
 *
 * quote_get reports whatever the chart currently holds. If a symbol switch has
 * not landed, it returns the PREVIOUS symbol's price — which would be written
 * under the new symbol's name. Silent cross-contamination of a trading feed.
 */
export async function quoteFor(client, tvSymbol, { tries = 12, gapMs = 700 } = {}) {
  for (let i = 0; i < tries; i++) {
    const q = await client.call('quote_get');
    if (q?.success && q.symbol === tvSymbol) return q;
    if (q?.success && q.symbol !== tvSymbol) { await sleep(gapMs); continue; }
    await sleep(gapMs);
  }
  const q = await client.call('quote_get');
  if (q?.success && q.symbol !== tvSymbol) {
    return { success: false, error: `symbol mismatch: chart holds ${q.symbol}, expected ${tvSymbol}` };
  }
  return q;
}

/**
 * Volume semantics, made honest.
 *
 * TVC synthetics report volume 0. That is "not published", not "nothing
 * traded" — averaging those zeros into a real volume series would silently
 * drag it toward zero. Absent volume is emitted as NULL with
 * volume_available=false so a consumer cannot confuse the two.
 */
export function normaliseVolume(quote) {
  const synthetic = quote.exchange === 'TVC';
  if (synthetic) return { volume: null, volume_available: false };
  const v = Number(quote.volume);
  if (!Number.isFinite(v)) return { volume: null, volume_available: false };
  return { volume: v, volume_available: true };
}

/** Build the row emitted per symbol per cycle. */
export function buildRow({ sym, quote, session, nowS, cycle }) {
  const fresh = classify(nowS, quote.time);
  const vol = normaliseVolume(quote);
  const sessionOpen = session?.open ?? null;
  const changePct = (sessionOpen && Number.isFinite(quote.last))
    ? Number((((quote.last - sessionOpen) / sessionOpen) * 100).toFixed(4))
    : null;
  return {
    ts_utc: new Date(nowS * 1000).toISOString(),
    symbol: sym.key,
    tv_symbol: sym.tv,
    role: sym.role,
    last: quote.last ?? null,
    session_open: sessionOpen,
    session_change_pct: changePct,
    session_high: session?.high ?? null,
    session_low: session?.low ?? null,
    ...vol,
    bar_ts: quote.time ?? null,
    feed_lag_s: fresh.feed_lag_s,
    delay_est_s: fresh.delay_est_s,
    realtime: fresh.realtime,
    realtime_drift: fresh.realtime !== null && fresh.realtime !== sym.expect_realtime,
    exchange: quote.exchange ?? null,
    instrument_type: quote.type ?? null,
    source: 'tradingview-mcp',
    collector_cycle: cycle,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = openClient();
  const detector = createDetector();
  const sink = createSink({
    enabled: args.questdb,
    host: args.host,
    port: args.port,
    spoolPath: args.spool,
    log: (m) => console.error(`[sink] ${m}`),
  });

  const sessionCache = new Map(); // symbol -> {open, high, low, bar_ts, at}
  let running = true;
  let restoreTo = null;
  let cycle = 0;
  let stagingSeq = 0;

  const shutdown = async (sig) => {
    if (!running) return;
    running = false;
    console.error(`\n[daemon] ${sig} — finishing cycle, restoring chart`);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await client.init();
  const health = await client.call('tv_health_check');
  if (!health?.success || !health.api_available) {
    console.error(`[daemon] FATAL health check — cdp=${health?.cdp_connected} api=${health?.api_available} ${health?.error ?? ''}`);
    client.close();
    process.exit(4);
  }
  restoreTo = { symbol: health.chart_symbol, resolution: health.chart_resolution };
  console.error(`[daemon] start — chart was ${restoreTo.symbol} @ ${restoreTo.resolution}`);
  console.error(`[daemon] questdb=${args.questdb ? `ENABLED -> ${args.host}:${args.port}` : 'DISABLED (all rows spool to disk)'}`);
  console.error(`[daemon] spool=${args.spool}`);

  if (args.questdb) {
    await sink.ensureTable().catch((e) => console.error(`[sink] ensureTable failed: ${e.message}`));
    await sink.drain().catch((e) => console.error(`[sink] drain failed: ${e.message}`));
  }

  /**
   * Session-open pass. Done as its own sweep at 1D, never interleaved with the
   * hot loop — per-symbol timeframe flapping was the source of the stale-quote
   * race above, and it also tripled cycle time (510s measured vs ~110s).
   */
  async function refreshSessionOpens(reason) {
    console.error(`[session] refreshing session opens (${reason})`);
    await client.call('chart_set_timeframe', { timeframe: '1D' });
    await confirmChart(client, { timeframe: '1D' });
    let n = 0;
    for (const sym of SYMBOLS) {
      if (!running) break;
      await client.call('chart_set_symbol', { symbol: sym.tv });
      const c = await confirmChart(client, { symbol: sym.tv, timeframe: '1D' });
      if (!c.ok) { console.error(`[session] ${sym.key} chart never confirmed — skipped`); continue; }
      const dq = await quoteFor(client, sym.tv);
      if (dq?.success) {
        sessionCache.set(sym.key, { open: dq.open, high: dq.high, low: dq.low, bar_ts: dq.time, at: Math.floor(Date.now() / 1000) });
        n++;
      } else {
        console.error(`[session] ${sym.key} no session quote — ${dq?.error}`);
      }
    }
    await client.call('chart_set_timeframe', { timeframe: '1' });
    await confirmChart(client, { timeframe: '1' });
    console.error(`[session] ${n}/${SYMBOLS.length} session opens cached`);
  }

  await refreshSessionOpens('startup');

  while (running && cycle < args.cycles) {
    cycle++;
    const cycleStart = Date.now();
    let ok = 0, failed = 0;
    const cycleRows = [];

    for (const sym of SYMBOLS) {
      if (!running) break;
      try {
        const set = await client.call('chart_set_symbol', { symbol: sym.tv });
        const confirmed = await confirmChart(client, { symbol: sym.tv, timeframe: '1' });
        if (!confirmed.ok) {
          failed++;
          console.error(`[cycle ${cycle}] ${sym.key} chart never confirmed (holds ${confirmed.state?.symbol} @ ${confirmed.state?.resolution}) — skipped rather than mislabelled`);
          continue;
        }

        const nowS = Math.floor(Date.now() / 1000);
        // Validate on quote, never on set — and verify the quote is this symbol's.
        const q = await quoteFor(client, sym.tv);
        if (!q?.success) {
          failed++;
          console.error(`[cycle ${cycle}] ${sym.key} NO-QUOTE (set reported ${set?.success}) — ${q?.error}`);
          continue;
        }

        const sess = sessionCache.get(sym.key);

        const row = buildRow({ sym, quote: q, session: sess, nowS, cycle });
        ok++;
        // Buffered, not written yet — integrity is a property of the SET of
        // rows, not of any single row. See src/world/integrity.js.
        cycleRows.push({ row, nowS, sym });

        if (row.realtime_drift) {
          console.error(`[cycle ${cycle}] ${sym.key} FRESHNESS DRIFT — realtime=${row.realtime} lag=${row.feed_lag_s}s (expected realtime=${sym.expect_realtime})`);
        }
      } catch (err) {
        failed++;
        console.error(`[cycle ${cycle}] ${sym.key} EXCEPTION — ${err.message}`);
      }
    }

    // ---- Integrity gate: judge the cycle as a set before persisting anything.
    const integrity = assessFeedIntegrity(cycleRows.map((c) => c.row));
    if (!integrity.healthy) {
      console.error(integrityAlarmText(integrity, cycle));
      console.error(`    detail: ${JSON.stringify(integrity.detail)}`);
      // Discard: do not write, and do not feed the detector. Contaminated
      // values would otherwise compute nonsense (oil's price against ES's
      // session open is a -98% "drawdown") and could fire a false shock the
      // moment a staleness guard happened not to catch it.
      console.error(`[cycle ${cycle}] ${cycleRows.length} rows DISCARDED`);
    } else {
      for (const { row, nowS, sym } of cycleRows) {
        if (!args.dryRun) await sink.write(row);
        detector.push(sym.key, nowS, {
          last: row.last,
          session_change_pct: row.session_change_pct,
        }, { feed_lag_s: row.feed_lag_s, realtime: row.realtime });
      }
    }

    // Session opens age out (or a new session began). Refresh as a dedicated
    // pass between cycles rather than inline.
    const oldestCache = Math.min(...[...sessionCache.values()].map((v) => v.at), Infinity);
    if (running && (sessionCache.size < SYMBOLS.length || (Math.floor(Date.now() / 1000) - oldestCache) > SESSION_CACHE_MAX_AGE_S)) {
      await refreshSessionOpens('cache aged or incomplete');
    }

    // Shock evaluation, after the whole cycle so every symbol is current.
    const events = integrity.healthy ? detector.evaluate(Math.floor(Date.now() / 1000)) : [];
    for (const ev of events) {
      stagingSeq++;
      const stagingId = `tvw-${new Date().toISOString().slice(0, 10)}-${stagingSeq}`;
      // Loud, greppable, and monitorable from another session.
      console.error(`\n*** WORLD SHOCK *** ${stagingId} ${ev.symbol} ${ev.note} observed=${ev.observed} ${ev.comparison}`);
      if (ev.freshness_warning) console.error(`    ${ev.freshness_warning}`);
      console.error(`    ${JSON.stringify(ev)}\n`);
      if (!args.dryRun && args.questdb) await sink.writeStaging(ev, stagingId);
    }

    const secs = ((Date.now() - cycleStart) / 1000).toFixed(1);
    const s = sink.stats();
    console.error(`[cycle ${cycle}] ${secs}s — ${ok} ok, ${failed} failed, ${events.length} shocks | sink inserted=${s.inserted} spooled=${s.spooled} failures=${s.failures}`);

    // Staleness is emitted, never implied. A cycle that produced nothing is an
    // alarm, not a quiet market.
    if (ok === 0) console.error(`[cycle ${cycle}] ALARM: zero rows this cycle — feed is down, this is NOT a calm market`);
  }

  if (restoreTo?.symbol) {
    await client.call('chart_set_symbol', { symbol: restoreTo.symbol });
    await client.call('chart_set_timeframe', { timeframe: restoreTo.resolution });
    console.error(`[daemon] chart restored to ${restoreTo.symbol} @ ${restoreTo.resolution}`);
  }
  console.error(`[daemon] stopped after ${cycle} cycles | ${JSON.stringify(sink.stats())}`);
  client.close();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
