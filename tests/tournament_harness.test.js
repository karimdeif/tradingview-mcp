/** Pure-function tests for the tournament harness (sol-max pass 9: harness changes lacked tests). */
import { describe, it } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { cellOutcome, parseStrategyTitle, checkResultIntegrity, normTf, bhOwnershipOk, seriesFingerprintOk, completedTailKey, REF_BH } from '../scripts/backtest-tournament.mjs';

describe('cellOutcome (pass 8: incomplete reports must not become NO_TRADES)', () => {
  it('ERROR when unsuccessful', () => assert.equal(cellOutcome({ success: false }), 'ERROR'));
  it('ERROR for zero trades WITHOUT computed buy & hold — incomplete report', () => {
    assert.equal(cellOutcome({ success: true, metrics: { total_trades: 0 } }), 'ERROR');
  });
  it('NO_TRADES for zero trades WITH computed buy & hold (0 is a valid value)', () => {
    assert.equal(cellOutcome({ success: true, metrics: { total_trades: 0, buy_hold_return: 0 } }), 'NO_TRADES');
    assert.equal(cellOutcome({ success: true, metrics: { total_trades: 0, buy_hold_return: 123.4 } }), 'NO_TRADES');
  });
  it('OK when trades exist', () => {
    assert.equal(cellOutcome({ success: true, metrics: { total_trades: 12, buy_hold_return: 1 } }), 'OK');
  });
});

describe('parseStrategyTitle', () => {
  it('positional first string', () => {
    assert.equal(parseStrategyTitle('strategy("My Strat", overlay=true)'), 'My Strat');
  });
  it('title= keyword form', () => {
    assert.equal(parseStrategyTitle('strategy(title="ABUK 1m SMA(70/250)", x=1)'), 'ABUK 1m SMA(70/250)');
  });
  it('multi-line declarations', () => {
    assert.equal(parseStrategyTitle('strategy("Golden Cross Exec — Hard-coded (Watchlist-ready)",\n  overlay=true)'), 'Golden Cross Exec — Hard-coded (Watchlist-ready)');
  });
  it('null when no strategy() present', () => {
    assert.equal(parseStrategyTitle('indicator("not a strategy")'), null);
  });
});

describe('normTf', () => {
  it('D and 1D are equal; intraday numerics compare directly', () => {
    assert.equal(normTf('D'), normTf('1D'));
    assert.equal(normTf('5'), '5');
  });
});

describe('checkResultIntegrity in the harness (G1 lands where it is CALLED)', () => {
  it('flags identical fingerprints across symbols', () => {
    const m = { net_profit_percent: 0.01, total_trades: 5, max_drawdown_percent: 0.02 };
    const out = checkResultIntegrity([{ symbol: 'A', metrics: { ...m } }, { symbol: 'B', metrics: { ...m } }]);
    assert.equal(out.ok, false);
  });
});

describe('B&H ownership (pass 10: change is not ownership)', () => {
  const FIX = { COMI: 166.07, ABUK: 27.07, ARCC: 5.94 }; // legacy raw-B&H fixtures
  it('accepts the true symbol', () => {
    const tvAbs = FIX.COMI * 100000 * 1.01; // 1% engine disagreement
    assert.equal(bhOwnershipOk('COMI', tvAbs, 100000, FIX), true);
  });

  it("REJECTS the reviewer's exact counterexample — ARCC's series under ABUK's label", () => {
    const arccAbs = FIX.ARCC * 100000;
    const r = bhOwnershipOk('ABUK', arccAbs, 100000, FIX);
    assert.notEqual(r, true);
    assert.ok(r.ratio < 0.5);
  });

  it('returns null (not checkable) for unknown symbols or missing B&H', () => {
    assert.equal(bhOwnershipOk('ZZZZ', 1000), null);
    assert.equal(bhOwnershipOk('COMI', null), null);
  });

  it('the band is corroboration, not proof — 13 joint-confusable pairs measured; the fingerprint is the proof', () => {
    const FIX2 = { ABUK: 27.07, ARCC: 5.94, SKPC: 12.01, CLHO: 11.63 };
    assert.notEqual(bhOwnershipOk('ABUK', FIX2.ARCC * 100000, 100000, FIX2), true);
    assert.equal(bhOwnershipOk('SKPC', FIX2.CLHO * 100000, 100000, FIX2), true, 'documented confusable pair passes the band');
  });
});

