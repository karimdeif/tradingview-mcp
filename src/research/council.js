/**
 * Council-notes research dataset (karimdeif fork).
 *
 * Harvests the LLM-council verdicts karim stored in TradingView in January 2026
 * into QuestDB as a dated benchmark vintage. Research dataset and future study
 * material only — scoring his Jan-2026 calls against subsequent returns.
 * NEVER a trade input; LLM-picking is the retired thesis.
 *
 * SCHEMA DECISIONS, each forced by the 2026-08-19 five-symbol sample:
 *
 *  - TWO RATING COLUMNS, NEVER ONE. `rating_drawing` comes from karim's own
 *    chart Text object and is AUTHORITATIVE. `rating_parsed` is a derived guess
 *    from note prose. They disagreed on 1 of 5 sampled symbols: ADIB's note
 *    reads "keep the call as WEAK_SELL / valuation-driven HOLD" — the parser
 *    takes WEAK_SELL, his drawing says HOLD. A single collapsed column would
 *    silently overwrite his call with our misreading.
 *
 *  - note_kind. Not every note is a council verdict. HRHO's note is
 *    "GOOD LIQUIDITY" — his own trading shorthand. Freeform rows are excluded
 *    from council dataset semantics, and the future append-only write-back must
 *    never touch them.
 *
 *  - note_ts IS ALWAYS NULL. TradingView does not expose the authored date in
 *    the Details panel DOM (full-HTML date scan returns nothing); it lives
 *    behind the "Open notes" dialog. The vintage date is BATCH metadata
 *    supplied by karim (2026-01-03, from his ADIB screenshot), never a
 *    synthesised per-symbol value.
 */

export const NOTES_TABLE = 'tv_council_notes';
export const LEVELS_TABLE = 'tv_council_levels';

export const NOTES_DDL = `CREATE TABLE IF NOT EXISTS ${NOTES_TABLE} (
  harvested_at TIMESTAMP,
  vintage_date DATE,
  symbol SYMBOL CAPACITY 512 CACHE,
  tv_symbol SYMBOL CAPACITY 512 CACHE,
  note_kind SYMBOL CAPACITY 8 CACHE,
  note_text STRING,
  note_len INT,
  rating_drawing SYMBOL CAPACITY 16 CACHE,
  rating_parsed SYMBOL CAPACITY 16 CACHE,
  rating_agreement SYMBOL CAPACITY 8 CACHE,
  confidence_parsed SYMBOL CAPACITY 16 CACHE,
  note_ts TIMESTAMP,
  note_ts_available BOOLEAN,
  note_ts_reason STRING,
  sr_line_count INT,
  source SYMBOL CAPACITY 8 CACHE
) TIMESTAMP(harvested_at) PARTITION BY DAY WAL
DEDUP UPSERT KEYS(harvested_at, symbol);`;

export const LEVELS_DDL = `CREATE TABLE IF NOT EXISTS ${LEVELS_TABLE} (
  harvested_at TIMESTAMP,
  vintage_date DATE,
  symbol SYMBOL CAPACITY 512 CACHE,
  drawing_id SYMBOL CAPACITY 4096 NOCACHE,
  level_price DOUBLE,
  level_rank INT,
  source SYMBOL CAPACITY 8 CACHE
) TIMESTAMP(harvested_at) PARTITION BY DAY WAL
DEDUP UPSERT KEYS(harvested_at, symbol, drawing_id);`;

/**
 * Classify a note.
 *
 * 'council'  — carries a council verdict (our dataset)
 * 'freeform' — karim's own annotation (protected; not our dataset)
 * 'empty'    — no note
 */
export function classifyNote(noteText) {
  if (!noteText || !String(noteText).trim()) return 'empty';
  return /\bcouncil\b/i.test(noteText) ? 'council' : 'freeform';
}

/**
 * Reconcile the authoritative drawing rating against the parsed one.
 *
 * Returns a STRING, not a nullable boolean. QuestDB's BOOLEAN type cannot hold
 * NULL — it silently coerces to false (verified against the live instance:
 * INSERT NULL then `b IS NULL` returns false). A nullable boolean therefore
 * conflated "the drawing and the prose disagree" (ADIB — a real signal) with
 * "there is no drawing to compare" (MCQE, ORAS — no signal at all), so a study
 * filtering rating_agrees = false would have picked up all three.
 *
 * 'agree' | 'mismatch' | 'unknown'  — rating_drawing/rating_parsed say why.
 */
export function ratingAgreement(ratingDrawing, ratingParsed) {
  if (!ratingDrawing || !ratingParsed) return 'unknown';
  return String(ratingDrawing).trim().toUpperCase() === String(ratingParsed).trim().toUpperCase()
    ? 'agree' : 'mismatch';
}

/** Normalise a raw drawing text value into a rating token, or null. */
export function normaliseDrawingRating(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim().toUpperCase().replace(/\s+/g, '_');
  const VALID = ['STRONG_SELL', 'STRONG_BUY', 'WEAK_SELL', 'WEAK_BUY', 'SELL', 'BUY', 'HOLD'];
  return VALID.includes(t) ? t : null;
}

/**
 * Build the note row for one symbol. Pure — no I/O — so the schema rules are
 * testable without a browser or a database.
 */
export function buildNoteRow({ symbol, tvSymbol, note, parsed, drawingText, srLineCount, vintageDate, harvestedAt }) {
  const noteText = note?.note_text ?? null;
  const ratingDrawing = normaliseDrawingRating(drawingText);
  const ratingParsed = parsed?.rating ?? null;
  return {
    harvested_at: harvestedAt,
    vintage_date: vintageDate,
    symbol,
    tv_symbol: tvSymbol,
    note_kind: classifyNote(noteText),
    note_text: noteText,
    note_len: noteText ? noteText.length : 0,
    // Authoritative — karim's own chart Text object.
    rating_drawing: ratingDrawing,
    // Derived guess from prose. See module header re: ADIB.
    rating_parsed: ratingParsed,
    rating_agreement: ratingAgreement(ratingDrawing, ratingParsed),
    confidence_parsed: parsed?.confidence ?? null,
    // Always null by design; the vintage is batch metadata.
    note_ts: null,
    note_ts_available: false,
    note_ts_reason: note?.note_ts_reason
      ?? 'TradingView does not expose the note timestamp in the Details panel DOM.',
    sr_line_count: srLineCount ?? 0,
    source: 'TV_NOTES',
  };
}

/** Build one level row per hand-drawn horizontal line, ranked high to low. */
export function buildLevelRows({ symbol, levels, vintageDate, harvestedAt }) {
  const sorted = (levels || [])
    .filter((l) => Number.isFinite(l.price))
    .sort((a, b) => b.price - a.price);
  return sorted.map((l, i) => ({
    harvested_at: harvestedAt,
    vintage_date: vintageDate,
    symbol,
    drawing_id: l.id,
    level_price: l.price,
    level_rank: i + 1,
    source: 'TV_NOTES',
  }));
}
