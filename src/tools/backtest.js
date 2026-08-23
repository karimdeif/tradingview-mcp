import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/backtest.js';

/**
 * Scoped strategy-backtest tools. Registered ONLY when
 * TV_MCP_ALLOW_SCOPED_WRITERS=1 (checked in server.js) *and* the active
 * allowlist names them. Either gate missing → these never reach tools/list.
 */
export function registerBacktestTools(server) {
  server.tool(
    'pine_add_to_chart',
    'Attach the Pine script currently in the editor buffer to the chart, and verify it actually attached. Takes no selector and performs no DOM click: it invokes the Pine editor facade\'s attested addToChart() draft branch, which persists a TradingView DRAFT (the same write a manual "Add to chart" performs on an untitled script) and never writes saved scripts. Refuses on a non-draft editor, an unattested TradingView build, or a shadowed/rebound facade method. Success requires the awaited attach to report success, a stable study-list read, exactly one new study, and exact name + script-id + source-digest matches against the editor buffer.',
    {
      expect_name: z
        .string()
        .min(4)
        .describe('Required. The attached study\'s name must match this EXACTLY (case/whitespace-normalised) or the call fails. It is checked in Node against the chart\'s own read-back; it never enters page JavaScript and cannot redirect what the tool does.'),
    },
    async ({ expect_name }) => {
      try { return jsonResult(await core.addToChart({ expect_name })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'chart_clear_studies',
    'Remove every study from the chart so a backtest run starts from exactly one strategy. Takes no arguments.',
    {},
    async () => {
      try { return jsonResult(await core.clearStudies()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );
}
