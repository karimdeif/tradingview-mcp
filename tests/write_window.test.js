/**
 * Tests for the QuestDB write-window guard.
 * The estate rule (no new-writer activity 14:30-18:30 Africa/Cairo, because
 * ts-15-ops audits writes in the candidate-night scored window) is enforced in
 * code rather than left to operator attention.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { questdbWriteAllowed, fitsBeforeBlackout, cairoMinutes } from '../src/research/write_window.js';

// Cairo is UTC+3 (EEST) on this date, so 11:30Z == 14:30 Cairo.
const at = (utcHHMM) => new Date(`2026-08-19T${utcHHMM}:00Z`);

describe('cairoMinutes', () => {
  it('converts UTC to Cairo minutes-since-midnight', () => {
    assert.equal(cairoMinutes(at('09:27')), 12 * 60 + 27);
    assert.equal(cairoMinutes(at('11:30')), 14 * 60 + 30);
  });
});

describe('questdbWriteAllowed', () => {
  it('allows writes before the window opens', () => {
    const r = questdbWriteAllowed(at('09:27'));
    assert.equal(r.allowed, true);
    assert.equal(r.cairo_time, '12:27');
  });

  it('blocks exactly at 14:30 Cairo', () => {
    const r = questdbWriteAllowed(at('11:30'));
    assert.equal(r.allowed, false);
    assert.match(r.reason, /scored window/);
    assert.equal(r.minutes_until_allowed, 240);
  });

  it('blocks through the middle of the window', () => {
    assert.equal(questdbWriteAllowed(at('13:00')).allowed, false); // 16:00 Cairo
  });

  it('allows again exactly at 18:30 Cairo', () => {
    const r = questdbWriteAllowed(at('15:30'));
    assert.equal(r.allowed, true);
    assert.equal(r.cairo_time, '18:30');
  });

  it('allows late evening', () => {
    assert.equal(questdbWriteAllowed(at('19:00')).allowed, true); // 22:00 Cairo
  });
});

describe('fitsBeforeBlackout', () => {
  it('accepts a short job with runway', () => {
    const f = fitsBeforeBlackout(2, at('09:27')); // 12:27 Cairo, 123min runway
    assert.equal(f.fits, true);
    assert.equal(f.room_minutes, 123);
  });

  it('refuses a job that would still be writing at 14:30', () => {
    const f = fitsBeforeBlackout(100, at('10:30')); // 13:30 Cairo, 60min runway
    assert.equal(f.fits, false);
    assert.match(f.reason, /exceeds 60min/);
  });

  it('refuses once already inside the window', () => {
    assert.equal(fitsBeforeBlackout(1, at('12:00')).fits, false); // 15:00 Cairo
  });

  it('accepts after the window has closed for the day', () => {
    assert.equal(fitsBeforeBlackout(120, at('16:00')).fits, true); // 19:00 Cairo
  });
});

describe('drain dry-run is non-destructive (regression)', () => {
  it('leaves the spool file and its contents untouched', async () => {
    // Regression: an earlier drain renamed the spool, no-op'd every insert
    // under --dry-run, then unlinked the file — destroying 39 harvested rows
    // while printing "complete: 39 rows landed".
    const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { execFileSync } = await import('child_process');

    const dir = mkdtempSync(join(tmpdir(), 'drain-dry-'));
    const spool = join(dir, 's.jsonl');
    const row = { table: 'tv_council_notes', row: { symbol: 'TEST', harvested_at: '2026-08-19T09:00:00.000Z', note_kind: 'council' } };
    const original = JSON.stringify(row) + '\n';
    writeFileSync(spool, original);

    // 09:00Z == 12:00 Cairo, outside the blackout, so the window guard permits.
    execFileSync('node', ['scripts/council_drain.mjs', '--dry-run', '--spool', spool], { stdio: 'pipe' });

    assert.equal(existsSync(spool), true, 'dry run must not delete the spool');
    assert.equal(readFileSync(spool, 'utf8'), original, 'dry run must not alter the spool');
    assert.equal(existsSync(spool + '.draining'), false, 'dry run must not leave a working file');
  });
});
