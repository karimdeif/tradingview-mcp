#!/usr/bin/env node
/**
 * Futures / macro context collector (karimdeif fork).
 *
 * Sweeps a fixed symbol set through the TradingView Desktop chart via the MCP
 * server and appends one JSONL row per symbol per sweep to local disk.
 *
 * Design constraints this encodes, all from the 2026-08-18 recon:
 *
 *  - READ-ONLY BY CONSTRUCTION. Spawns the MCP server with
 *    TV_MCP_TOOL_ALLOWLIST=readonly, so the alert/watchlist/Pine writers and
 *    every ui_* driver are not registered in the child process at all. This is
 *    not a convention — the tools do not exist to be called.
 *
 *  - VALIDATE ON QUOTE, NEVER ON SET. chart_set_symbol returns success:true for
 *    tickers that will never produce data (e.g. CME:ES1! vs CME_MINI:ES1!). A
 *    row is only emitted when a quote actually returns.
 *
 *  - PER-ROW FRESHNESS. Exchange futures run on a ~10 minute delayed feed while
 *    TVC synthetics are real-time. Every row carries feed_lag_s and realtime so
 *    a consumer can tell them apart without knowing the symbol taxonomy.
 *
 *  - NO ESTATE CONTACT. Writes to local disk only. Nothing here connects to
 *    QuestDB, ts-17, ts-15 or legion. Promotion of this data is a separate,
 *    reviewed step.
 *
 * Usage:
 *   node scripts/futures_collector.mjs [--out DIR] [--once] [--dry-run]
 */
import { spawn } from 'child_process';
import { appendFileSync, mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(REPO_ROOT, 'src', 'server.js');

/**
 * The verified working set. Exchange prefixes here are the ones that actually
 * return data — symbol_search's full_name values do NOT work for the continuous
 * mini contracts (it offers CME:ES; the working ticker is CME_MINI:ES1!).
 *
 * `expect_realtime` is the recon's measured expectation, used only to flag
 * drift; the emitted `realtime` field is always measured, never assumed.
 */
export const SYMBOLS = [
  { key: 'ES1!',   tv: 'CME_MINI:ES1!', role: 'us_equity_index', expect_realtime: false },
  { key: 'NQ1!',   tv: 'CME_MINI:NQ1!', role: 'us_equity_index', expect_realtime: false },
  { key: 'DXY',    tv: 'TVC:DXY',       role: 'dollar',          expect_realtime: true  },
  { key: 'BZ1!',   tv: 'NYMEX:BZ1!',    role: 'oil_brent',       expect_realtime: false },
  { key: 'CL1!',   tv: 'NYMEX:CL1!',    role: 'oil_wti',         expect_realtime: false },
  { key: 'GC1!',   tv: 'COMEX:GC1!',    role: 'gold',            expect_realtime: false },
  { key: 'US10Y',  tv: 'TVC:US10Y',     role: 'rates',           expect_realtime: true  },
  // Real-time substitutes for the delayed legs. Cheap to carry and they let a
  // consumer cross-check a stale futures print against a live one.
  { key: 'USOIL',  tv: 'TVC:USOIL',     role: 'oil_wti_rt',      expect_realtime: true  },
  { key: 'UKOIL',  tv: 'TVC:UKOIL',     role: 'oil_brent_rt',    expect_realtime: true  },
  { key: 'GOLD',   tv: 'TVC:GOLD',      role: 'gold_rt',         expect_realtime: true  },
];

/** A 1m bar is 60s wide; lag beyond that is feed delay, not bar age. */
const BAR_WIDTH_S = 60;
/**
 * Below this, treat as real-time.
 *
 * Not one bar width: sparse instruments legitimately skip 1m bars. TVC:US10Y
 * measured 117s on a live real-time feed simply because yields don't tick every
 * minute. The two observed populations are well separated — 24-117s real-time
 * vs 601-658s delayed — so the boundary sits between them rather than hugging
 * the bar width, where sparse ticks would be misread as a delayed feed.
 */
export const REALTIME_THRESHOLD_S = 300;

export function classify(nowS, barTs) {
  if (!barTs) return { feed_lag_s: null, realtime: null, delay_est_s: null };
  const feed_lag_s = nowS - barTs;
  return {
    feed_lag_s,
    realtime: feed_lag_s <= REALTIME_THRESHOLD_S,
    delay_est_s: Math.max(0, feed_lag_s - BAR_WIDTH_S),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openClient(env = {}) {
  const p = spawn('node', [SERVER], {
    env: { ...process.env, TV_MCP_TOOL_ALLOWLIST: 'readonly', ...env },
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
      try {
        const m = JSON.parse(line);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch { /* server prints non-JSON banners to stderr, not stdout */ }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`MCP timeout: ${method} ${params?.name ?? ''}`)); }
    }, 60000);
  });
  return {
    async init() {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'futures-collector', version: '1' } });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    async call(name, args = {}) {
      const r = await rpc('tools/call', { name, arguments: args });
      if (r.error) return { success: false, error: `${r.error.code}: ${r.error.message}` };
      const text = r.result?.content?.map((c) => c.text).join('') ?? '';
      try { return JSON.parse(text); } catch { return { success: false, error: 'unparseable', _raw: text.slice(0, 200) }; }
    },
    close() { p.kill(); },
  };
}