describe('seriesFingerprintOk (pass 10 — the decisive ownership proof)', () => {
  const mk = (times, closes) => times.map((t, i) => [t, 0, 0, 0, closes[i], 0]);
  const chartOf = (times, closes) => times.map((t, i) => ({ time: t, close: closes[i] }));
  const T = Array.from({ length: 20 }, (_, i) => 1e9 + i * 86400);

  it('aligns by UTC day — intra-day offsets between TV and reference times must not zero the overlap', () => {
    const closes = T.map((_, i) => 100 + i);
    const offsetTimes = T.map((t) => t + 27000); // same day, different session offset
    assert.equal(seriesFingerprintOk(chartOf(offsetTimes, closes), mk(T, closes)).ok, true);
  });

  it('accepts the same series with small adjustment noise', () => {
    const closes = T.map((_, i) => 100 + i);
    const noisy = closes.map((c) => c * 1.01);
    assert.equal(seriesFingerprintOk(chartOf(T, noisy), mk(T, closes)).ok, true);
  });

  it('REJECTS a different symbol at a similar price level — paths diverge date-by-date', () => {
    const a = T.map((_, i) => 100 + Math.sin(i) * 8 + i);
    const b = T.map((_, i) => 100 + Math.cos(i * 1.7) * 8 + i * 0.7);
    const r = seriesFingerprintOk(chartOf(T, b), mk(T, a));
    assert.equal(r.ok, false);
  });

  it('REJECTS when too few bars align by timestamp — unverifiable is failure', () => {
    const r = seriesFingerprintOk(chartOf(T.slice(0, 3), [1, 2, 3]), mk(T, T.map(() => 1)));
    assert.equal(r.ok, false);
    assert.match(r.reason, /aligned unique daily bars/);
  });

  it('REJECTS missing series outright', () => {
    assert.equal(seriesFingerprintOk(null, []).ok, false);
  });

  it('accepts a corporate-action window — earlier bars constant-shifted, recent tail matches (JUFO live case)', () => {
    const closes = T.map((_, i) => 100 + i);
    // ex-date 12 days in: TV back-adjusts the first 12 bars by -20%
    const tvCloses = closes.map((c, i) => (i < 12 ? c * 0.8 : c));
    const r = seriesFingerprintOk(chartOf(T, tvCloses), mk(T, closes));
    assert.equal(r.ok, true);
    assert.match(r.adjustment_divergence, /corporate-action/);
  });

  it("REJECTS a foreign series with exactly 4 fabricated tail matches — pass 12's counterexample", () => {
    const refCloses = T.map((_, i) => 100 + i);
    // 16 arbitrary foreign bars, then 4 bars copied from the reference tail
    const closes = T.map((c, i) => (i < 16 ? (100 + i) * (1 + 0.05 + 0.1 * Math.sin(i * 2.1)) : 100 + i));
    const r = seriesFingerprintOk(chartOf(T, closes), mk(T, refCloses));
    assert.equal(r.ok, false, 'tail matches without constant-shift structure must not pass');
  });

  it('REJECTS recorded-universe near-twins under the structural rule (CLHO series under SKPC label)', () => {
    const REF = JSON.parse(readFileSync('/home/karim/claude-a15-20260818/pine-audit/data/daily_deep.json', 'utf8'));
    const chartBars = REF.CLHO.slice(-60).map((b) => ({ time: b[0], close: b[4] }));
    const r = seriesFingerprintOk(chartBars, REF.SKPC.slice(-120));
    assert.equal(r.ok, false, 'CLHO closes are not a constant multiple of SKPC closes');
  });

  it('REJECTS a foreign series even with a near-level tail — recent days must match per-day', () => {
    const refCloses = T.map((_, i) => 100 + i);
    // foreign series ~2-6% off day by day, no stable tail agreement
    const foreign = T.map((_, i) => (100 + i) * (1 + 0.02 + 0.04 * Math.abs(Math.sin(i * 2.3))));
    const r = seriesFingerprintOk(chartOf(T, foreign), mk(T, refCloses));
    assert.equal(r.ok, false);
  });

  it("REJECTS 60 same-day intraday bars posing as daily bars — pass 11's counterexample", () => {
    // A silently-failed 1D switch leaves intraday bars; at a foreign price
    // near the reference close they all "align" to ONE reference day.
    const t0 = T[T.length - 1];
    const intraday = Array.from({ length: 60 }, (_, i) => ({ time: t0 + i * 180, close: 100 + (T.length - 1) }));
    const ref = mk(T, T.map((_, i) => 100 + i));
    const r = seriesFingerprintOk(intraday, ref);
    assert.equal(r.ok, false);
    assert.match(r.reason, /only 1 aligned unique daily bars/);
  });

});

