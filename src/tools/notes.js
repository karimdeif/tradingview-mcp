import { jsonResult } from './_format.js';
import * as core from '../core/notes.js';

export function registerNotesTools(server) {
  // No input schema by design: this tool accepts nothing from its caller and
  // reads the note for whatever symbol the chart currently holds. See
  // src/core/notes.js for why.
  server.tool('notes_get', 'Read the current symbol\'s note text from the TradingView Details panel. Read-only; takes no arguments.', {}, async () => {
    try { return jsonResult(await core.getNote()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