/**
 * One sweep. Returns { rows, errors, restored }.
 *
 * Per symbol: set symbol once, read the 1m quote (live price + an honest feed-lag
 * measurement against a 60s bar), then read the 1D summary (session context for a
 * pre-open brief). The chart is restored to whatever it was on entry.
 */
export async function sweep({ client, symbols = SYMBOLS, settleSymbolMs = 11000, settleTfMs = 4500, log = () => {} } = {}) {
  const rows = [];
  const errors = [];
  const sweep_id = new Date().toISOString();

  const before = await client.call('chart_get_state');
  const restoreTo = before?.success ? { symbol: before.symbol, resolution: before.resolution } : null;

  for (const s of symbols) {
    try {
      const set = await client.call('chart_set_symbol', { symbol: s.tv });
      await client.call('chart_set_timeframe', { timeframe: '1' });
      await sleep(settleSymbolMs);

      const nowS = Math.floor(Date.now() / 1000);
      const q = await client.call('quote_get');

      // Validate on quote, never on set: chart_set_symbol lies for bad tickers.
      if (!q?.success) {
        errors.push({ symbol: s.key, tv_symbol: s.tv, stage: 'quote', set_reported: set?.success ?? null, error: q?.error ?? 'no response' });
        log(`  ${s.key.padEnd(6)} FAIL (set reported ${set?.success}) — ${q?.error}`);
        continue;
      }

      const fresh = classify(nowS, q.time);

      await client.call('chart_set_timeframe', { timeframe: '1D' });
      await sleep(settleTfMs);
      // quote_get on a 1D chart returns the CURRENT SESSION's bar — this is the
      // only place the day's actual move comes from.
      const dq = await client.call('quote_get');
      const d = await client.call('data_get_ohlcv', { summary: true });

      rows.push({
        sweep_id,
        ts_utc: new Date(nowS * 1000).toISOString(),
        symbol: s.key,
        tv_symbol: s.tv,
        role: s.role,
        last: q.last ?? null,
        open: q.open ?? null,
        high: q.high ?? null,
        low: q.low ?? null,
        close: q.close ?? null,
        volume: q.volume ?? null,
        bar_ts: q.time ?? null,
        bar_timeframe: '1',
        feed_lag_s: fresh.feed_lag_s,
        delay_est_s: fresh.delay_est_s,
        realtime: fresh.realtime,
        realtime_drift: fresh.realtime !== null && fresh.realtime !== s.expect_realtime,
        exchange: q.exchange ?? null,
        instrument_type: q.type ?? null,
        description: q.description ?? null,
        // The CURRENT SESSION only. This is what a pre-open brief means by
        // "where is ES trading" — not the window stat below.
        session: dq?.success ? {
          open: dq.open, high: dq.high, low: dq.low, close: dq.close, last: dq.last,
          volume: dq.volume, bar_ts: dq.time,
          change: (dq.last != null && dq.open != null) ? Number((dq.last - dq.open).toFixed(6)) : null,
          change_pct: (dq.last != null && dq.open) ? Number((((dq.last - dq.open) / dq.open) * 100).toFixed(4)) : null,
        } : null,
        session_error: dq?.success ? null : (dq?.error ?? 'no response'),
        // NOT the day's move. data_get_ohlcv's change/change_pct span the whole
        // returned window (100 daily bars ~= 144 days). Named for what it is so
        // nothing downstream mistakes it for a session figure.
        window_100d: d?.success ? {
          open: d.open, high: d.high, low: d.low, close: d.close,
          change: d.change, change_pct: d.change_pct,
          avg_volume: d.avg_volume, bar_count: d.bar_count,
          period_from: d.period?.from, period_to: d.period?.to,
        } : null,
        window_error: d?.success ? null : (d?.error ?? 'no response'),
        source: 'tradingview-mcp',
      });
      log(`  ${s.key.padEnd(6)} last=${String(q.last).padEnd(11)} lag=${String(fresh.feed_lag_s).padStart(4)}s ${fresh.realtime ? 'RT ' : `~${Math.round(fresh.delay_est_s / 60)}min`}${fresh.realtime !== s.expect_realtime ? '  <-- FRESHNESS DRIFT' : ''}`);
    } catch (err) {
      errors.push({ symbol: s.key, tv_symbol: s.tv, stage: 'exception', error: err.message });
      log(`  ${s.key.padEnd(6)} EXCEPTION — ${err.message}`);
    }
  }

  let restored = false;
  if (restoreTo?.symbol) {
    await client.call('chart_set_symbol', { symbol: restoreTo.symbol });
    await client.call('chart_set_timeframe', { timeframe: restoreTo.resolution });
    restored = true;
  }
  return { rows, errors, restored, restoreTo, sweep_id };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const a = { out: join(process.env.HOME || '/tmp', 'claude-a15-20260818', 'data', 'futures'), once: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--once') a.once = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lock = join(args.out, '.collector.lock');
  mkdirSync(args.out, { recursive: true });

  // Single-flight: the chart is one global cursor. Two concurrent sweeps would
  // interleave symbol switches and corrupt each other's reads.
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    if (alive) { console.error(`another sweep is running (pid ${pid}); exiting`); process.exit(3); }
    console.error(`stale lock from pid ${pid}; taking over`);
  }
  writeFileSync(lock, String(process.pid));

  const client = openClient();
  const t0 = Date.now();
  try {
    await client.init();
    const health = await client.call('tv_health_check');
    if (!health?.success || !health.api_available) {
      console.error(`health check failed — cdp_connected=${health?.cdp_connected} api_available=${health?.api_available} error=${health?.error ?? ''}`);
      process.exit(4);
    }
    console.error(`sweep start — chart on ${health.chart_symbol} @ ${health.chart_resolution}`);

    const result = await sweep({ client, log: (m) => console.error(m) });

    const day = new Date().toISOString().slice(0, 10);
    const outFile = join(args.out, `futures-${day}.jsonl`);
    if (!args.dryRun && result.rows.length) {
      appendFileSync(outFile, result.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`sweep done in ${secs}s — ${result.rows.length} rows, ${result.errors.length} errors, chart restored=${result.restored}${args.dryRun ? ' (dry run, nothing written)' : ` -> ${outFile}`}`);
    if (result.errors.length) console.error('errors: ' + JSON.stringify(result.errors));
    process.exitCode = result.rows.length ? 0 : 5;
  } finally {
    client.close();
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
