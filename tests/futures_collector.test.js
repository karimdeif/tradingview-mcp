/**
 * Tests for scripts/futures_collector.mjs.
 * Focus on the two rules the recon showed are easy to get wrong:
 * validate-on-quote-never-on-set, and per-row freshness classification.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify, sweep, SYMBOLS, REALTIME_THRESHOLD_S } from '../scripts/futures_collector.mjs';

describe('classify', () => {
  it('treats a fresh 1m bar as real-time', () => {
    const c = classify(1000, 1000 - 49);
    assert.equal(c.realtime, true);
    assert.equal(c.feed_lag_s, 49);
    assert.equal(c.delay_est_s, 0);
  });

  it('tolerates a sparse real-time feed that skips 1m bars (TVC:US10Y at 117s)', () => {
    const c = classify(1000, 1000 - 117);
    assert.equal(c.realtime, true, 'sparse ticks must not be misread as a delayed feed');
  });

  it('flags a ~10min delayed feed and subtracts one bar width', () => {
    const c = classify(1000, 1000 - 657);
    assert.equal(c.realtime, false);
    assert.equal(c.feed_lag_s, 657);
    assert.equal(c.delay_est_s, 597);
  });

  it('nulls out when there is no bar timestamp', () => {
    assert.deepEqual(classify(1000, null), { feed_lag_s: null, realtime: null, delay_est_s: null });
  });

  it('puts the boundary at the documented threshold', () => {
    assert.equal(classify(1000, 1000 - REALTIME_THRESHOLD_S).realtime, true);
    assert.equal(classify(1000, 1000 - REALTIME_THRESHOLD_S - 1).realtime, false);
  });
});

/** Scripted client: chart_set_symbol always claims success, like the real one. */
function fakeClient({ quotes = {}, state = { success: true, symbol: 'TVC:USOIL', resolution: '1D' } } = {}) {
  const calls = [];
  return {
    calls,
    async call(name, args = {}) {
      calls.push([name, args]);
      if (name === 'chart_get_state') return state;
      if (name === 'chart_set_symbol') return { success: true, symbol: args.symbol };
      if (name === 'chart_set_timeframe') return { success: true };
      if (name === 'quote_get') {
        const cur = calls.filter(c => c[0] === 'chart_set_symbol').pop()?.[1].symbol;
        return quotes[cur] ?? { success: false, error: 'Could not retrieve quote. The chart may still be loading.' };
      }
      if (name === 'data_get_ohlcv') return { success: true, open: 1, high: 2, low: 0, close: 1, change: 0, change_pct: '0%', avg_volume: 10, bar_count: 100, period: { from: 1, to: 2 } };
      return { success: false, error: 'unexpected tool' };
    },
  };
}

const nowS = () => Math.floor(Date.now() / 1000);

describe('sweep', () => {
  const two = [
    { key: 'ES1!', tv: 'CME_MINI:ES1!', role: 'us_equity_index', expect_realtime: false },
    { key: 'DXY',  tv: 'TVC:DXY',       role: 'dollar',          expect_realtime: true  },
  ];

  it('emits no row for a ticker that sets successfully but never quotes', async () => {
    // Exactly the CME:ES1! failure mode: set says true, quote never arrives.
    const client = fakeClient({ quotes: { 'TVC:DXY': { success: true, last: 99.6, time: nowS() - 40 } } });
    const r = await sweep({ client, symbols: two, settleSymbolMs: 0, settleTfMs: 0 });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].symbol, 'DXY');
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].symbol, 'ES1!');
    assert.equal(r.errors[0].set_reported, true, 'must record that set lied');
  });

  it('carries per-row freshness so a consumer need not know the taxonomy', async () => {
    const t = nowS();
    const client = fakeClient({ quotes: {
      'CME_MINI:ES1!': { success: true, last: 7737.75, time: t - 657, volume: 80175 },
      'TVC:DXY':       { success: true, last: 99.642,  time: t - 49,  volume: 0 },
    } });
    const r = await sweep({ client, symbols: two, settleSymbolMs: 0, settleTfMs: 0 });
    const es = r.rows.find(x => x.symbol === 'ES1!');
    const dxy = r.rows.find(x => x.symbol === 'DXY');
    assert.equal(es.realtime, false);
    assert.ok(es.delay_est_s >= 590, `expected ~597s, got ${es.delay_est_s}`);
    assert.equal(dxy.realtime, true);
    assert.equal(dxy.delay_est_s, 0);
    // Neither should be flagged as drift — both match the recon expectation.
    assert.equal(es.realtime_drift, false);
    assert.equal(dxy.realtime_drift, false);
  });

  it('flags freshness drift when a feed stops matching its recon expectation', async () => {
    const t = nowS();
    const client = fakeClient({ quotes: {
      'CME_MINI:ES1!': { success: true, last: 1, time: t - 30 },   // suddenly real-time
      'TVC:DXY':       { success: true, last: 2, time: t - 900 },  // suddenly stale
    } });
    const r = await sweep({ client, symbols: two, settleSymbolMs: 0, settleTfMs: 0 });
    assert.equal(r.rows.every(x => x.realtime_drift), true);
  });

  it('restores the chart to whatever it was on entry', async () => {
    const client = fakeClient({ quotes: { 'TVC:DXY': { success: true, last: 1, time: nowS() } } });
    const r = await sweep({ client, symbols: two, settleSymbolMs: 0, settleTfMs: 0 });
    assert.equal(r.restored, true);
    const sets = client.calls.filter(c => c[0] === 'chart_set_symbol').map(c => c[1].symbol);
    assert.equal(sets.at(-1), 'TVC:USOIL');
  });

  it('never calls a tool outside the read-only surface', async () => {
    const client = fakeClient({ quotes: { 'TVC:DXY': { success: true, last: 1, time: nowS() } } });
    await sweep({ client, symbols: two, settleSymbolMs: 0, settleTfMs: 0 });
    const allowed = new Set(['chart_get_state','chart_set_symbol','chart_set_timeframe','quote_get','data_get_ohlcv','tv_health_check','symbol_info','symbol_search','capture_screenshot']);
    const used = [...new Set(client.calls.map(c => c[0]))];
    assert.deepEqual(used.filter(u => !allowed.has(u)), []);
  });

  it('separates the session move from the 100-bar window stat', async () => {
    const t = nowS();
    // quote on the 1D chart: session opened at 100, now 110 => +10%.
    // data_get_ohlcv's change_pct spans ~144 days and must NOT be read as the day.
    const client = fakeClient({ quotes: { 'TVC:DXY': { success: true, last: 110, open: 100, time: t - 30 } } });
    const r = await sweep({ client, symbols: [two[1]], settleSymbolMs: 0, settleTfMs: 0 });
    const row = r.rows[0];
    assert.equal(row.session.change, 10);
    assert.equal(row.session.change_pct, 10);
    assert.equal(row.window_100d.change_pct, '0%', 'window stat kept, but under a name that cannot be mistaken for the session');
    assert.ok(!('daily' in row), 'the misleading "daily" key must be gone');
  });

  it('ships the verified tickers, not symbol_search full_names', () => {
    const byKey = Object.fromEntries(SYMBOLS.map(s => [s.key, s.tv]));
    assert.equal(byKey['ES1!'], 'CME_MINI:ES1!');
    assert.equal(byKey['NQ1!'], 'CME_MINI:NQ1!');
    assert.ok(!Object.values(byKey).some(t => t.startsWith('CME:')), 'CME: prefix never produces data');
  });
});
