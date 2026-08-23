/**
 * Regression tests for the scoped strategy-backtest tools.
 *
 * One named test per incident, per the estate convention:
 *   2026-08-22  pine_smart_compile clicked Save instead of "Add to chart"
 *               (button-only scan; the control is a <span>). success:true,
 *               study_added:false, and the report read a DIFFERENT strategy.
 *   2026-08-23  sol-max review, pass 1: the double gate was single.
 *   2026-08-23  sol-max review, pass 2: label-matched DOM clicking cannot
 *               prove "never saves" — delegated listeners, deep nesting,
 *               label[for], form submit and shadow DOM all bypass it. The
 *               attach path is now the Pine editor facade, not a click.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LIST_STUDIES_JS, verifyAttachment, attachViaFacade, attestImplementations,
  pollAccepts, identitySignature, sha1,
} from '../src/core/backtest.js';
import {
  resolveAllowlist, scopedWritersActive, BACKTEST_TOOLS, READONLY_TOOLS,
} from '../src/allowlist.js';

const RAW_SRC = readFileSync(new URL('../src/core/backtest.js', import.meta.url), 'utf8');
/** Code only — the header comments legitimately name the things the code avoids. */
const CORE_SRC = RAW_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('attach path is capability-based, not a DOM click', () => {
  it('never calls .click() anywhere — clicking is what could not be made safe', () => {
    assert.ok(!/\.click\s*\(/.test(CORE_SRC), 'a DOM click can bubble or trigger a default action into Save');
  });

  it('never references any save capability', () => {
    for (const forbidden of ['saveScript', 'saveDraftIfModified', 'saveNewScript', 'saveExistingScript']) {
      assert.ok(!CORE_SRC.includes(forbidden), `${forbidden} must never appear in this module`);
    }
  });

  it('never calls updateOnChart — its first branch is saveScript()', () => {
    assert.ok(!/updateOnChart/.test(CORE_SRC));
  });

  it('attaches through the Pine editor facade addToChart()', () => {
    assert.match(CORE_SRC, /_pineEditorApi/);
    assert.match(CORE_SRC, /getDialogFacade/);
    assert.match(CORE_SRC, /addToChart\(\)/);
  });

  it('does not import from pine.js — ensurePineEditorOpen() clicks [aria-label="Pine"]', () => {
    assert.ok(!/from '\.\/pine\.js'/.test(CORE_SRC), 'importing it puts a DOM click back in the reachable call graph');
    assert.match(CORE_SRC, /_pineEditorApi[\s\S]*?\.open\(\)/, 'the editor is opened via the capability API');
  });

  it('does not scan the DOM for a control by label', () => {
    assert.ok(!/querySelectorAll\('\*'\)/.test(CORE_SRC));
    assert.ok(!/'add to chart'/i.test(CORE_SRC), 'no label matching in code');
  });
});

describe('verifyAttachment — causality', () => {
  const SCRIPT = { script_id: 'USER;abc123', version: '0.9', digest: 'deadbeef' };
  const strat = (id, name) => ({ id, name, is_strategy: true, script_id: SCRIPT.script_id, pine_version: SCRIPT.version, pine_digest: 'deadbeef' });
  const OK = { ok: true, awaited: true };
  const base = { attached: OK, stable: true, expect_name: 'Golden Cross Exec', expectedScript: SCRIPT };

  it('accepts a clean single attachment with an exact name match', () => {
    const r = verifyAttachment({ ...base, before: [], after: [strat('a1', 'Golden Cross Exec')] });
    assert.deepEqual(r.problems, []);
    assert.equal(r.target.id, 'a1');
  });

  it('REJECTS an attach that was not awaited — ok:true would only mean a Promise was created', () => {
    const r = verifyAttachment({ ...base, attached: { ok: true }, before: [], after: [strat('a1', 'Golden Cross Exec')] });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /was not awaited/.test(p)));
  });

  it('REJECTS when the attach call did not report success', () => {
    const r = verifyAttachment({ ...base, attached: { ok: false, awaited: true }, before: [], after: [strat('a1', 'Golden Cross Exec')] });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /did not report success/.test(p)));
  });

  it('REJECTS when the study list never stabilised', () => {
    const r = verifyAttachment({ ...base, stable: false, before: [], after: [strat('a1', 'Golden Cross Exec')] });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /never reached a stable state/.test(p)));
  });

  it('REJECTS a descriptor with no usable entity id', () => {
    const r = verifyAttachment({ ...base, before: [], after: [{ ...strat('x', 'Golden Cross Exec'), id: undefined }] });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /no usable entity id/.test(p)));
  });

  it('REJECTS a pre-existing strategy — nothing new appeared', () => {
    const existing = [strat('old', 'Golden Cross Exec')];
    const r = verifyAttachment({ ...base, before: existing, after: existing });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /No new study appeared/.test(p)));
  });

  it('REJECTS more than one new study', () => {
    const r = verifyAttachment({ ...base, before: [], after: [strat('a1', 'One'), strat('a2', 'Two')] });
    assert.equal(r.target, undefined);
  });

  it('surfaces failed study-list reads', () => {
    const r = verifyAttachment({ ...base, before: [], after: null, stable: false, readFailures: 3 });
    assert.ok(r.problems.some((p) => /3 study-list read/.test(p)));
  });
});

