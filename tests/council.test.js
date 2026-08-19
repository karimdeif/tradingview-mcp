/**
 * Tests for the council-notes dataset rules. Every assertion here traces to a
 * finding in the 2026-08-19 live sample — these are the rules that stop the
 * harvest from corrupting karim's own calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyNote, ratingAgreement, normaliseDrawingRating, buildNoteRow, buildLevelRows,
  NOTES_DDL, LEVELS_DDL,
} from '../src/research/council.js';
import { parseRating } from '../src/core/notes.js';

const AT = '2026-08-19T18:30:00.000Z';
const V = '2026-01-03';

describe('classifyNote', () => {
  it('marks a council verdict', () => {
    assert.equal(classifyNote('council - Overall Rating: SELL'), 'council');
    assert.equal(classifyNote('COUNCIL - HOLD'), 'council');
  });
  it("protects karim's own shorthand as freeform", () => {
    // HRHO, verbatim from the live sample.
    assert.equal(classifyNote('GOOD LIQUIDITY'), 'freeform');
  });
  it('marks absent notes empty', () => {
    assert.equal(classifyNote(''), 'empty');
    assert.equal(classifyNote('   '), 'empty');
    assert.equal(classifyNote(null), 'empty');
  });
});

describe('ratingAgreement', () => {
  it('agrees on a match', () => assert.equal(ratingAgreement('SELL', 'SELL'), true));
  it('disagrees on the real ADIB case', () => assert.equal(ratingAgreement('HOLD', 'WEAK_SELL'), false));
  it('returns null when either side is missing — absence is not agreement', () => {
    assert.equal(ratingAgreement(null, 'SELL'), null);
    assert.equal(ratingAgreement('SELL', null), null);
    assert.equal(ratingAgreement(null, null), null);
  });
});

describe('normaliseDrawingRating', () => {
  it('accepts the valid tokens, case and spacing insensitive', () => {
    assert.equal(normaliseDrawingRating(' sell '), 'SELL');
    assert.equal(normaliseDrawingRating('strong buy'), 'STRONG_BUY');
  });
  it('rejects anything that is not a rating rather than inventing one', () => {
    assert.equal(normaliseDrawingRating('PDH 24550'), null);
    assert.equal(normaliseDrawingRating(''), null);
    assert.equal(normaliseDrawingRating(null), null);
  });
});

describe('buildNoteRow — the ADIB case end to end', () => {
  const ADIB_NOTE = 'council - I would keep the call as WEAK_SELL / valuation-driven HOLD, with medium confidence, because the CSV lacks the bank-specific risk metrics needed to be definitive.';

  it('keeps his drawing authoritative and our parse separate', () => {
    const row = buildNoteRow({
      symbol: 'ADIB', tvSymbol: 'EGX:ADIB',
      note: { note_text: ADIB_NOTE },
      parsed: parseRating(ADIB_NOTE),
      drawingText: 'HOLD',
      srLineCount: 6, vintageDate: V, harvestedAt: AT,
    });
    assert.equal(row.rating_drawing, 'HOLD', "karim's chart text must survive verbatim");
    assert.equal(row.rating_parsed, 'WEAK_SELL', 'our derived guess is preserved, not discarded');
    assert.equal(row.rating_agrees, false, 'the disagreement must be visible, not resolved');
    assert.equal(row.note_kind, 'council');
  });

  it('has no single collapsed rating column', () => {
    const row = buildNoteRow({ symbol: 'X', tvSymbol: 'EGX:X', note: { note_text: 'council - BUY' }, parsed: parseRating('council - BUY'), drawingText: 'BUY', srLineCount: 0, vintageDate: V, harvestedAt: AT });
    assert.equal('rating' in row, false, 'a bare `rating` column would let one overwrite the other');
  });

  it('never carries a per-symbol note timestamp', () => {
    const row = buildNoteRow({ symbol: 'X', tvSymbol: 'EGX:X', note: { note_text: 'council - BUY' }, parsed: {}, drawingText: null, srLineCount: 0, vintageDate: V, harvestedAt: AT });
    assert.equal(row.note_ts, null);
    assert.equal(row.note_ts_available, false);
    assert.equal(row.vintage_date, V, 'the vintage is batch metadata');
  });

  it('handles the HRHO shape: freeform note, no drawing, no rating', () => {
    const row = buildNoteRow({ symbol: 'HRHO', tvSymbol: 'EGX:HRHO', note: { note_text: 'GOOD LIQUIDITY' }, parsed: parseRating('GOOD LIQUIDITY'), drawingText: null, srLineCount: 1, vintageDate: V, harvestedAt: AT });
    assert.equal(row.note_kind, 'freeform');
    assert.equal(row.rating_drawing, null);
    assert.equal(row.rating_parsed, null);
    assert.equal(row.rating_agrees, null);
    assert.equal(row.note_len, 14);
  });
});

describe('buildLevelRows', () => {
  it('emits one ranked row per level, high to low', () => {
    // COMI's real levels, unsorted as draw_list returned them.
    const rows = buildLevelRows({ symbol: 'COMI', vintageDate: V, harvestedAt: AT, levels: [
      { id: 'HXsiBN', price: 63.27285238496039 },
      { id: 'BVaQ4V', price: 81.26959019681044 },
      { id: 'sUlSFR', price: 65.9996308413013 },
    ] });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].level_price, 81.26959019681044);
    assert.equal(rows[0].level_rank, 1);
    assert.equal(rows[2].level_price, 63.27285238496039);
    assert.equal(rows[2].level_rank, 3);
  });

  it('drops non-finite prices rather than writing NaN', () => {
    const rows = buildLevelRows({ symbol: 'X', vintageDate: V, harvestedAt: AT, levels: [{ id: 'a', price: null }, { id: 'b', price: 10 }] });
    assert.equal(rows.length, 1);
  });

  it('returns empty for a symbol with no lines', () => {
    assert.deepEqual(buildLevelRows({ symbol: 'X', vintageDate: V, harvestedAt: AT, levels: [] }), []);
  });
});

describe('DDL', () => {
  it('both tables are WAL, day-partitioned and deduped', () => {
    for (const ddl of [NOTES_DDL, LEVELS_DDL]) {
      assert.match(ddl, /PARTITION BY DAY WAL/);
      assert.match(ddl, /DEDUP UPSERT KEYS/);
    }
  });
  it('notes table has both rating columns and no collapsed one', () => {
    assert.match(NOTES_DDL, /rating_drawing/);
    assert.match(NOTES_DDL, /rating_parsed/);
    assert.match(NOTES_DDL, /rating_agrees/);
    assert.ok(!/\n\s+rating SYMBOL/.test(NOTES_DDL));
  });
  it('never targets an estate market table', () => {
    for (const t of ['trades', 'daily_ohlcv', 'regime_gate', 'news_events']) {
      assert.ok(!new RegExp(`\\b${t}\\b`).test(NOTES_DDL + LEVELS_DDL));
    }
  });
});
