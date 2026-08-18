/**
 * Tests for the registration-level tool allowlist in src/allowlist.js.
 * The security property under test: a tool that is not allowed must never
 * reach server.tool(), so it cannot appear in tools/list or be invoked.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAllowlist, applyAllowlist, READONLY_TOOLS } from '../src/allowlist.js';

/** Minimal stand-in for McpServer: records what actually got registered. */
function fakeServer() {
  const calls = [];
  return { calls, tool: (name) => { calls.push(name); return { name }; } };
}

describe('resolveAllowlist', () => {
  it('returns null (no restriction) when unset or empty', () => {
    assert.equal(resolveAllowlist(undefined), null);
    assert.equal(resolveAllowlist(null), null);
    assert.equal(resolveAllowlist(''), null);
    assert.equal(resolveAllowlist('   '), null);
  });

  it('expands the readonly keyword, case-insensitively', () => {
    for (const raw of ['readonly', 'READONLY', ' ReadOnly ']) {
      const set = resolveAllowlist(raw);
      assert.equal(set.size, READONLY_TOOLS.length);
      assert.ok(set.has('quote_get'));
    }
  });

  it('parses an explicit comma list, tolerating whitespace and blanks', () => {
    const set = resolveAllowlist(' quote_get , ,data_get_ohlcv ');
    assert.deepEqual([...set].sort(), ['data_get_ohlcv', 'quote_get']);
  });
});

describe('applyAllowlist', () => {
  it('registers everything when allowed is null', () => {
    const server = fakeServer();
    const gate = applyAllowlist(server, null);
    server.tool('quote_get'); server.tool('ui_evaluate');
    assert.deepEqual(server.calls, ['quote_get', 'ui_evaluate']);
    assert.deepEqual(gate.skipped, []);
  });

  it('withholds disallowed tools from server.tool entirely', () => {
    const server = fakeServer();
    const gate = applyAllowlist(server, resolveAllowlist('readonly'));
    for (const n of ['quote_get', 'ui_evaluate', 'alert_create', 'data_get_ohlcv']) server.tool(n);
    // The dangerous ones never reached the real registrar.
    assert.deepEqual(server.calls, ['quote_get', 'data_get_ohlcv']);
    assert.deepEqual(gate.skipped, ['ui_evaluate', 'alert_create']);
    assert.deepEqual(gate.registered, ['quote_get', 'data_get_ohlcv']);
  });

  it('returns undefined for a withheld tool without throwing', () => {
    const server = fakeServer();
    applyAllowlist(server, resolveAllowlist('readonly'));
    assert.equal(server.tool('ui_evaluate'), undefined);
  });

  it('readonly set contains no writer, UI-driver, or update tool', () => {
    const forbidden = /^(ui_|alert_|watchlist_|pine_|draw_|replay_|indicator_|layout_|pane_|tab_|batch_)|^tv_(update|launch|discover)$/;
    const leaks = READONLY_TOOLS.filter((t) => forbidden.test(t));
    assert.deepEqual(leaks, [], `readonly allowlist leaks: ${leaks.join(', ')}`);
  });
});