describe('verifyAttachment — identity (exact match required)', () => {
  const SCRIPT = { script_id: 'USER;abc123', version: '0.9', digest: 'deadbeef' };
  const strat = (id, name) => ({ id, name, is_strategy: true, script_id: SCRIPT.script_id, pine_version: SCRIPT.version, pine_digest: 'deadbeef' });
  const base = { attached: { ok: true, awaited: true }, stable: true, before: [], expectedScript: SCRIPT };

  it('REJECTS a prefix match — "Golden Cross Exec — old variant" is a different script', () => {
    const r = verifyAttachment({ ...base, after: [strat('a1', 'Golden Cross Exec — old variant')], expect_name: 'Golden Cross Exec' });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /exact match required/.test(p)));
  });

  it('REJECTS an expectation below the 4-character bound', () => {
    const r = verifyAttachment({ ...base, after: [strat('a1', 'Gld Digger')], expect_name: 'Gld' });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /too short/.test(p)), 'must reject on the length bound itself');
  });

  it('REJECTS a longer name that merely starts with the expectation', () => {
    const r = verifyAttachment({ ...base, after: [strat('a1', 'Gold Digger Strategy')], expect_name: 'Gold' });
    assert.equal(r.target, undefined);
  });

  it('REJECTS a missing expect_name — optionality let any new strategy pass', () => {
    const r = verifyAttachment({ ...base, after: [strat('a1', 'Anything At All')] });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /expect_name is required/.test(p)));
  });

  it('REJECTS an empty expect_name — every string contains ""', () => {
    const r = verifyAttachment({ ...base, after: [strat('a1', 'Anything')], expect_name: '   ' });
    assert.equal(r.target, undefined);
  });

  it('REJECTS a target with no readable name', () => {
    const r = verifyAttachment({ ...base, after: [{ ...strat('a1', 'x'), name: null }], expect_name: 'Golden Cross Exec' });
    assert.equal(r.target, undefined);
  });

  it('REJECTS a non-strategy study', () => {
    const r = verifyAttachment({ ...base, after: [{ ...strat('a1', 'Some Indicator'), is_strategy: false }], expect_name: 'Some Indicator' });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /is not a strategy/.test(p)));
  });

  it('normalises case and whitespace but nothing more', () => {
    const r = verifyAttachment({ ...base, after: [strat('a1', '  Golden   Cross Exec ')], expect_name: 'golden cross exec' });
    assert.deepEqual(r.problems, []);
  });
});

describe('study listing (regression: strategy flag read off the wrong collection)', () => {
  it('reads the strategy flag from dataSources(), not getAllStudies()', () => {
    assert.match(LIST_STUDIES_JS, /dataSources\(\)/);
    assert.match(LIST_STUDIES_JS, /isTVScriptStrategy/);
  });
  it('still takes ids and the count delta from getAllStudies()', () => {
    assert.match(LIST_STUDIES_JS, /getAllStudies\(\)/);
  });
});

