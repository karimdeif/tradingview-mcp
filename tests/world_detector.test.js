/**
 * Tests for the deterministic shock detector.
 * The guards matter more than the thresholds: a false "calm" reading is the
 * dangerous failure here, so staleness/min-sample/hysteresis are tested hard.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDetector, DEFAULT_RULES } from '../src/world/detector.js';

const T = 1_000_000;
const rt = { feed_lag_s: 40, realtime: true };
const delayed = { feed_lag_s: 620, realtime: false };

function feed(d, symbol, pts, meta = rt) {
  for (const [t, values] of pts) d.push(symbol, t, values, meta);
}

describe('delta rules', () => {
  it('fires when the 10Y moves 5bp inside the window', () => {
    const d = createDetector();
    feed(d, 'US10Y', [[T, { last: 4.70 }], [T + 200, { last: 4.72 }], [T + 400, { last: 4.74 }], [T + 600, { last: 4.76 }]]);
    const f = d.evaluate(T + 600);
    assert.equal(f.length, 1);
    assert.equal(f[0].rule_id, 'us10y_yield_shock');
    assert.ok(Math.abs(f[0].observed - 0.06) < 1e-6);
  });

  it('does not fire on a move below threshold', () => {
    const d = createDetector();
    feed(d, 'US10Y', [[T, { last: 4.70 }], [T + 200, { last: 4.71 }], [T + 400, { last: 4.72 }], [T + 600, { last: 4.73 }]]);
    assert.deepEqual(d.evaluate(T + 600), []);
  });

  it('GUARD: too few samples cannot fire, even on a huge apparent delta', () => {
    const d = createDetector();
    // A restart leaves two points far apart in value — must not be a "shock".
    feed(d, 'DXY', [[T, { last: 99.0 }], [T + 100, { last: 105.0 }]]);
    assert.deepEqual(d.evaluate(T + 100), [], 'min_samples must suppress restart artefacts');
  });

  it('GUARD: a stale sample is never evaluated — dead feed != calm market', () => {
    const d = createDetector();
    feed(d, 'DXY', [[T, { last: 99.0 }], [T + 100, { last: 99.2 }], [T + 200, { last: 99.4 }], [T + 300, { last: 100.5 }]]);
    // Same data, evaluated long after the last sample arrived.
    assert.deepEqual(d.evaluate(T + 300 + 5000), [], 'stale input must not produce a verdict');
  });

  it('respects cooldown after firing', () => {
    const d = createDetector();
    feed(d, 'GOLD', [[T, { last: 4400 }], [T + 100, { last: 4420 }], [T + 200, { last: 4440 }], [T + 300, { last: 4460 }]]);
    assert.equal(d.evaluate(T + 300).length, 1);
    d.push('GOLD', T + 400, { last: 4500 }, rt);
    assert.equal(d.evaluate(T + 400).length, 0, 'cooldown must suppress the immediate re-fire');
  });
});

describe('level rules and hysteresis', () => {
  it('fires once when ES breaches -1.5%, not every cycle', () => {
    const d = createDetector();
    d.push('ES1!', T, { session_change_pct: -1.6 }, delayed);
    assert.equal(d.evaluate(T).length, 1);
    d.push('ES1!', T + 120, { session_change_pct: -1.8 }, delayed);
    assert.equal(d.evaluate(T + 120).length, 0, 'must not restorm while parked below the line');
    d.push('ES1!', T + 240, { session_change_pct: -2.4 }, delayed);
    assert.equal(d.evaluate(T + 240).length, 0);
  });

  it('re-arms only after recovering past the rearm level, then can fire again', () => {
    const d = createDetector();
    d.push('ES1!', T, { session_change_pct: -1.6 }, delayed);
    assert.equal(d.evaluate(T).length, 1);
    // Partial recovery, still below rearm_above (-1.0) => stays disarmed.
    d.push('ES1!', T + 300, { session_change_pct: -1.2 }, delayed);
    assert.equal(d.evaluate(T + 300).length, 0);
    // Full recovery re-arms.
    d.push('ES1!', T + 600, { session_change_pct: -0.3 }, delayed);
    assert.equal(d.evaluate(T + 600).length, 0);
    // New breach, past the 3600s cooldown.
    d.push('ES1!', T + 4000, { session_change_pct: -1.7 }, delayed);
    assert.equal(d.evaluate(T + 4000).length, 1, 'a genuinely new breach must fire');
  });

  it('does not fire on a null session_change_pct', () => {
    const d = createDetector();
    d.push('ES1!', T, { session_change_pct: null }, delayed);
    assert.deepEqual(d.evaluate(T), []);
  });
});

describe('event provenance', () => {
  it('stamps the delayed-feed warning onto ES/NQ events', () => {
    const d = createDetector();
    d.push('NQ1!', T, { session_change_pct: -2.0 }, delayed);
    const [ev] = d.evaluate(T);
    assert.equal(ev.delayed_feed, true);
    assert.equal(ev.realtime, false);
    assert.match(ev.freshness_warning, /DELAYED FEED/);
    assert.match(ev.freshness_warning, /10min behind/);
  });

  it('leaves no freshness warning on a real-time symbol', () => {
    const d = createDetector();
    feed(d, 'US10Y', [[T, { last: 4.70 }], [T + 200, { last: 4.72 }], [T + 400, { last: 4.74 }], [T + 600, { last: 4.77 }]]);
    const [ev] = d.evaluate(T + 600);
    assert.equal(ev.delayed_feed, false);
    assert.equal(ev.freshness_warning, null);
  });

  it('every event is advisory and review-gated — §8 veto-only posture', () => {
    const d = createDetector();
    d.push('ES1!', T, { session_change_pct: -3 }, delayed);
    const [ev] = d.evaluate(T);
    assert.equal(ev.advisory_only, true);
    assert.equal(ev.machine_requires_review, true);
  });
});

describe('rule set sanity', () => {
  it('every rule carries all four guards', () => {
    for (const r of DEFAULT_RULES) {
      assert.ok(r.max_staleness_s > 0, `${r.id} needs max_staleness_s`);
      assert.ok(r.cooldown_s > 0, `${r.id} needs cooldown_s`);
      assert.ok(r.min_samples >= 1, `${r.id} needs min_samples`);
      if (r.kind === 'level_below') assert.ok(typeof r.rearm_above === 'number', `${r.id} needs hysteresis`);
    }
  });

  it('delayed symbols get a staleness budget that accounts for the ~10min feed', () => {
    for (const id of ['es_session_drawdown', 'nq_session_drawdown']) {
      const r = DEFAULT_RULES.find((x) => x.id === id);
      assert.ok(r.max_staleness_s >= 600 + 120, `${id} would reject its own feed's normal lag`);
    }
  });
});
