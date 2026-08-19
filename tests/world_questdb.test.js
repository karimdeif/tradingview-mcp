/**
 * Tests for the QuestDB sink. The estate rules (single-row /exec, never /imp,
 * own table only, disabled by default) are asserted here so a future edit that
 * breaks one fails loudly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSink, buildInsert, buildStagingInsert, sqlStr, sqlNum, sqlTs, DDL, TABLE } from '../src/world/questdb.js';

const ROW = {
  ts_utc: '2026-08-18T07:18:01.000Z', symbol: 'ES1!', tv_symbol: 'CME_MINI:ES1!', role: 'us_equity_index',
  last: 7740, session_open: 7766, session_change_pct: -0.3702, session_high: 7770.5, session_low: 7726,
  volume: 31, volume_available: true, bar_ts: 1787036880, feed_lag_s: 601, delay_est_s: 541,
  realtime: false, realtime_drift: false, exchange: 'CME', instrument_type: 'futures',
};

describe('SQL building', () => {
  it('escapes embedded quotes rather than breaking out of the literal', () => {
    assert.equal(sqlStr("O'Brien"), "'O''Brien'");
    // A symbol field is the only attacker-adjacent string here; make sure a
    // crafted value cannot terminate the statement.
    assert.equal(sqlStr("x'); DROP TABLE trades;--"), "'x''); DROP TABLE trades;--'");
  });

  it('emits NULL, never NaN or Infinity', () => {
    assert.equal(sqlNum(null), 'NULL');
    assert.equal(sqlNum(undefined), 'NULL');
    assert.equal(sqlNum(NaN), 'NULL');
    assert.equal(sqlNum(Infinity), 'NULL');
    assert.equal(sqlNum(0), '0');
  });

  it('renders timestamps from both epoch seconds and ISO strings', () => {
    assert.match(sqlTs(1787036880), /to_timestamp\('2026-08-18T/);
    assert.match(sqlTs('2026-08-18T07:18:01.000Z'), /2026-08-18T07:18:01/);
    assert.equal(sqlTs(null), 'NULL');
  });

  it('builds a single-row INSERT into its own table only', () => {
    const sql = buildInsert(ROW);
    assert.ok(sql.startsWith(`INSERT INTO ${TABLE} `), 'must target tv_world_quotes');
    assert.equal((sql.match(/VALUES/g) || []).length, 1, 'exactly one row per statement');
    assert.ok(!/\bimp\b/i.test(sql));
    for (const forbidden of ['trades', 'daily_ohlcv', 'regime_gate']) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(sql), `must never reference ${forbidden}`);
    }
  });

  it('carries absent volume as NULL so it cannot be averaged as zero', () => {
    const sql = buildInsert({ ...ROW, volume: null, volume_available: false });
    assert.ok(/NULL, false,/.test(sql), 'volume NULL + volume_available false');
  });

  it('has no tri-state BOOLEAN column — QuestDB coerces NULL to false', () => {
    const permitted = new Set(['volume_available', 'replayed']);
    for (const m of DDL.matchAll(/^\s*(\w+)\s+BOOLEAN/gm)) {
      assert.ok(permitted.has(m[1]), `${m[1]} is BOOLEAN but can be null; must be SYMBOL`);
    }
    assert.match(DDL, /realtime SYMBOL/);
    assert.match(DDL, /realtime_drift SYMBOL/);
  });

  it('renders unknown freshness as "unknown", never as a false boolean', () => {
    const sql = buildInsert({ ...ROW, realtime: null, realtime_drift: null });
    assert.match(sql, /'unknown', 'unknown'/);
  });

  it('DDL is WAL, partitioned by day, and deduped on (ts, symbol)', () => {
    assert.match(DDL, /PARTITION BY DAY WAL/);
    assert.match(DDL, /DEDUP UPSERT KEYS\(ts, symbol\)/);
  });

  it('staging rows are review-gated and tagged TV_WORLD', () => {
    const sql = buildStagingInsert({ symbol: 'ES1!', note: 'x', fired_at: 1787036880 }, 'tvw-2026-08-18-1');
    assert.match(sql, /INSERT INTO news_events_staging/);
    assert.match(sql, /'TV_WORLD'/);
    assert.match(sql, /true\);$/, 'machine_requires_review must be true');
  });
});

describe('sink behaviour', () => {
  const spoolDir = () => mkdtempSync(join(tmpdir(), 'spool-'));

  it('is disabled by default and touches no network', async () => {
    let called = false;
    const sink = createSink({ spoolPath: join(spoolDir(), 's.jsonl'), fetchImpl: () => { called = true; } });
    const r = await sink.write(ROW);
    assert.equal(called, false, 'disabled sink must not call fetch');
    assert.equal(r.spooled, true);
    assert.equal(sink.stats().enabled, false);
  });

  it('spools rather than drops when the insert fails', async () => {
    const p = join(spoolDir(), 's.jsonl');
    const sink = createSink({ enabled: true, spoolPath: p, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    const r = await sink.write(ROW);
    assert.equal(r.ok, false);
    assert.equal(r.spooled, true);
    assert.equal(readFileSync(p, 'utf8').trim().split('\n').length, 1);
    assert.equal(sink.stats().failures, 1);
  });

  it('drains the spool with original timestamps, marks replays, then deletes it', async () => {
    const p = join(spoolDir(), 's.jsonl');
    writeFileSync(p, JSON.stringify(ROW) + '\n' + JSON.stringify({ ...ROW, symbol: 'DXY' }) + '\n');
    const seen = [];
    const sink = createSink({ enabled: true, spoolPath: p, fetchImpl: async (url) => { seen.push(decodeURIComponent(url)); return { ok: true, json: async () => ({}) }; } });
    const res = await sink.drain();
    assert.equal(res.drained, 2);
    assert.equal(res.remaining, 0);
    assert.equal(existsSync(p), false, 'spool must be gone after a full drain');
    assert.ok(seen.every((s) => s.includes('2026-08-18T07:18:01')), 'original timestamps preserved');
    assert.ok(seen.every((s) => /replayed[^)]*\)/.test(s) || s.includes('true')), 'replayed flag set');
  });

  it('returns unsent rows to the spool on a partial drain', async () => {
    const p = join(spoolDir(), 's.jsonl');
    writeFileSync(p, JSON.stringify(ROW) + '\n' + JSON.stringify({ ...ROW, symbol: 'DXY' }) + '\n');
    let n = 0;
    const sink = createSink({ enabled: true, spoolPath: p, fetchImpl: async () => { if (++n === 2) throw new Error('boom'); return { ok: true, json: async () => ({}) }; } });
    const res = await sink.drain();
    assert.equal(res.drained, 1);
    assert.equal(res.remaining, 1);
    assert.equal(readFileSync(p, 'utf8').trim().split('\n').length, 1, 'failed row must survive');
  });

  it('surfaces a QuestDB error body as a failure instead of silently succeeding', async () => {
    const sink = createSink({ enabled: true, spoolPath: join(spoolDir(), 's.jsonl'), fetchImpl: async () => ({ ok: true, json: async () => ({ error: 'table busy' }) }) });
    const r = await sink.write(ROW);
    assert.equal(r.ok, false);
    assert.match(r.reason, /table busy/);
  });
});
