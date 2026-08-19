/**
 * Symbol notes reader (karimdeif fork — not in upstream).
 *
 * Reads the per-symbol note that TradingView shows in the right panel's
 * Details tab. Used to harvest the LLM-council verdicts karim stored there in
 * January 2026.
 *
 * DESIGN LAW — this tool accepts NO selector, path, or expression from its
 * caller. It takes no arguments at all and reads the note for whatever symbol
 * the chart currently holds. The DOM location is fixed here in tool code. A
 * reader that accepted a selector would be ui_evaluate with a friendlier name,
 * which is exactly what the read-only allowlist exists to prevent.
 *
 * DOM shape, established by probe on 2026-08-18 (TradingView Desktop 2.14.0):
 *
 *   [data-name="details-note"]
 *     ├── div.title-*    -> "Notes"        (chrome, stripped)
 *     ├── div.content-*  -> the note body  (what we want)
 *     └── div.footer-*   -> "Open notes"   (chrome, stripped)
 *
 * Class suffixes are build-hashed (`content-C6dEGbyQ`) and WILL change across
 * TradingView releases, so matching is by class PREFIX with a chrome-stripping
 * fallback rather than by exact class.
 *
 * KNOWN LIMITATION — no timestamp. The note's authored date (karim's notes are
 * stamped e.g. "Jan 3, 2026 13:25") is NOT present anywhere in this panel's
 * DOM; a full-HTML date scan returns nothing. It lives behind the "Open notes"
 * dialog, which needs a click this tool deliberately will not make. So
 * `note_ts` is returned as null with `note_ts_available: false`, and a harvest
 * must take its vintage date from metadata rather than invent one per symbol.
 */
import { evaluate } from '../connection.js';

/** Widget-bar button for the Watchlist/Details/News panel. Hardcoded. */
const BASE_BUTTON_JS = `(document.querySelector('[data-name="base"]') || document.querySelector('[aria-label="Watchlist, details, and news"]'))`;

/**
 * Ensure the Details panel is open so the note node exists.
 *
 * This clicks a HARDCODED button and takes nothing from any caller — the same
 * pattern upstream already uses in watchlist.js `ensureWatchlistOpen()`. It is
 * a visible UI change, never a data write.
 */
async function ensureDetailsOpen(maxWaitMs = 5000) {
  const state = await evaluate(`
    (function() {
      if (document.querySelector('[data-name="details-note"]')) return { ready: true };
      var btn = ${BASE_BUTTON_JS};
      if (!btn) return { error: 'Details panel button not found' };
      if (btn.getAttribute('aria-pressed') !== 'true') { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);
  if (state?.error) throw new Error(state.error);
  if (state?.ready) return { opened: false };

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(`!!document.querySelector('[data-name="details-note"]')`);
    if (ready) return { opened: !!state?.opened };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { opened: !!state?.opened, timed_out: true };
}

/** Read the current symbol's note. Takes no arguments by design. */
export async function getNote() {
  await ensureDetailsOpen();

  const result = await evaluate(`
    (function() {
      var host = document.querySelector('[data-name="details-note"]');
      if (!host) return { present: false, reason: 'details-note node absent (Details panel unavailable for this symbol?)' };

      // Preferred: the content child, matched by class prefix.
      var content = null;
      var kids = host.children;
      for (var i = 0; i < kids.length; i++) {
        var cls = kids[i].className && kids[i].className.baseVal !== undefined
          ? kids[i].className.baseVal : (kids[i].className || '');
        if (typeof cls === 'string' && cls.indexOf('content-') === 0) { content = kids[i]; break; }
      }
      // Fallback: deepest div that is neither the title nor the footer.
      if (!content) {
        for (var j = 0; j < kids.length; j++) {
          var c2 = (kids[j].className || '') + '';
          if (kids[j].tagName === 'DIV' && c2.indexOf('title-') !== 0 && c2.indexOf('footer-') !== 0) { content = kids[j]; break; }
        }
      }

      var raw = content ? (content.innerText || content.textContent || '') : (host.innerText || '');
      // Strip panel chrome if we fell all the way back to the host node.
      var text = raw.replace(/^\\s*Notes\\s*/, '').replace(/\\s*Open notes\\s*$/, '').trim();

      return {
        present: text.length > 0,
        text: text,
        used_content_child: !!content,
        char_count: text.length,
      };
    })()
  `);

  if (result?.present === false) {
    return { success: true, note_present: false, note_text: null, note_ts: null, note_ts_available: false, reason: result.reason };
  }

  return {
    success: true,
    note_present: true,
    note_text: result.text,
    char_count: result.char_count,
    // See KNOWN LIMITATION in the module header.
    note_ts: null,
    note_ts_available: false,
    note_ts_reason: 'TradingView does not expose the note timestamp in the Details panel DOM; it is only in the "Open notes" dialog.',
  };
}

/**
 * Parse a council rating out of note text.
 *
 * Pure string work, exported separately so it is testable without a browser and
 * reusable on rows already harvested. Returns null rather than guessing.
 */
export function parseRating(noteText) {
  if (!noteText || typeof noteText !== 'string') return { rating: null, confidence: null, matched: null };
  const RATINGS = ['STRONG_SELL', 'STRONG_BUY', 'WEAK_SELL', 'WEAK_BUY', 'SELL', 'BUY', 'HOLD'];

  // Prefer an explicit "Overall Rating: X" statement.
  const explicit = noteText.match(/Overall\s+Rating\s*:\s*([A-Z_]+)/i);
  let rating = null;
  let matched = null;
  if (explicit) {
    const cand = explicit[1].toUpperCase();
    if (RATINGS.includes(cand)) { rating = cand; matched = explicit[0]; }
  }
  // Fall back to the first recognised token anywhere (longest-first so
  // STRONG_SELL is not truncated to SELL).
  if (!rating) {
    for (const r of RATINGS) {
      const re = new RegExp(`\\b${r}\\b`, 'i');
      const m = noteText.match(re);
      if (m) { rating = r; matched = m[0]; break; }
    }
  }

  const conf = noteText.match(/Confidence\s*:\s*([A-Za-z]+)/i);
  return {
    rating,
    confidence: conf ? conf[1].toUpperCase() : null,
    matched,
  };
}