describe('backtest allowlist preset', () => {
  it('contains the scoped tools plus everything readonly had', () => {
    const set = resolveAllowlist('backtest');
    for (const t of ['pine_add_to_chart', 'chart_clear_studies', 'pine_set_draft_source',
      'data_get_strategy_results', 'data_get_trades', 'data_get_equity']) {
      assert.ok(set.has(t), `missing ${t}`);
    }
    for (const t of READONLY_TOOLS) assert.ok(set.has(t), `dropped readonly tool ${t}`);
    assert.equal(set.size, BACKTEST_TOOLS.length);
  });

  it('excludes every tool that can write to the TradingView cloud account, and pine_set_source (DOM click reachable)', () => {
    const set = resolveAllowlist('backtest');
    for (const t of ['pine_save', 'pine_compile', 'pine_smart_compile', 'pine_set_source', 'ui_evaluate',
      'ui_click', 'ui_open_panel', 'alert_create', 'watchlist_add', 'batch_run', 'tv_launch']) {
      assert.ok(!set.has(t), `${t} must not be in the backtest preset`);
    }
  });

  it('leaves the readonly preset untouched — the world daemon is unaffected', () => {
    const set = resolveAllowlist('readonly');
    assert.equal(set.size, READONLY_TOOLS.length);
    assert.ok(!set.has('pine_add_to_chart'));
    assert.ok(!set.has('pine_set_draft_source'));
  });
});

describe('double gate (regression: 2026-08-23 sol-max — env var alone was enough)', () => {
  const R = (raw) => resolveAllowlist(raw);

  it('does NOT activate when the allowlist is unset — null means allow-everything', () => {
    for (const raw of [undefined, '', '   ']) assert.equal(scopedWritersActive(R(raw), '1'), false);
  });

  it('does NOT activate when the allowlist does not name the tools', () => {
    for (const raw of ['readonly', 'harvest', 'quote_get,data_get_ohlcv']) {
      assert.equal(scopedWritersActive(R(raw), '1'), false, raw);
    }
  });

  it('does NOT activate without the env var, however permissive the allowlist', () => {
    for (const env of [undefined, '', '0', 'true', 'yes']) {
      assert.equal(scopedWritersActive(R('backtest'), env), false, `env=${env}`);
    }
  });

  it('activates only when BOTH hold', () => {
    assert.equal(scopedWritersActive(R('backtest'), '1'), true);
    assert.equal(scopedWritersActive(R('pine_add_to_chart'), '1'), true);
  });
});

describe('source identity (regression: 2026-08-23 sol-max pass 3 — title is not identity)', () => {
  const SCRIPT = { script_id: 'USER;abc123', version: '0.9', digest: 'deadbeef' };
  const strat = (id, name, over = {}) => ({
    id, name, is_strategy: true, script_id: SCRIPT.script_id,
    pine_version: SCRIPT.version, pine_digest: 'deadbeef', ...over,
  });
  const base = {
    attached: { ok: true, awaited: true }, stable: true, before: [],
    expect_name: 'Golden Cross Exec', expectedScript: SCRIPT,
  };

  it('accepts a study whose scriptIdPart matches the editor', () => {
    const r = verifyAttachment({ ...base, after: [strat('a1', 'Golden Cross Exec')] });
    assert.deepEqual(r.problems, []);
    assert.equal(r.target.script_id, SCRIPT.script_id);
  });

  it('REJECTS a DIFFERENT script that declares the SAME strategy() title', () => {
    // Two Pine files can both be strategy("Golden Cross Exec"). Only the
    // script id distinguishes them.
    const r = verifyAttachment({
      ...base, after: [strat('a1', 'Golden Cross Exec', { script_id: 'USER;other999' })],
    });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /came from script USER;other999/.test(p)));
  });

  it('REJECTS a stale version of the right script', () => {
    const r = verifyAttachment({
      ...base, after: [strat('a1', 'Golden Cross Exec', { pine_version: '0.8' })],
    });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /script version 0\.8/.test(p)));
  });

  it('accepts a FRESH draft — no pre-attach id/version, digest still binds', () => {
    // setNewScript() drafts have no scriptIdPart until the attach persists
    // them; the digest comparison is the unconditional binder.
    const r = verifyAttachment({
      ...base, expectedScript: { script_id: null, version: null, digest: SCRIPT.digest },
      after: [strat('a1', 'Golden Cross Exec')],
    });
    assert.deepEqual(r.problems, []);
  });

  it('still REJECTS a fresh draft whose attached digest differs', () => {
    const r = verifyAttachment({
      ...base, expectedScript: { script_id: null, version: null, digest: SCRIPT.digest },
      after: [strat('a1', 'Golden Cross Exec', { pine_digest: 'someotherdigest' })],
    });
    assert.equal(r.target, undefined);
  });

  it('REJECTS when the study exposes no script id', () => {
    const r = verifyAttachment({ ...base, after: [strat('a1', 'Golden Cross Exec', { script_id: null })] });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /no script id/.test(p)));
  });

  it('REJECTS when the editor id could not be read before attaching', () => {
    const r = verifyAttachment({ ...base, expectedScript: null, after: [strat('a1', 'Golden Cross Exec')] });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /source identity unverifiable/.test(p)));
  });
});

