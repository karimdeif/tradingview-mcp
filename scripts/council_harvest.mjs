#!/usr/bin/env node
/**
 * Council-notes harvest (karimdeif fork).
 *
 * Sweeps a symbol universe through the chart and reads three layers per symbol:
 *   1. the Details-panel note text        (notes_get)
 *   2. the rating Text drawing            (draw_list + draw_get_properties)
 *   3. the hand-drawn horizontal S/R levels
 *
 * Runs on the 'harvest' allowlist: the 9 read-only tools plus four reviewed
 * readers. No writer and no generic UI driver exists in the child process, and
 * the run aborts if one is somehow present.
 *
 * Rows go to QuestDB when reachable, otherwise to the outage spool for a later
 * drain — QuestDB is the only data interface; the spool is not a consumer path.
 *
 * Usage:
 *   node scripts/council_harvest.mjs [--symbols EGX:COMI,EGX:ADIB] [--from-watchlist]
 *                                    [--questdb] [--questdb-host questdb.lan]
 *                                    [--vintage 2026-01-03]
 */
import { spawn } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { parseRating } from '../src/core/notes.js';
import {
  buildNoteRow, buildLevelRows, NOTES_DDL, LEVELS_DDL, NOTES_TABLE, LEVELS_TABLE,
} from '../src/research/council.js';
import { sqlStr, sqlNum, sqlBool, sqlTs } from '../src/world/questdb.js';

const HOME = process.env.HOME || '/tmp';
const SERVER = join(import.meta.dirname, '..', 'src', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const a = {
    symbols: [], fromWatchlist: false, questdb: false, host: 'questdb.lan', port: 9000,
    vintage: '2026-01-03', settleMs: 9000,
    spool: join(HOME, 'claude-a15-20260818', 'data', 'spool', 'tv_council_notes.spool.jsonl'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--symbols') a.symbols = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--from-watchlist') a.fromWatchlist = true;
    else if (argv[i] === '--questdb') a.questdb = true;
    else if (argv[i] === '--questdb-host') a.host = argv[++i];
    else if (argv[i] === '--vintage') a.vintage = argv[++i];
    else if (argv[i] === '--settle') a.settleMs = Number(argv[++i]);
    else if (argv[i] === '--spool') a.spool = argv[++i];
  }
  return a;
}

function openClient() {
  const p = spawn('node', [SERVER], {
    env: { ...process.env, TV_MCP_TOOL_ALLOWLIST: 'harvest' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = ''; const pending = new Map(); let id = 1;
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!l) continue;
      try { const m = JSON.parse(l); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* banner */ }
    }
  });
  const rpc = (method, params) => new Promise((res, rej) => {
    const i = id++; pending.set(i, res);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('MCP timeout ' + method)); } }, 45000);
  });
  return {
    async init() {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'council-harvest', version: '1' } });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    async listTools() { return (await rpc('tools/list', {})).result.tools.map((t) => t.name); },
    async call(name, args = {}) {
      const r = await rpc('tools/call', { name, arguments: args });
      if (r.error) return { success: false, error: r.error.message };
      const t = r.result?.content?.map((c) => c.text).join('') ?? '';
      try { return JSON.parse(t); } catch { return { success: false, error: 'unparseable' }; }
    },
    close() { p.kill(); },
  };
}

