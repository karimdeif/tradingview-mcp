/** Pure-function tests for the tournament harness (sol-max pass 9: harness changes lacked tests). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cellOutcome, parseStrategyTitle, checkResultIntegrity, normTf } from '../scripts/backtest-tournament.mjs';

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