describe('study listing exposes source identity', () => {
  it('reads scriptIdPart and the pine digest', () => {
    assert.match(LIST_STUDIES_JS, /scriptIdPart/);
    assert.match(LIST_STUDIES_JS, /digest/);
  });
});

describe('attachViaFacade — promise behaviour (regression: pass 3, the un-awaited attach)', () => {
  it('propagates a rejecting evaluator as a failure, not a success', async () => {
    const r = await attachViaFacade(async () => { throw new Error('CDP died'); });
    assert.equal(r.ok, false);
    assert.match(r.error, /CDP died/);
  });

  it('treats an empty evaluation result as failure', async () => {
    const r = await attachViaFacade(async () => null);
    assert.equal(r.ok, false);
  });

  it('returns the page verdict verbatim when the page reports failure', async () => {
    const r = await attachViaFacade(async () => ({ ok: false, error: 'Editor does not hold a draft (isDraft=false).' }));
    assert.equal(r.ok, false);
    assert.match(r.error, /isDraft=false/);
  });

  it('its page code refuses a non-draft BEFORE invoking addToChart', async () => {
    // The draft gate must run first: _addToChartUnsavedVersion (the modified-
    // saved-script branch) is not attested save-free.
    let sent = '';
    await attachViaFacade(async (expr) => { sent = expr; return { ok: false }; });
    const draftCheck = sent.indexOf('verified.isDraft.call(f)');
    const attachCall = sent.indexOf('await verified._addToChartNewDraft.call(f)');
    assert.ok(draftCheck !== -1 && attachCall !== -1 && draftCheck < attachCall,
      'isDraft must be checked before the draft branch is awaited, both via the attested callables');
    assert.match(sent, /draft !== true/);
  });
});

describe('build attestation (pass 4 — a drifted facade must refuse, not proceed)', () => {
  const GOOD = { addToChart: 'async addToChart(){/*v2.14.0*/}' };
  const ATTESTED = { addToChart: sha1(GOOD.addToChart) };

  it('accepts the exact attested implementation', () => {
    assert.equal(attestImplementations(GOOD, ATTESTED).ok, true);
  });

  it('refuses a changed implementation', () => {
    const r = attestImplementations({ addToChart: 'async addToChart(){ this.saveScript(); }' }, ATTESTED);
    assert.equal(r.ok, false);
    assert.match(r.error, /has not been reviewed/);
  });

  it('refuses a missing implementation', () => {
    const r = attestImplementations({ addToChart: null }, ATTESTED);
    assert.equal(r.ok, false);
    assert.match(r.error, /missing/);
  });

  it('refuses when the facade could not be read at all', () => {
    assert.equal(attestImplementations(null, ATTESTED).ok, false);
  });
});

describe('poll acceptance (pass 4 — a swap is not an addition)', () => {
  const st = (id) => ({ id, name: 'x', is_strategy: true });

  it('accepts exactly one new study with all prior ids preserved', () => {
    assert.equal(pollAccepts({ before: [st('a')], now: [st('a'), st('b')] }), true);
  });

  it('REJECTS a swap — old id replaced by new id, count unchanged', () => {
    assert.equal(pollAccepts({ before: [st('a')], now: [st('b')] }), false);
  });

  it('REJECTS two additions', () => {
    assert.equal(pollAccepts({ before: [], now: [st('a'), st('b')] }), false);
  });

  it('REJECTS an addition that also dropped a prior study', () => {
    assert.equal(pollAccepts({ before: [st('a'), st('b')], now: [st('a'), st('c'), st('d')] }), false);
  });

  it('identity signature changes when only the digest changes — ids alone cannot see it', () => {
    const a = [{ id: 'x', script_id: 's', pine_digest: 'd1', pine_version: '1', name: 'n' }];
    const b = [{ id: 'x', script_id: 's', pine_digest: 'd2', pine_version: '1', name: 'n' }];
    assert.notEqual(identitySignature(a), identitySignature(b));
  });
});