export function noteInsert(row) {
  const cols = ['harvested_at', 'vintage_date', 'symbol', 'tv_symbol', 'note_kind', 'note_text', 'note_len',
    'rating_drawing', 'rating_parsed', 'rating_agreement', 'confidence_parsed', 'note_ts',
    'note_ts_available', 'note_ts_reason', 'sr_line_count', 'source'];
  const vals = [sqlTs(row.harvested_at), sqlStr(row.vintage_date), sqlStr(row.symbol), sqlStr(row.tv_symbol),
    sqlStr(row.note_kind), sqlStr(row.note_text), sqlNum(row.note_len), sqlStr(row.rating_drawing),
    sqlStr(row.rating_parsed), sqlStr(row.rating_agreement), sqlStr(row.confidence_parsed), 'NULL',
    sqlBool(row.note_ts_available), sqlStr(row.note_ts_reason), sqlNum(row.sr_line_count), sqlStr(row.source)];
  return `INSERT INTO ${NOTES_TABLE} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
}

export function levelInsert(row) {
  const cols = ['harvested_at', 'vintage_date', 'symbol', 'drawing_id', 'level_price', 'level_rank', 'source'];
  const vals = [sqlTs(row.harvested_at), sqlStr(row.vintage_date), sqlStr(row.symbol), sqlStr(row.drawing_id),
    sqlNum(row.level_price), sqlNum(row.level_rank), sqlStr(row.source)];
  return `INSERT INTO ${LEVELS_TABLE} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = openClient();
  await client.init();

  const tools = await client.listTools();
  const leaked = ['ui_evaluate', 'ui_click', 'ui_type_text', 'draw_shape', 'draw_clear', 'alert_create', 'watchlist_add']
    .filter((t) => tools.includes(t));
  console.error(`[harvest] surface: ${tools.length} tools; forbidden present: ${leaked.length ? leaked.join(',') : 'none'}`);
  if (leaked.length) { console.error('[harvest] ABORT — a writer or generic driver leaked into the surface'); client.close(); process.exit(2); }

  const before = await client.call('chart_get_state');

  let universe = args.symbols;
  if (args.fromWatchlist || !universe.length) {
    const wl = await client.call('watchlist_get');
    universe = (wl.symbols || []).map((s) => s.symbol);
    console.error(`[harvest] universe from active watchlist "${wl.list_name}": ${universe.length} symbols`);
    console.error('[harvest] NOTE: watchlist_get reads rendered DOM rows only; a virtualised list under-reports.');
  }
  if (!universe.length) { console.error('[harvest] no universe — nothing to do'); client.close(); process.exit(3); }

  const harvestedAt = new Date().toISOString();
  const noteRows = []; const levelRows = []; const failures = [];

  /**
   * Stale-chart guard.
   *
   * chart_get_state reporting the right symbol is NOT proof the data changed —
   * on 2026-08-18 a terminated TradingView session kept reporting the correct
   * symbol after every switch while serving frozen values. Drawing entity IDs
   * are per-symbol, so an identical NON-EMPTY id set across two different
   * symbols proves the chart's contents did not actually change.
   *
   * Identical note TEXT is deliberately not used as the signal: several symbols
   * legitimately share a short note such as "COUNCIL - SELL".
   */
  let prevIds = null; let prevSymbol = null; let staleStreak = 0;
  const STALE_ABORT_AFTER = 3;

  for (const tv of universe) {
    const bare = tv.includes(':') ? tv.split(':')[1] : tv;
    try {
      await client.call('chart_set_symbol', { symbol: tv });
      await sleep(args.settleMs);
      const st = await client.call('chart_get_state');
      if (st?.symbol !== tv) {
        failures.push({ symbol: bare, reason: `chart holds ${st?.symbol}` });
        console.error(`  ${bare.padEnd(6)} SKIP — chart holds ${st?.symbol}`);
        continue;
      }

      const note = await client.call('notes_get');
      const dl = await client.call('draw_list');
      const texts = (dl.shapes || []).filter((s) => s.name === 'text');
      const lines = (dl.shapes || []).filter((s) => s.name === 'horizontal_line');

      let drawingText = null;
      if (texts.length) {
        const props = await client.call('draw_get_properties', { entity_id: texts[0].id });
        drawingText = props?.properties?.text ?? null;
      }
      const levels = [];
      for (const l of lines) {
        const props = await client.call('draw_get_properties', { entity_id: l.id });
        const price = props?.points?.[0]?.price;
        if (Number.isFinite(price)) levels.push({ id: l.id, price });
      }

      const idSet = (dl.shapes || []).map((x) => x.id).sort().join(',');
      if (idSet && idSet === prevIds) {
        staleStreak++;
        console.error(`  ${bare.padEnd(6)} STALE? identical drawing ids to ${prevSymbol} (streak ${staleStreak}/${STALE_ABORT_AFTER})`);
        failures.push({ symbol: bare, reason: `identical drawing ids to ${prevSymbol} — chart likely frozen` });
        if (staleStreak >= STALE_ABORT_AFTER) {
          console.error(`\n*** ABORTING SWEEP — ${staleStreak} consecutive symbols returned identical drawing ids.`);
          console.error('    The TradingView chart is almost certainly frozen (session disconnected?).');
          console.error('    Rows collected so far are kept; the rest of the universe was NOT harvested.');
          break;
        }
        continue;
      }
      staleStreak = 0; prevIds = idSet; prevSymbol = bare;

      const parsed = parseRating(note?.note_text);
      const row = buildNoteRow({
        symbol: bare, tvSymbol: tv, note: note ?? {}, parsed, drawingText,
        srLineCount: levels.length, vintageDate: args.vintage, harvestedAt,
      });
      noteRows.push(row);
      levelRows.push(...buildLevelRows({ symbol: bare, levels, vintageDate: args.vintage, harvestedAt }));

      console.error(`  ${bare.padEnd(6)} kind=${row.note_kind.padEnd(8)} drawing=${String(row.rating_drawing).padEnd(11)} parsed=${String(row.rating_parsed).padEnd(11)} agree=${String(row.rating_agreement).padEnd(8)} len=${String(row.note_len).padStart(4)} lines=${levels.length}`);
    } catch (err) {
      failures.push({ symbol: bare, reason: err.message });
      console.error(`  ${bare.padEnd(6)} ERROR — ${err.message}`);
    }
  }

  if (before?.symbol) {
    await client.call('chart_set_symbol', { symbol: before.symbol });
    console.error(`[harvest] chart restored to ${before.symbol}`);
  }
  client.close();

  // ---- Persist. QuestDB when reachable, else spool for a later drain. ------
  let wrote = 0; let spooled = 0;
  const statements = [...noteRows.map(noteInsert), ...levelRows.map(levelInsert)];
  if (args.questdb) {
    const exec = async (sql) => {
      const res = await fetch(`http://${args.host}:${args.port}/exec?query=${encodeURIComponent(sql)}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const b = await res.json().catch(() => ({}));
      if (b?.error) throw new Error(b.error);
    };
    try {
      await exec(NOTES_DDL);
      await exec(LEVELS_DDL);
      for (const s of statements) { await exec(s); wrote++; }
      console.error(`[harvest] QuestDB: ${wrote} statements applied`);
    } catch (err) {
      console.error(`[harvest] QuestDB unavailable (${err.message}) — spooling instead`);
    }
  } else {
    console.error('[harvest] QuestDB not requested — spooling');
  }
  if (wrote < statements.length) {
    mkdirSync(dirname(args.spool), { recursive: true });
    const payload = [
      ...noteRows.map((r) => ({ table: NOTES_TABLE, row: r })),
      ...levelRows.map((r) => ({ table: LEVELS_TABLE, row: r })),
    ];
    appendFileSync(args.spool, payload.map((x) => JSON.stringify(x)).join('\n') + '\n');
    spooled = payload.length;
    console.error(`[harvest] spooled ${spooled} rows -> ${args.spool}`);
  }

  // ---- Summary ------------------------------------------------------------
  const byKind = {};
  for (const r of noteRows) byKind[r.note_kind] = (byKind[r.note_kind] || 0) + 1;
  const agree = noteRows.filter((r) => r.rating_agreement === 'agree').length;
  const mismatch = noteRows.filter((r) => r.rating_agreement === 'mismatch').length;
  const nullAgree = noteRows.filter((r) => r.rating_agreement === 'unknown').length;
  console.error('\n=== HARVEST SUMMARY ===');
  console.error(`attempted        : ${universe.length}`);
  console.error(`rows             : ${noteRows.length} notes, ${levelRows.length} levels`);
  console.error(`failures         : ${failures.length}${failures.length ? ' -> ' + JSON.stringify(failures) : ''}`);
  console.error(`by note_kind     : ${JSON.stringify(byKind)}`);
  console.error(`rating agreement : ${agree} agree, ${mismatch} MISMATCH, ${nullAgree} n/a`);
  if (mismatch) console.error(`mismatched       : ${noteRows.filter((r) => r.rating_agreement === 'mismatch').map((r) => `${r.symbol}(drawing=${r.rating_drawing} parsed=${r.rating_parsed})`).join(', ')}`);
  console.error(`vintage_date     : ${args.vintage} (batch metadata; note_ts null by design)`);
  console.error(`persisted        : ${wrote} to QuestDB, ${spooled} spooled`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
