/**
 * Tests for the feed-integrity gate, built from the real 2026-08-18 incident:
 * TradingView terminated the desktop session (one active session per account),
 * and every symbol then returned the same frozen quote while health checks
 * still reported healthy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assessFeedIntegrity, integrityAlarmText } from '../src/world/integrity.js';

const row = (symbol, last, bar_ts, extra = {}) => ({ symbol, last, bar_ts, realtime: true, realtime_drift: false, ...extra });

describe('assessFeedIntegrity', () => {
  it('passes a normal cycle with distinct prices and timestamps', () => {
    const a = assessFeedIntegrity([
      row('ES1!', 7740, 100), row('NQ1!', 29871, 101), row('DXY', 99.64, 102),
      row('GC1!', 4454, 103), row('US10Y', 4.74, 104),
    ]);
    assert.equal(a.healthy, true, a.reasons.join('; '));
  });

  it('CATCHES THE REAL INCIDENT: every symbol frozen on the same price', () => {
    // Verbatim shape of the 20 contaminated rows: oil's 84.38 under every name.
    const rows = ['ES1!','NQ1!','DXY','BZ1!','CL1!','GC1!','US10Y','USOIL','UKOIL','GOLD']
      .map((s) => row(s, 84.38, 1787004000, { realtime: false, realtime_drift: ['DXY','US10Y','USOIL','UKOIL','GOLD'].includes(s) }));
    const a = assessFeedIntegrity(rows);
    assert.equal(a.healthy, false);
    assert.equal(a.detail.distinct_last_values, 1);
    assert.ok(a.reasons.some((r) => /distinct price/.test(r)));
    assert.ok(a.reasons.some((r) => /one bar timestamp/.test(r)));
    assert.ok(a.reasons.some((r) => /expected real-time are stale/.test(r)));
  });

  it('flags an empty cycle as unhealthy, not as quiet', () => {
    const a = assessFeedIntegrity([]);
    assert.equal(a.healthy, false);
    assert.match(a.reasons[0], /no rows/);
  });

  it('flags several real-time symbols going stale together', () => {
    const a = assessFeedIntegrity([
      row('ES1!', 7740, 100), row('NQ1!', 29871, 101),
      row('DXY', 99.64, 102, { realtime: false, realtime_drift: true }),
      row('GOLD', 4400, 103, { realtime: false, realtime_drift: true }),
      row('US10Y', 4.74, 104, { realtime: false, realtime_drift: true }),
    ]);
    assert.equal(a.healthy, false);
    assert.deepEqual(a.detail.drifted_realtime_symbols, ['DXY', 'GOLD', 'US10Y']);
  });

  it('tolerates a single drifted symbol — one instrument can legitimately go quiet', () => {
    const a = assessFeedIntegrity([
      row('ES1!', 7740, 100), row('NQ1!', 29871, 101), row('DXY', 99.64, 102),
      row('US10Y', 4.74, 103, { realtime: false, realtime_drift: true }),
    ]);
    assert.equal(a.healthy, true, a.reasons.join('; '));
  });

  it('does not false-positive on two symbols that coincidentally match', () => {
    const a = assessFeedIntegrity([
      row('A', 100, 1), row('B', 100, 2), row('C', 101, 3), row('D', 102, 4), row('E', 103, 5), row('F', 104, 6),
    ]);
    assert.equal(a.healthy, true, a.reasons.join('; '));
  });

  it('alarm text says plainly that this is not a calm market', () => {
    const a = assessFeedIntegrity([]);
    const t = integrityAlarmText(a, 7);
    assert.match(t, /NOT A CALM MARKET/);
    assert.match(t, /DISCARDED/);
    assert.match(t, /one active session per account/);
  });
});
