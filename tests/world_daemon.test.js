/**
 * Tests for the daemon's data-integrity guards.
 *
 * These cover the two races found in the first live run: reading a quote before
 * a timeframe switch landed (which mislabelled every real-time symbol as a
 * 13-hour-stale feed), and reading a quote before a symbol switch landed (which
 * would file one symbol's price under another's name).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { confirmChart, quoteFor, normaliseVolume, buildRow } from '../scripts/world_daemon.mjs';

const FAST = { tries: 4, gapMs: 1 };

describe('confirmChart', () => {
  it('waits for the chart to actually report the requested state', async () => {
    let n = 0;
    const client = { call: async () => (++n < 3
      ? { success: true, symbol: 'TVC:DXY', resolution: '1D' }
      : { success: true, symbol: 'CME_MINI:ES1!', resolution: '1' }) };
    const r = await confirmChart(client, { symbol: 'CME_MINI:ES1!', timeframe: '1' }, FAST);
    assert.equal(r.ok, true);
  });

  it('reports failure rather than proceeding when the switch never lands', async () => {
    const client = { call: async () => ({ success: true, symbol: 'TVC:DXY', resolution: '1D' }) };
    const r = await confirmChart(client, { symbol: 'CME_MINI:ES1!', timeframe: '1' }, FAST);
    assert.equal(r.ok, false);
    assert.equal(r.state.symbol, 'TVC:DXY', 'caller must be able to log what the chart actually held');
  });

  it('matches resolution as a string so numeric timeframes compare correctly', async () => {
    const client = { call: async () => ({ success: true, symbol: 'X', resolution: 1 }) };
    assert.equal((await confirmChart(client, { symbol: 'X', timeframe: '1' }, FAST)).ok, true);
  });
});

describe('quoteFor', () => {
  it('rejects a quote belonging to a different symbol', async () => {
    const client = { call: async () => ({ success: true, symbol: 'TVC:DXY', last: 99.6, time: 1 }) };
    const q = await quoteFor(client, 'CME_MINI:ES1!', FAST);
    assert.equal(q.success, false);
    assert.match(q.error, /symbol mismatch/);
    assert.match(q.error, /TVC:DXY/);
  });

  it('returns the quote once the right symbol appears', async () => {
    let n = 0;
    const client = { call: async () => (++n < 3
      ? { success: true, symbol: 'TVC:DXY', last: 99.6 }
      : { success: true, symbol: 'CME_MINI:ES1!', last: 7740 }) };
    const q = await quoteFor(client, 'CME_MINI:ES1!', FAST);
    assert.equal(q.success, true);
    assert.equal(q.last, 7740);
  });
});

describe('normaliseVolume', () => {
  it('emits NULL for TVC synthetics rather than a misleading zero', () => {
    assert.deepEqual(normaliseVolume({ exchange: 'TVC', volume: 0 }), { volume: null, volume_available: false });
  });
  it('keeps real exchange volume', () => {
    assert.deepEqual(normaliseVolume({ exchange: 'CME', volume: 80175 }), { volume: 80175, volume_available: true });
  });
  it('treats a genuine zero on a real exchange as real', () => {
    assert.deepEqual(normaliseVolume({ exchange: 'NYMEX', volume: 0 }), { volume: 0, volume_available: true });
  });
});

describe('buildRow', () => {
  const sym = { key: 'ES1!', tv: 'CME_MINI:ES1!', role: 'us_equity_index', expect_realtime: false };

  it('computes session_change_pct from the cached session open', () => {
    const now = 2_000_000;
    const row = buildRow({ sym, quote: { last: 7740, time: now - 620, exchange: 'CME', volume: 31 }, session: { open: 7766, high: 7770.5, low: 7726 }, nowS: now, cycle: 3 });
    assert.ok(Math.abs(row.session_change_pct - (-0.3348)) < 0.01, `got ${row.session_change_pct}`);
    assert.equal(row.session_open, 7766);
    assert.equal(row.realtime, false);
    assert.equal(row.realtime_drift, false);
  });

  it('leaves session_change_pct null when no session open is cached', () => {
    const now = 2_000_000;
    const row = buildRow({ sym, quote: { last: 7740, time: now - 620, exchange: 'CME' }, session: null, nowS: now, cycle: 1 });
    assert.equal(row.session_change_pct, null, 'must be null, never a fabricated 0');
  });

  it('flags drift when a symbol stops matching its expected freshness', () => {
    const now = 2_000_000;
    const row = buildRow({ sym, quote: { last: 7740, time: now - 20, exchange: 'CME' }, session: { open: 7700 }, nowS: now, cycle: 1 });
    assert.equal(row.realtime, true);
    assert.equal(row.realtime_drift, true, 'ES turning real-time is itself notable');
  });
});
