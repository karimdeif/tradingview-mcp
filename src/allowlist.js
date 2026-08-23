/**
 * Registration-level tool allowlist (karimdeif fork).
 *
 * Upstream registers all 84 tools unconditionally (src/server.js), including
 * ui_evaluate (arbitrary JS in the authenticated page) and ui_open_panel's
 * 'trading' target, plus writers that persist to the user's TradingView cloud
 * account (alerts, watchlists, Pine scripts). There is no upstream way to run
 * a reduced surface.
 *
 * This gates at registration, not at call time: a tool that is not allowed is
 * never handed to the MCP server, so it does not appear in tools/list and
 * cannot be invoked at all.
 *
 * TV_MCP_TOOL_ALLOWLIST:
 *   unset       → upstream behaviour, all tools register
 *   'readonly'  → the READONLY_TOOLS set below
 *   'backtest'  → READONLY_TOOLS + scoped strategy-backtest tools
 *                 (also needs TV_MCP_ALLOW_SCOPED_WRITERS=1)
 *   'a,b,c'     → exactly those tool names
 */

/**
 * Read-only working set: enough to inspect symbols and pull quotes/bars,
 * nothing that writes to the account or drives the UI.
 *
 * chart_set_symbol and chart_set_timeframe DO mutate the visible chart — they
 * are included because reading a symbol requires switching to it, and quote_get
 * switches and restores internally regardless. They touch local view state only,
 * never server-side account state.
 */
export const READONLY_TOOLS = [
  'tv_health_check',
  'chart_get_state',
  'chart_set_symbol',
  'chart_set_timeframe',
  'quote_get',
  'data_get_ohlcv',
  'symbol_info',
  'symbol_search',
  'capture_screenshot',
];

/**
 * Research-harvest working set: the read-only tools plus the three readers
 * needed to harvest karim's stored council verdicts. Each was code-reviewed for
 * strict read-only behaviour on 2026-08-19:
 *
 *   notes_get           — no caller arguments at all (src/core/notes.js)
 *   draw_list           — no caller arguments; getAllShapes() -> id/name
 *   draw_get_properties — only input is entity_id, escaped via safeString();
 *                         calls getters only (getPoints/getProperties/isVisible)
 *   watchlist_get       — no caller arguments; DOM read. Does click a HARDCODED
 *                         panel button to open the watchlist (visible side
 *                         effect, never a data write).
 *
 * Deliberately still excluded: every other ui_*, all alert_*, all pine_*,
 * watchlist writers, draw_shape/draw_clear/draw_remove_one, tv_update,
 * tv_launch, batch_run.
 */
export const HARVEST_TOOLS = [
  ...READONLY_TOOLS,
  'notes_get',
  'draw_list',
  'draw_get_properties',
  'watchlist_get',
];


/**
 * Strategy-backtest working set: the read-only tools plus the minimum needed to
 * put one Pine strategy on the chart and read its Strategy Tester report.
 *
 * Requires TV_MCP_ALLOW_SCOPED_WRITERS=1 in addition to naming this preset —
 * two independent gates, because these tools drive the UI rather than only
 * reading it.
 *
 *   pine_set_source          — Monaco editor.setValue() only; buffer, never the
 *                              cloud script (verified src/core/pine.js:266 on
 *                              2026-08-23).
 *   pine_add_to_chart        — no caller-supplied click target; fixed label set;
 *                              refuses to fall back to Save (src/core/backtest.js)
 *   chart_clear_studies      — no arguments at all
 *   data_get_strategy_results / data_get_trades / data_get_equity
 *                            — internal report API reads (src/core/data.js)
 *
 * Deliberately excluded: pine_save and pine_compile/pine_smart_compile (all
 * three can write to the user's cloud scripts), every ui_*, alert_*, watchlist
 * writers, draw_* writers, batch_run, tv_launch, tv_update.
 */
export const BACKTEST_TOOLS = [
  ...READONLY_TOOLS,
  'pine_set_source',
  'pine_add_to_chart',
  'chart_clear_studies',
  'data_get_strategy_results',
  'data_get_trades',
  'data_get_equity',
];

/** Parse the env var into a Set of allowed names, or null for "no restriction". */
export function resolveAllowlist(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  if (trimmed.toLowerCase() === 'readonly') return new Set(READONLY_TOOLS);
  if (trimmed.toLowerCase() === 'harvest') return new Set(HARVEST_TOOLS);
  if (trimmed.toLowerCase() === 'backtest') return new Set(BACKTEST_TOOLS);
  const names = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(names);
}

/**
 * Wrap server.tool so only allowed names register. Returns a summary for
 * logging. No-op when allowed is null.
 */
export function applyAllowlist(server, allowed) {
  const registered = [];
  const skipped = [];
  const original = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    if (allowed && !allowed.has(name)) {
      skipped.push(name);
      return undefined;
    }
    registered.push(name);
    return original(name, ...rest);
  };
  return { registered, skipped };
}

/** Tools gated behind TV_MCP_ALLOW_SCOPED_WRITERS, listed here so the gate is testable. */
export const SCOPED_WRITER_TOOLS = ['pine_add_to_chart', 'chart_clear_studies'];

/**
 * Both gates must hold before the scoped writers register.
 *
 * The subtle part, and a real defect found by review on 2026-08-23: an unset or
 * blank allowlist resolves to `null`, and `applyAllowlist(server, null)` permits
 * EVERYTHING. Gating on the env var alone therefore registered these tools on a
 * default install with no allowlist at all. The allowlist must NAME them.
 *
 * @param {Set<string>|null} allowed resolved allowlist
 * @param {string|undefined} envValue raw TV_MCP_ALLOW_SCOPED_WRITERS
 */
export function scopedWritersActive(allowed, envValue) {
  if (envValue !== '1') return false;
  if (allowed === null || allowed === undefined) return false;
  return SCOPED_WRITER_TOOLS.some((t) => allowed.has(t));
}