describe('digest correlation (pass 4 — id+version can be reused by an Untitled draft)', () => {
  const SCRIPT = { script_id: 'USER;abc123', version: '0.9', digest: sha1('the real source') };
  const strat = (over = {}) => ({
    id: 'a1', name: 'Golden Cross Exec', is_strategy: true,
    script_id: SCRIPT.script_id, pine_version: SCRIPT.version, pine_digest: SCRIPT.digest, ...over,
  });
  const base = {
    attached: { ok: true, awaited: true }, stable: true, before: [],
    expect_name: 'Golden Cross Exec', expectedScript: SCRIPT,
  };

  it('accepts when id, version AND digest all match', () => {
    const r = verifyAttachment({ ...base, after: [strat()] });
    assert.deepEqual(r.problems, []);
  });

  it('REJECTS same id and version with a WRONG digest — stale source on a reused draft', () => {
    const r = verifyAttachment({ ...base, after: [strat({ pine_digest: sha1('some older source') })] });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /DIFFERENT source is on the chart/.test(p)));
  });

  it('accepts a missing study version when the digest binds (fresh-draft mechanics)', () => {
    const r = verifyAttachment({ ...base, after: [strat({ pine_version: null })] });
    assert.deepEqual(r.problems, [], 'digest is the unconditional binder; version is corroboration');
  });

  it('REJECTS a missing study digest', () => {
    const r = verifyAttachment({ ...base, after: [strat({ pine_digest: null })] });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /no source digest/.test(p)));
  });

  it('REJECTS when the editor buffer digest was not established (id/version alone insufficient)', () => {
    const r = verifyAttachment({ ...base, expectedScript: { script_id: 'USER;abc123', version: '0.9' }, after: [strat()] });
    assert.equal(r.target, undefined);
    assert.ok(r.problems.some((p) => /digest was not established/.test(p)));
  });
});