describe('config validation via the real CLI (sol pass 16b)', () => {
  const HARNESS = new URL('../scripts/backtest-tournament.mjs', import.meta.url).pathname;
  const CAMPAIGN_REF = '/home/karim/claude-a15-20260818/pine-audit/data/ref_universe_2026-08-25.json';
  const PINE = '/home/karim/claude-a15-20260818/tradingview-mcp/research/strategies-canonical/macd-12-26-9.pine';
  function runCfg(cfg, ref = CAMPAIGN_REF) {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const p = join(dir, 'c.json');
    writeFileSync(p, JSON.stringify(cfg));
    try {
      execFileSync('node', [HARNESS, '--dry', '--config', p, '--out', join(dir, 'out')], {
        env: { ...process.env, TV_REF_DATA: ref }, stdio: 'pipe', timeout: 60000,
      });
      return null;
    } catch (e) { return String(e.stderr || e.message); }
  }
  it('accepts the real round-1 roster shape', () => {
    assert.equal(runCfg([{ key: 'macd-12-26-9', file: PINE, timeframe: '1D', symbols: ['COMI'] }]), null);
  });
  it('rejects a non-string key that coerces through the regex', () => {
    assert.match(runCfg([{ key: 0, file: PINE, timeframe: '1D', symbols: ['COMI'] }]), /key invalid/);
  });
  it('rejects a non-string symbol (array coercion)', () => {
    assert.match(runCfg([{ key: 'k1', file: PINE, timeframe: '1D', symbols: [['COMI']] }]), /symbol invalid/);
  });
  it('rejects undeclared fields (inline)', () => {
    assert.match(runCfg([{ key: 'k1', file: PINE, timeframe: '1D', symbols: ['COMI'], inline: 'x' }]), /undeclared fields/);
  });
  it('rejects a roster symbol missing from the reference — fail closed, built-in path included', () => {
    assert.match(runCfg([{ key: 'k1', file: PINE, timeframe: '1D', symbols: ['ZZZZ' + 'Q'] }]), /no series in the reference file/);
  });
});

describe('completedTailKey (sol pass 19 — the forming bar mutates)', () => {
  const bar = (t, c, v) => ({ time: t, open: c, high: c, low: c, close: c, volume: v });
  const bars = [bar(1, 10, 5), bar(2, 11, 6), bar(3, 12, 7), bar(4, 13, 8), bar(5, 14, 9)];

  it('is INVARIANT to mutations of the forming (last) bar', () => {
    const frozen = [...bars];
    const oneMoreTick = [...bars.slice(0, -1), bar(5, 14, 99)]; // same price, more volume
    assert.equal(completedTailKey(frozen), completedTailKey(oneMoreTick),
      'a frozen source gaining volume ticks must NOT look fresh');
  });

  it('differs when any completed bar differs', () => {
    const other = [...bars.slice(0, 2), bar(3, 99, 7), ...bars.slice(3)];
    assert.notEqual(completedTailKey(bars), completedTailKey(other));
  });

  it('returns null (fail-closed upstream) on short or missing series', () => {
    assert.equal(completedTailKey(bars.slice(0, 3)), null);
    assert.equal(completedTailKey(null), null);
  });
});
