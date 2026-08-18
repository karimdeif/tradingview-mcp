/**
 * QuestDB sink for the world-context arm (karimdeif fork).
 *
 * ESTATE RULES THIS ENCODES — read before changing anything here:
 *
 *  1. SINGLE-ROW INSERTS VIA /exec ONLY. The /imp bulk-import endpoint is the
 *     current QuestDB crash trigger and must never be used from this service.
 *     There is deliberately no batch path in this module.
 *  2. THIS SERVICE WRITES ONE TABLE: tv_world_quotes (plus staging rows into
 *     news_events_staging). It must never write or delete the market tables
 *     (trades, daily_ohlcv, regime_gate, news_events*) — only INSERT into its
 *     own table and the staging table.
 *  3. Host is addressed as questdb.lan, never by IP.
 *  4. Disabled by default. Enabling is a deliberate deployment step.
 *
 * The local spool is NOT a data interface. Under estate law QuestDB is the only
 * interface; the spool exists solely so an outage does not lose rows, and it is
 * drained and deleted on reconnect. Nothing else may read it.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export const TABLE = 'tv_world_quotes';

/** Table DDL. Kept in code so deploy docs and reality cannot drift apart. */
export const DDL = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  ts TIMESTAMP,
  symbol SYMBOL CAPACITY 64 CACHE,
  tv_symbol SYMBOL CAPACITY 64 CACHE,
  role SYMBOL CAPACITY 32 CACHE,
  last DOUBLE,
  session_open DOUBLE,
  session_change_pct DOUBLE,
  session_high DOUBLE,
  session_low DOUBLE,
  volume LONG,
  volume_available BOOLEAN,
  bar_ts TIMESTAMP,
  feed_lag_s INT,
  delay_est_s INT,
  realtime BOOLEAN,
  realtime_drift BOOLEAN,
  exchange SYMBOL CAPACITY 32 CACHE,
  instrument_type SYMBOL CAPACITY 32 CACHE,
  source SYMBOL CAPACITY 16 CACHE,
  collector_cycle LONG,
  replayed BOOLEAN
) TIMESTAMP(ts) PARTITION BY DAY WAL
DEDUP UPSERT KEYS(ts, symbol);`;

/** SQL string literal escape. Single quotes doubled, per SQL standard. */
export function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** SQL numeric, or NULL. Rejects NaN/Infinity rather than emitting garbage. */
export function sqlNum(v) {
  if (v === null || v === undefined) return 'NULL';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : 'NULL';
}

export function sqlBool(v) {
  if (v === null || v === undefined) return 'NULL';
  return v ? 'true' : 'false';
}

/** Epoch seconds (or ISO string) -> QuestDB timestamp literal. */
export function sqlTs(v) {
  if (v === null || v === undefined) return 'NULL';
  const ms = typeof v === 'number' ? v * 1000 : Date.parse(v);
  if (!Number.isFinite(ms)) return 'NULL';
  return `to_timestamp('${new Date(ms).toISOString()}', 'yyyy-MM-ddTHH:mm:ss.SSSZ')`;
}

/** Build the single-row INSERT for one collected row. */
export function buildInsert(row) {
  const cols = [
    'ts', 'symbol', 'tv_symbol', 'role', 'last', 'session_open', 'session_change_pct',
    'session_high', 'session_low', 'volume', 'volume_available', 'bar_ts', 'feed_lag_s',
    'delay_est_s', 'realtime', 'realtime_drift', 'exchange', 'instrument_type', 'source',
    'collector_cycle', 'replayed',
  ];
  const vals = [
    sqlTs(row.ts_utc),
    sqlStr(row.symbol),
    sqlStr(row.tv_symbol),
    sqlStr(row.role),
    sqlNum(row.last),
    sqlNum(row.session_open),
    sqlNum(row.session_change_pct),
    sqlNum(row.session_high),
    sqlNum(row.session_low),
    // volume is LONG and genuinely absent for TVC synthetics — NULL, never 0.
    sqlNum(row.volume),
    sqlBool(row.volume_available),
    sqlTs(row.bar_ts),
    sqlNum(row.feed_lag_s),
    sqlNum(row.delay_est_s),
    sqlBool(row.realtime),
    sqlBool(row.realtime_drift),
    sqlStr(row.exchange),
    sqlStr(row.instrument_type),
    sqlStr(row.source ?? 'tradingview-mcp'),
    sqlNum(row.collector_cycle),
    sqlBool(row.replayed ?? false),
  ];
  return `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
}

