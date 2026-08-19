/**
 * QuestDB write-window guard (karimdeif fork).
 *
 * Estate rule: no new writer may be writing to QuestDB between 14:30 and 18:30
 * Africa/Cairo. That is the candidate-night scored window, and ts-15-ops audits
 * write activity inside it — a new writer appearing mid-window pollutes the
 * audit.
 *
 * This is enforced in code rather than left to an operator's attention, for the
 * same reason the QuestDB table rules are: a timing constraint that only exists
 * in someone's head gets violated the first time a sweep runs long.
 *
 * LOCAL writes (the outage spool) are always allowed. Only QuestDB writes are
 * gated. So the safe pattern for a long sweep that might cross the boundary is:
 * sweep to spool freely, then drain when the window permits.
 */

export const BLACKOUT_START_MIN = 14 * 60 + 30; // 14:30 Cairo
export const BLACKOUT_END_MIN = 18 * 60 + 30;   // 18:30 Cairo
export const TZ = 'Africa/Cairo';

/** Minutes since midnight in the estate's timezone, for a given instant. */
export function cairoMinutes(date = new Date(), tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

/**
 * May we write to QuestDB right now?
 *
 * @returns {{allowed: boolean, reason: string, cairo_time: string, minutes_until_allowed: number|null}}
 */
export function questdbWriteAllowed(date = new Date(), tz = TZ) {
  const mins = cairoMinutes(date, tz);
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  const cairo_time = `${hh}:${mm}`;

  if (mins >= BLACKOUT_START_MIN && mins < BLACKOUT_END_MIN) {
    return {
      allowed: false,
      reason: `inside the 14:30-18:30 ${tz} candidate-night scored window; ts-15-ops audits writes here`,
      cairo_time,
      minutes_until_allowed: BLACKOUT_END_MIN - mins,
    };
  }
  return {
    allowed: true,
    reason: 'outside the scored window',
    cairo_time,
    minutes_until_allowed: null,
  };
}

/**
 * Would a job of `estimatedMinutes` still be writing when the blackout opens?
 *
 * Used to refuse STARTING a drain that cannot finish in time, rather than
 * discovering the problem halfway through and leaving a partial write.
 */
export function fitsBeforeBlackout(estimatedMinutes, date = new Date(), tz = TZ) {
  const mins = cairoMinutes(date, tz);
  if (mins >= BLACKOUT_END_MIN) return { fits: true, reason: 'after the window closes for the day' };
  if (mins >= BLACKOUT_START_MIN) return { fits: false, reason: 'already inside the window' };
  const room = BLACKOUT_START_MIN - mins;
  return {
    fits: estimatedMinutes <= room,
    room_minutes: room,
    reason: estimatedMinutes <= room
      ? `${Math.round(estimatedMinutes)}min job fits in ${room}min of runway`
      : `${Math.round(estimatedMinutes)}min job exceeds ${room}min of runway before 14:30 ${tz}`,
  };
}
