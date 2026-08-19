#!/usr/bin/env node
/**
 * Drain the council-notes spool into QuestDB (karimdeif fork).
 *
 * Separate from the harvest on purpose. The sweep is long and may cross the
 * 14:30 Cairo write blackout; spooling locally is always allowed, so the sweep
 * runs freely and the DB write happens as its own gated step.
 *
 * Rules enforced here:
 *   - questdb.lan by NAME only. Refuses to run against an IP literal.
 *   - Single-row INSERTs via /exec. Never /imp (the crash trigger).
 *   - Only tv_council_notes / tv_council_levels. Refuses any other target.
 *   - Write window guard (src/research/write_window.js).
 *   - DEDUP UPSERT makes a retried partial drain idempotent; failed rows go
 *     back to the spool and the file is only removed when empty.
 *
 * Usage:
 *   node scripts/council_drain.mjs [--host questdb.lan] [--dry-run] [--force-window]
 */
import { existsSync, readFileSync, renameSync, appendFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { NOTES_DDL, LEVELS_DDL, NOTES_TABLE, LEVELS_TABLE } from '../src/research/council.js';
import { questdbWriteAllowed, fitsBeforeBlackout } from '../src/research/write_window.js';
import { noteInsert, levelInsert } from './council_harvest.mjs';

const HOME = process.env.HOME || '/tmp';
const ALLOWED_TABLES = new Set([NOTES_TABLE, LEVELS_TABLE]);

function parseArgs(argv) {
  const a = {
    host: 'questdb.lan', port: 9000, dryRun: false, forceWindow: false,
    spool: join(HOME, 'claude-a15-20260818', 'data', 'spool', 'tv_council_notes.spool.jsonl'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') a.host = argv[++i];
    else if (argv[i] === '--spool') a.spool = argv[++i];
    else if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--force-window') a.forceWindow = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --- Name discipline: the estate rule is questdb.lan, never an IP. --------
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(args.host)) {
    console.error(`REFUSED: host "${args.host}" is an IP literal. The estate rule is to address QuestDB as questdb.lan only.`);
    process.exit(2);
  }

  // --- Write window --------------------------------------------------------
  const win = questdbWriteAllowed();
  console.error(`[drain] Cairo ${win.cairo_time} — QuestDB writes ${win.allowed ? 'ALLOWED' : 'BLOCKED'} (${win.reason})`);
  if (!win.allowed && !args.forceWindow) {
    console.error(`[drain] holding. Retry in ~${win.minutes_until_allowed}min (after 18:30 Cairo). Spool is intact; nothing was written.`);
    process.exit(3);
  }

  if (!existsSync(args.spool)) { console.error('[drain] no spool file — nothing to drain'); process.exit(0); }
  const lines = readFileSync(args.spool, 'utf8').split('\n').filter(Boolean);
  console.error(`[drain] ${lines.length} spooled rows`);

  // Refuse to START a drain that cannot finish before the blackout opens.
  // ~5 statements/sec is a conservative single-row /exec rate.
  const estMin = (lines.length / 5) / 60 + 0.5;
  const fit = fitsBeforeBlackout(estMin);
  if (!fit.fits && !args.forceWindow) {
    console.error(`[drain] REFUSED to start: ${fit.reason}. A partial write inside the scored window is worse than waiting.`);
    process.exit(4);
  }

  const exec = async (sql) => {
    if (args.dryRun) return;
    const res = await fetch(`http://${args.host}:${args.port}/exec?query=${encodeURIComponent(sql)}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = await res.json().catch(() => ({}));
    if (b?.error) throw new Error(b.error);
  };

  try {
    await exec(NOTES_DDL);
    await exec(LEVELS_DDL);
    console.error('[drain] tables ensured');
  } catch (err) {
    console.error(`[drain] could not reach QuestDB (${err.message}) — spool untouched`);
    process.exit(5);
  }

  // A dry run must NEVER mutate the spool. An earlier version renamed the file,
  // no-op'd every insert, then unlinked it — destroying 39 harvested rows while
  // reporting "complete". Dry run now reads in place and touches nothing.
  const working = args.dryRun ? args.spool : `${args.spool}.draining`;
  if (!args.dryRun) renameSync(args.spool, working);
  let ok = 0; const failed = []; const rejected = [];

  for (const line of readFileSync(working, 'utf8').split('\n').filter(Boolean)) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!ALLOWED_TABLES.has(rec.table)) { rejected.push(rec.table); continue; }
    const sql = rec.table === NOTES_TABLE ? noteInsert(rec.row) : levelInsert(rec.row);
    try { await exec(sql); ok++; } catch { failed.push(line); }
  }

  if (args.dryRun) {
    console.error(`[drain] DRY RUN: ${ok} rows would be written. Spool left intact at ${args.spool}`);
  } else if (failed.length) {
    appendFileSync(args.spool, failed.join('\n') + '\n');
    console.error(`[drain] partial: ${ok} landed, ${failed.length} returned to spool`);
  } else {
    console.error(`[drain] complete: ${ok} rows landed`);
  }
  if (rejected.length) console.error(`[drain] REJECTED rows targeting non-council tables: ${[...new Set(rejected)].join(', ')}`);
  if (!args.dryRun) unlinkSync(working);

  if (!args.dryRun && !failed.length) {
    try {
      const res = await fetch(`http://${args.host}:${args.port}/exec?query=${encodeURIComponent(`SELECT count() FROM ${NOTES_TABLE};`)}`, { signal: AbortSignal.timeout(10000) });
      const b = await res.json();
      console.error(`[drain] verify: ${NOTES_TABLE} now holds ${JSON.stringify(b?.dataset?.[0]?.[0] ?? 'unknown')} rows`);
    } catch (err) {
      console.error(`[drain] verify query failed: ${err.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