/** Staging row for a shock event. Human-gated, exactly like GMS. */
export function buildStagingInsert(event, stagingId) {
  const headline = `[TV_WORLD] ${event.symbol} ${event.note}`;
  const body = JSON.stringify(event);
  const cols = ['ts', 'staging_id', 'source', 'headline', 'body', 'machine_requires_review'];
  const vals = [
    sqlTs(event.fired_at),
    sqlStr(stagingId),
    sqlStr('TV_WORLD'),
    sqlStr(headline),
    sqlStr(body),
    'true',
  ];
  return `INSERT INTO news_events_staging (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
}

/**
 * Sink. Disabled unless explicitly enabled — the constructor does not connect,
 * and nothing here reaches the network until enabled is true.
 */
export function createSink({
  enabled = false,
  host = 'questdb.lan',
  port = 9000,
  spoolPath,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  log = () => {},
} = {}) {
  let healthy = enabled;
  const stats = { inserted: 0, spooled: 0, drained: 0, failures: 0 };

  function spool(row) {
    if (!spoolPath) return;
    mkdirSync(dirname(spoolPath), { recursive: true });
    appendFileSync(spoolPath, JSON.stringify(row) + '\n');
    stats.spooled++;
  }

  async function exec(sql) {
    if (!enabled) throw new Error('questdb sink disabled');
    const url = `http://${host}:${port}/exec?query=${encodeURIComponent(sql)}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`questdb HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      if (body && body.error) throw new Error(`questdb error: ${body.error}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    stats: () => ({ ...stats, enabled, healthy }),

    /** Write one row. On any failure the row goes to the spool, never dropped. */
    async write(row) {
      if (!enabled) { spool(row); return { ok: false, spooled: true, reason: 'disabled' }; }
      try {
        await exec(buildInsert(row));
        stats.inserted++;
        healthy = true;
        return { ok: true };
      } catch (err) {
        stats.failures++;
        healthy = false;
        spool(row);
        log(`questdb write failed (${err.message}) — row spooled`);
        return { ok: false, spooled: true, reason: err.message };
      }
    },

    async writeStaging(event, stagingId) {
      if (!enabled) return { ok: false, reason: 'disabled' };
      try {
        await exec(buildStagingInsert(event, stagingId));
        return { ok: true };
      } catch (err) {
        stats.failures++;
        log(`questdb staging write failed: ${err.message}`);
        return { ok: false, reason: err.message };
      }
    },

    /**
     * Drain the spool into QuestDB, preserving original timestamps. DEDUP
     * UPSERT KEYS(ts, symbol) makes replay idempotent, so a partial drain that
     * is retried cannot double-count. The spool file is removed only after
     * every row lands.
     */
    async drain() {
      if (!enabled || !spoolPath || !existsSync(spoolPath)) return { drained: 0, remaining: 0 };
      const working = `${spoolPath}.draining`;
      renameSync(spoolPath, working);
      const lines = readFileSync(working, 'utf8').split('\n').filter(Boolean);
      let ok = 0;
      const failed = [];
      for (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        try {
          await exec(buildInsert({ ...row, replayed: true }));
          ok++; stats.drained++;
        } catch {
          failed.push(line);
        }
      }
      if (failed.length) {
        appendFileSync(spoolPath, failed.join('\n') + '\n');
        log(`drain partial: ${ok} landed, ${failed.length} back in spool`);
      } else {
        log(`drain complete: ${ok} rows replayed`);
      }
      unlinkSync(working);
      return { drained: ok, remaining: failed.length };
    },

    async ensureTable() {
      if (!enabled) return { ok: false, reason: 'disabled' };
      await exec(DDL);
      return { ok: true };
    },
  };
}
