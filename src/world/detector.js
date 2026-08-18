/**
 * Deterministic shock detector for the world-context arm (karimdeif fork).
 *
 * Pure logic, no I/O, no LLM. Given a stream of per-symbol samples it decides
 * when a move is large enough to stage a review-gated event.
 *
 * Everything here is advisory under the estate's §8 law: world context may veto
 * or reduce, never add or accelerate. Nothing in this module emits an
 * instruction — it emits an observation with enough provenance for a registered
 * study to decide what, if anything, it means.
 *
 * Four guards, all of which exist because a naive threshold would misfire:
 *
 *  - STALENESS. A sample older than the rule's max_staleness_s is not evaluated.
 *    A delayed or frozen feed must never be read as a calm market.
 *  - MIN SAMPLES. A window with too few points can show a huge "delta" that is
 *    really just the first two ticks after a restart.
 *  - HYSTERESIS. Level rules re-arm only after recovering past a separate
 *    threshold, so a market parked below the line fires once, not every cycle.
 *  - COOLDOWN. A hard floor on re-fire interval per rule.
 */

/** Default rule set. Thresholds are starting points, not validated edges. */
export const DEFAULT_RULES = [
  {
    id: 'us10y_yield_shock',
    symbol: 'US10Y',
    kind: 'delta_abs',
    field: 'last',
    // TVC:US10Y is quoted in percent (4.736 == 4.736%), so 5bps == 0.05.
    threshold: 0.05,
    window_s: 900,
    min_samples: 4,
    max_staleness_s: 420,
    cooldown_s: 1800,
    note: '10Y yield moved >=5bp in 15min',
  },
  {
    id: 'dxy_shock',
    symbol: 'DXY',
    kind: 'delta_pct',
    field: 'last',
    threshold: 0.3,
    window_s: 900,
    min_samples: 4,
    max_staleness_s: 420,
    cooldown_s: 1800,
    note: 'Dollar index moved >=0.3% in 15min',
  },
  {
    id: 'gold_shock',
    symbol: 'GOLD',
    kind: 'delta_pct',
    field: 'last',
    threshold: 1.0,
    window_s: 900,
    min_samples: 4,
    max_staleness_s: 420,
    cooldown_s: 1800,
    note: 'Spot gold moved >=1.0% in 15min',
  },
  {
    id: 'es_session_drawdown',
    symbol: 'ES1!',
    kind: 'level_below',
    field: 'session_change_pct',
    threshold: -1.5,
    rearm_above: -1.0,
    min_samples: 1,
    // ES/NQ ride a ~10min delayed feed; allow for that plus a cycle.
    max_staleness_s: 1200,
    cooldown_s: 3600,
    note: 'S&P futures session move <=-1.5%',
  },
  {
    id: 'nq_session_drawdown',
    symbol: 'NQ1!',
    kind: 'level_below',
    field: 'session_change_pct',
    threshold: -1.5,
    rearm_above: -1.0,
    min_samples: 1,
    max_staleness_s: 1200,
    cooldown_s: 3600,
    note: 'Nasdaq futures session move <=-1.5%',
  },
];

export function createDetector({ rules = DEFAULT_RULES } = {}) {
  /** symbol -> [{t, values:{}, feed_lag_s, realtime}] */
  const samples = new Map();
  /** ruleId -> {armed, lastFireT} */
  const state = new Map();
  for (const r of rules) state.set(r.id, { armed: true, lastFireT: null });

  const maxWindow = Math.max(...rules.map((r) => r.window_s || 0), 900);

  return {
    /** Feed one collected row. `t` is epoch seconds. */
    push(symbol, t, values, meta = {}) {
      if (!samples.has(symbol)) samples.set(symbol, []);
      const arr = samples.get(symbol);
      arr.push({ t, values, ...meta });
      // Keep a little more than the widest window so evaluate() always has room.
      const cutoff = t - maxWindow * 2;
      while (arr.length && arr[0].t < cutoff) arr.shift();
    },

    /** Evaluate every rule at time `now` (epoch seconds). Returns fired events. */
    evaluate(now) {
      const fired = [];
      for (const rule of rules) {
        const st = state.get(rule.id);
        const arr = samples.get(rule.symbol) || [];
        if (!arr.length) continue;

        const latest = arr[arr.length - 1];
        const sampleAge = now - latest.t;

        // GUARD 1: stale input is not evidence of calm.
        if (sampleAge > rule.max_staleness_s) continue;

        const v = latest.values?.[rule.field];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;

        const inCooldown = st.lastFireT !== null && (now - st.lastFireT) < rule.cooldown_s;

        if (rule.kind === 'level_below') {
          // GUARD 3: hysteresis — re-arm only after a real recovery.
          if (!st.armed) {
            if (v > rule.rearm_above) st.armed = true;
            continue;
          }
          if (v <= rule.threshold && !inCooldown) {
            st.armed = false;
            st.lastFireT = now;
            fired.push(buildEvent(rule, latest, { observed: v, comparison: `<= ${rule.threshold}` }));
          }
          continue;
        }

        // Delta rules: compare the newest sample against the oldest one still
        // inside the window.
        const windowStart = now - rule.window_s;
        const inWindow = arr.filter((s) => s.t >= windowStart);
        // GUARD 2: too few points means the "delta" is a restart artefact.
        if (inWindow.length < rule.min_samples) continue;

        const first = inWindow[0];
        const v0 = first.values?.[rule.field];
        if (v0 === null || v0 === undefined || !Number.isFinite(v0)) continue;

        let magnitude;
        if (rule.kind === 'delta_abs') magnitude = Math.abs(v - v0);
        else if (rule.kind === 'delta_pct') magnitude = v0 === 0 ? null : Math.abs(((v - v0) / v0) * 100);
        else continue;
        if (magnitude === null || !Number.isFinite(magnitude)) continue;

        if (magnitude >= rule.threshold && !inCooldown) {
          st.lastFireT = now;
          fired.push(buildEvent(rule, latest, {
            observed: Number(magnitude.toFixed(6)),
            comparison: `>= ${rule.threshold}`,
            from: v0,
            to: v,
            window_s: rule.window_s,
            samples_in_window: inWindow.length,
          }));
        }
      }
      return fired;
    },

    /** Introspection for the daemon's status line and for tests. */
    _state: () => ({
      samples: Object.fromEntries([...samples].map(([k, v]) => [k, v.length])),
      rules: Object.fromEntries([...state]),
    }),
  };
}

function buildEvent(rule, latest, detail) {
  const stale = latest.realtime === false;
  return {
    rule_id: rule.id,
    symbol: rule.symbol,
    field: rule.field,
    kind: rule.kind,
    fired_at: latest.t,
    note: rule.note,
    ...detail,
    // Freshness travels WITH the alert. An ES/NQ shock is up to ~10min old at
    // the moment it fires; anything reading this must be able to see that
    // without knowing which symbols are delayed.
    realtime: latest.realtime ?? null,
    feed_lag_s: latest.feed_lag_s ?? null,
    delayed_feed: stale,
    freshness_warning: stale
      ? `DELAYED FEED: ${rule.symbol} runs ~${Math.round((latest.feed_lag_s ?? 0) / 60)}min behind. This condition may have begun that much earlier.`
      : null,
    // §8: observation only. Never an instruction.
    advisory_only: true,
    machine_requires_review: true,
  };
}
