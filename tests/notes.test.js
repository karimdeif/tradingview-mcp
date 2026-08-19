/**
 * Tests for the notes reader and rating parser.
 * The parser is the load-bearing part for the harvest: a wrong rating silently
 * mislabels karim's Jan-2026 benchmark, so longest-token-first and
 * explicit-statement precedence are asserted directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRating } from '../src/core/notes.js';
import { resolveAllowlist, READONLY_TOOLS, HARVEST_TOOLS } from '../src/allowlist.js';

// Verbatim COMI note read from the live chart on 2026-08-19.
const COMI = `council -

Overall Rating: SELL

Confidence: MEDIUM (driven primarily by the intrinsic overvaluation signal [CSV:value_intrinsic_discount] and low dividend cushion [CSV:dividend_dividend_yield]; tempered by strong ROE and growth). Time Horizon: 6-12 months Target Return: -14%`;

// Paraphrase of the ADIB note karim quoted.
const ADIB = `council - I would keep the call as WEAK_SELL / valuation-driven HOLD, with medium confidence, because the CSV lacks the bank-specific risk metrics needed to be definitive.`;

describe('parseRating', () => {
  it('reads an explicit "Overall Rating:" statement', () => {
    const r = parseRating(COMI);
    assert.equal(r.rating, 'SELL');
    assert.equal(r.confidence, 'MEDIUM');
  });

  it('prefers the longest token so STRONG_SELL is not truncated to SELL', () => {
    assert.equal(parseRating('Overall Rating: STRONG_SELL').rating, 'STRONG_SELL');
    assert.equal(parseRating('the council said STRONG_BUY today').rating, 'STRONG_BUY');
  });

  it('accepts a SPACE separator — GBCO regression', () => {
    // Verbatim GBCO note. An underscore-only regex downgraded this to plain
    // SELL, understating karim's call: the dangerous direction for a
    // veto-shaped signal.
    assert.equal(parseRating('COUNCIL - STRONG SELL - HIGH').rating, 'STRONG_SELL');
    assert.equal(parseRating('Overall Rating: STRONG SELL').rating, 'STRONG_SELL');
    assert.equal(parseRating('Overall Rating: WEAK BUY').rating, 'WEAK_BUY');
    assert.equal(parseRating('rating: STRONG-SELL').rating, 'STRONG_SELL');
  });

  it('still reads a plain SELL as SELL, not as a strong variant', () => {
    assert.equal(parseRating('COUNCIL - SELL - HIGH').rating, 'SELL');
    assert.equal(parseRating('Overall Rating: SELL').rating, 'SELL');
  });

  it('falls back to the first recognised token when there is no explicit statement', () => {
    const r = parseRating(ADIB);
    assert.equal(r.rating, 'WEAK_SELL', 'must not pick the later HOLD');
  });

  it('returns null rather than guessing when no rating is present', () => {
    const r = parseRating('council - insufficient data to form a view');
    assert.equal(r.rating, null);
  });

  it('handles null and non-string input', () => {
    assert.equal(parseRating(null).rating, null);
    assert.equal(parseRating(undefined).rating, null);
    assert.equal(parseRating(42).rating, null);
  });

  it('an explicit statement wins over an earlier stray token', () => {
    const r = parseRating('previously HOLD. Overall Rating: STRONG_SELL');
    assert.equal(r.rating, 'STRONG_SELL');
  });
});

describe('harvest allowlist', () => {
  it('resolves the harvest keyword', () => {
    const s = resolveAllowlist('harvest');
    assert.ok(s.has('notes_get'));
    assert.ok(s.has('draw_list'));
    assert.ok(s.has('draw_get_properties'));
    assert.ok(s.has('watchlist_get'));
  });

  it('is the read-only set plus exactly four readers — no blanket widening', () => {
    assert.equal(HARVEST_TOOLS.length, READONLY_TOOLS.length + 4);
  });

  it('still withholds every writer and generic UI driver', () => {
    const s = resolveAllowlist('harvest');
    for (const forbidden of [
      'ui_evaluate', 'ui_click', 'ui_mouse_click', 'ui_type_text', 'ui_keyboard', 'ui_open_panel',
      'alert_create', 'alert_delete', 'watchlist_add', 'watchlist_remove', 'watchlist_add_bulk',
      'pine_save', 'pine_set_source', 'draw_shape', 'draw_clear', 'draw_remove_one',
      'tv_update', 'tv_launch', 'batch_run', 'replay_trade',
    ]) {
      assert.equal(s.has(forbidden), false, `${forbidden} must remain withheld`);
    }
  });

  it('readonly preset does NOT include the harvest readers', () => {
    const s = resolveAllowlist('readonly');
    for (const t of ['notes_get', 'draw_list', 'draw_get_properties', 'watchlist_get']) {
      assert.equal(s.has(t), false, `${t} must not leak into the daemon's surface`);
    }
  });
});
