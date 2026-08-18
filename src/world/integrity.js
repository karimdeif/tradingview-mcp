/**
 * Feed integrity check (karimdeif fork).
 *
 * WHY THIS EXISTS — read before weakening it.
 *
 * On 2026-08-18 the TradingView Desktop session was terminated mid-run by
 * TradingView's one-active-session-per-user rule ("Session disconnected — your
 * account was accessed from another browser or device"). The app kept running
 * and kept answering:
 *
 *   - tv_health_check returned success:true, cdp_connected:true,
 *     api_available:true
 *   - chart_get_state returned the CORRECT symbol after every switch
 *   - quote_get returned success:true with a plausible price
 *
 * ...but every symbol returned the SAME frozen quote (84.38, the last value the
 * chart held) with the same bar timestamp. Two full cycles wrote 20 rows in
 * which ES1!, NQ1!, DXY, gold and the treasury leg all carried the oil price.
 *
 * Nothing in the per-row checks catches that, because each row is individually
 * well-formed. It is only visible ACROSS symbols. A trading system consuming
 * those rows would have seen a fabricated market.
 *
 * The detector's staleness guards did correctly suppress false shocks from this
 * data — but suppression is not detection, and the rows would still have been
 * written. This module is the detection half.
 */

/**
 * Assess a cycle's rows as a set.
 *
 * @param {Array} rows rows built this cycle (one per symbol that quoted)
 * @param {object} opts
 * @returns {{healthy: boolean, reasons: string[], detail: object}}
 */
export function assessFeedIntegrity(rows, { minRows = 3, maxIdenticalRatio = 0.5 } = {}) {
  const reasons = [];
  const detail = {};

  if (!rows || rows.length === 0) {
    return { healthy: false, reasons: ['no rows produced this cycle'], detail: { rows: 0 } };
  }
  if (rows.length < minRows) {
    reasons.push(`only ${rows.length} rows produced (min ${minRows})`);
  }

  // --- Collision check: distinct instruments must not share a price. ---------
  const lasts = rows.map((r) => r.last).filter((v) => v !== null && v !== undefined);
  const distinctLasts = new Set(lasts);
  detail.rows = rows.length;
  detail.distinct_last_values = distinctLasts.size;
  if (lasts.length >= minRows && (distinctLasts.size / lasts.length) <= maxIdenticalRatio) {
    reasons.push(
      `${lasts.length} symbols returned only ${distinctLasts.size} distinct price(s) — ` +
      'unrelated instruments cannot share a price; the feed is frozen or the session is disconnected'
    );
  }

  // --- Bar-timestamp collision across instruments on different exchanges. ----
  const stamps = rows.map((r) => r.bar_ts).filter(Boolean);
  const distinctStamps = new Set(stamps);
  detail.distinct_bar_ts = distinctStamps.size;
  if (stamps.length >= minRows && distinctStamps.size === 1) {
    reasons.push(
      `all ${stamps.length} symbols share one bar timestamp (${[...distinctStamps][0]}) — ` +
      'independent feeds do not tick in lockstep'
    );
  }

  // --- Wholesale staleness on symbols that are supposed to be live. ---------
  const expectedLive = rows.filter((r) => r.realtime === false && r.realtime_drift === true);
  detail.drifted_realtime_symbols = expectedLive.map((r) => r.symbol);
  if (expectedLive.length >= 2) {
    reasons.push(
      `${expectedLive.length} symbols expected real-time are stale (${expectedLive.map((r) => r.symbol).join(', ')}) — ` +
      'a live feed does not go dark on several unrelated instruments at once'
    );
  }

  return { healthy: reasons.length === 0, reasons, detail };
}

/**
 * Human-facing alarm text. Deliberately blunt: the failure mode this guards
 * against is a dead feed being read as a calm market.
 */
export function integrityAlarmText(assessment, cycle) {
  return [
    `*** FEED INTEGRITY FAILURE (cycle ${cycle}) — NOT A CALM MARKET ***`,
    ...assessment.reasons.map((r) => `    - ${r}`),
    '    Rows for this cycle were DISCARDED, not written.',
    '    Most likely cause: TradingView session disconnected (one active session per account),',
    '    or the desktop app lost its data connection. The app keeps answering with frozen values,',
    '    and tv_health_check still reports healthy — so this check is the only thing that sees it.',
  ].join('\n');
}
