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

/** Parse the env var into a Set of allowed names, or null for "no restriction". */
export function resolveAllowlist(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  if (trimmed.toLowerCase() === 'readonly') return new Set(READONLY_TOOLS);
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