describe('atomic attestation binding (regression: 2026-08-23 sol-max pass 5)', () => {
  // Execute attachViaFacade's REAL page expression against a fake window: the
  // fake evaluator compiles and runs the expression it receives, so shadowing,
  // rebinding and drift are exercised for real — not asserted on source text.
  function makeWindow({ facade, ua = 'TVDesktop/9.9.9-test' }) {
    return {
      TradingViewApi: { _pineEditorApi: { getDialogFacade: () => facade } },
    };
  }
  function evaluatorFor(win, ua = 'TVDesktop/9.9.9-test') {
    return async (expr) => {
      // eslint-disable-next-line no-new-func
      const run = new Function('window', 'navigator', `return (${expr})`);
      return run(win, { userAgent: `Mozilla/5.0 ${ua} Electron/0.0` });
    };
  }
  function buildFacade() {
    class Facade {
      isDraft() { return true; }
      async addToChart() { this._dispatched = true; }
      async _addToChartNewDraft() { this._attached = true; }
    }
    const f = new Facade();
    const proto = Facade.prototype;
    const attested = {
      'TVDesktop/9.9.9-test': {
        addToChart: Function.prototype.toString.call(proto.addToChart),
        _addToChartNewDraft: Function.prototype.toString.call(proto._addToChartNewDraft),
        isDraft: Function.prototype.toString.call(proto.isDraft),
      },
    };
    return { f, proto, attested };
  }

  it('attaches when every callable is the attested prototype member', async () => {
    const { f, attested } = buildFacade();
    const r = await attachViaFacade(evaluatorFor(makeWindow({ facade: f })), attested);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.awaited, true);
    assert.equal(r.invoked, '_addToChartNewDraft');
    assert.equal(f._attached, true, 'the verified draft branch must run');
    assert.notEqual(f._dispatched, true, 'addToChart dispatch must be bypassed — its dynamic re-resolution is the pass-6 hole');
  });

  it('REFUSES a prototype GETTER — the pass-6 bypass (attested for checks, unattested for calls)', async () => {
    class Facade {
      isDraft() { return true; }
      async addToChart() {}
      async _addToChartNewDraft() {}
    }
    const f = new Facade();
    const proto = Facade.prototype;
    const attestedFn = proto._addToChartNewDraft;
    let unattestedRan = false;
    let reads = 0;
    // getter: serves the attested fn to the first reads (the checks), then an
    // unattested one to the invocation.
    Object.defineProperty(proto, '_addToChartNewDraft', {
      configurable: true,
      get() { reads += 1; return reads <= 3 ? attestedFn : async () => { unattestedRan = true; }; },
    });
    const attested = { 'TVDesktop/9.9.9-test': {
      addToChart: Function.prototype.toString.call(proto.addToChart),
      _addToChartNewDraft: Function.prototype.toString.call(attestedFn),
      isDraft: Function.prototype.toString.call(proto.isDraft),
    } };
    try {
      const r = await attachViaFacade(evaluatorFor(makeWindow({ facade: f })), attested);
      assert.equal(r.ok, false);
      assert.match(r.error, /accessor, not a data property/);
      assert.equal(unattestedRan, false, 'the getter-served unattested function must never run');
    } finally {
      Object.defineProperty(proto, '_addToChartNewDraft', { configurable: true, writable: true, value: attestedFn });
    }
  });

  it('REFUSES an own-property shadow — the pass-5 bypass', async () => {
    const { f, attested } = buildFacade();
    let ran = false;
    f.addToChart = async () => { ran = true; };   // shadow with unattested code
    const r = await attachViaFacade(evaluatorFor(makeWindow({ facade: f })), attested);
    assert.equal(r.ok, false);
    assert.match(r.error, /shadowed by an own property/);
    assert.equal(ran, false, 'the shadowed function must never run');
  });

  it('REFUSES a drifted prototype implementation', async () => {
    const { f, proto, attested } = buildFacade();
    let ran = false;
    proto.addToChart = async function addToChart() { ran = true; };  // drift
    const r = await attachViaFacade(evaluatorFor(makeWindow({ facade: f })), attested);
    assert.equal(r.ok, false);
    assert.match(r.error, /does not match the attested/);
    assert.equal(ran, false);
  });

  it('REFUSES an unattested build id', async () => {
    const { f, attested } = buildFacade();
    const r = await attachViaFacade(
      async (expr) => new Function('window', 'navigator', `return (${expr})`)(
        makeWindow({ facade: f }), { userAgent: 'TVDesktop/3.0.0-unreviewed' },
      ),
      attested,
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /not attested/);
  });

  it('REFUSES a non-draft editor before invoking addToChart', async () => {
    class Facade {
      isDraft() { return false; }
      async addToChart() { this._attached = true; }
      async _addToChartNewDraft() {}
    }
    const f = new Facade();
    const attested = { 'TVDesktop/9.9.9-test': {
      addToChart: Function.prototype.toString.call(Facade.prototype.addToChart),
      _addToChartNewDraft: Function.prototype.toString.call(Facade.prototype._addToChartNewDraft),
      isDraft: Function.prototype.toString.call(Facade.prototype.isDraft),
    } };
    const r = await attachViaFacade(evaluatorFor(makeWindow({ facade: f })), attested);
    assert.equal(r.ok, false);
    assert.match(r.error, /does not hold a draft/);
    assert.notEqual(f._attached, true);
  });
});

describe('descriptor-only attestation reads (regression: 2026-08-23 sol-max pass 7)', () => {
  it('never reads f[k] or proto[k] — a getter/Proxy get trap would execute during the check', async () => {
    class Facade {
      isDraft() { return true; }
      async addToChart() {}
      async _addToChartNewDraft() { this._attached = true; }
    }
    const f = new Facade();
    const proto = Facade.prototype;
    // A get on the INSTANCE for any attested name = executing page code mid-check.
    let instanceGetRan = false;
    const spy = new Proxy(f, {
      get(target, prop, recv) {
        if (['addToChart', '_addToChartNewDraft', 'isDraft'].includes(prop)) instanceGetRan = true;
        return Reflect.get(target, prop, recv);
      },
    });
    const attested = { 'TVDesktop/9.9.9-test': {
      addToChart: Function.prototype.toString.call(proto.addToChart),
      _addToChartNewDraft: Function.prototype.toString.call(proto._addToChartNewDraft),
      isDraft: Function.prototype.toString.call(proto.isDraft),
    } };
    const win = { TradingViewApi: { _pineEditorApi: { getDialogFacade: () => spy } } };
    const r = await attachViaFacade(async (expr) => {
      const run = new Function('window', 'navigator', `return (${expr})`);
      return run(win, { userAgent: 'Mozilla/5.0 TVDesktop/9.9.9-test' });
    }, attested);
    assert.equal(r.ok, true, r.error);
    assert.equal(instanceGetRan, false,
      'no property GET may occur on the facade for attested names — descriptors only');
    assert.equal(f._attached, true);
  });
});
