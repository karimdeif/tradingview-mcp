/**
 * Scoped strategy-backtest tools (karimdeif fork).
 *
 * WHY THIS FILE EXISTS. `pine_smart_compile` (src/core/pine.js:429) and
 * `pine_compile` (:284) locate the editor's add control with
 * `document.querySelectorAll('button')`. In TradingView Desktop 2.14.0 the
 * "Add to chart" control is a <span>, so both scans miss it, fall through to
 * the Save button, and return `success: true` while the strategy was never
 * attached — and Save PERSISTS TO THE USER'S CLOUD ACCOUNT.
 *
 * WHY NO DOM CLICKING AT ALL. The first version of this file located the
 * control by label and called .click(). Review (gpt-5.6-sol, 2026-08-23)
 * demonstrated live bypasses that label matching cannot defend: a delegated
 * addEventListener on a container, deep nesting past any hop limit,
 * `<label for="save-submit">`, implicit form submission, and composed events
 * through a shadow root. Its conclusion was correct — post-hoc verification
 * cannot undo an account write, so the invariant needs a capability-specific
 * API rather than a click.
 *
 * That API exists: `window.TradingViewApi._pineEditorApi.getDialogFacade()`
 * exposes `addToChart()` as its own method, with `saveScript()` and
 * `saveDraftIfModified()` as SEPARATE methods this file never references.
 * Read from the live build on 2026-08-23, addToChart() is:
 *
 *   async addToChart() {
 *     isDraft   ? await this._addToChartNewDraft()
 *   : isModified? await this._addToChartUnsavedVersion()
 *   :             await this._addToChartSavedLastVersion()
 *   }
 *
 * All three branches attach. The draft branch's saveAction persists a
 * TradingView DRAFT — the identical write a human's "Add to chart" performs on
 * an untitled script; SAVED scripts are never written. There is no click, so
 * bubbling, delegation, default actions and shadow DOM are all irrelevant.
 *
 * `updateOnChart()` is NEVER called: its first branch is
 * `if (!isDraft) return void this.saveScript()` — it is a save path.
 *
 * SECURITY SHAPE. Neither tool accepts a caller-supplied selector, coordinate,
 * index or click target. `expect_name` is a required content assertion checked
 * in Node against the attached study's own name; it never enters page JS.
 * Both tools are double-gated (TV_MCP_ALLOW_SCOPED_WRITERS=1 AND the allowlist
 * naming them) — see scopedWritersActive() in src/allowlist.js.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { evaluate, evaluateAsync, getReplayApi } from '../connection.js';
import { captureScreenshot } from './capture.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Enumerate studies as {id, name, is_strategy}.
 *
 * Ids and names come from getAllStudies(), which in TV Desktop 2.14.0 returns
 * plain {id, name} descriptors — no metaInfo(), no reportData(). The strategy
 * flag therefore CANNOT be read there; it lives on the richer
 * model().model().dataSources() collection, which is what src/core/data.js
 * reads. Verified live 2026-08-23: getAllStudies()[0].metaInfo is not a
 * function, while the matching dataSource carries isTVScriptStrategy:true.
 * Reading the flag off the wrong collection yields a silent false negative.
 */
export const LIST_STUDIES_JS = `
  (function() {
    try {
      var wv = ${CHART_API};
      if (!wv || typeof wv.getAllStudies !== 'function') return null;
      var studies = wv.getAllStudies();

      // Strategy flags + descriptions from the data-source collection, by id.
      var strat = {};
      try {
        var sources = wv._chartWidget.model().model().dataSources();
        for (var i = 0; i < sources.length; i++) {
          var src = sources[i], id = null;
          try { id = typeof src.id === 'function' ? src.id() : src.id; } catch (e) { continue; }
          if (!id) continue;
          var mi = null;
          try { mi = src.metaInfo ? src.metaInfo() : null; } catch (e) {}
          var isStrat = !!(mi && (mi.isTVScriptStrategy || mi.is_strategy)) ||
                        typeof src.reportData === 'function';
          if (isStrat) {
            var pineMeta = (mi && mi.pine) || null;
            strat[id] = {
              is_strategy: true,
              desc: mi ? mi.description : null,
              // True SOURCE identity. A title is not identity: two different
              // Pine files can both declare strategy("Golden Cross Exec").
              // scriptIdPart + pine.digest (a hash of the source) are not
              // forgeable by coincidence.
              script_id: (mi && mi.scriptIdPart) || null,
              pine_digest: pineMeta ? pineMeta.digest : null,
              pine_version: pineMeta ? pineMeta.version : null,
            };
          }
        }
      } catch (e) {}

      return studies.map(function(s) {
        var hit = strat[s.id];
        return {
          id: s.id,
          name: (hit && hit.desc) || s.name || null,
          is_strategy: !!hit,
          script_id: hit ? hit.script_id : null,
          pine_digest: hit ? hit.pine_digest : null,
          pine_version: hit ? hit.pine_version : null,
        };
      });
    } catch (e) { return null; }
  })()
`;

/**
 * Detect a blocking modal (re-login, "account accessed from another device",
 * disconnect) WITHOUT clicking it. Recovery from a terminated session needs a
 * human — TradingView allows one active session per account, so clicking
 * Connect here could fight karim for his own session.
 */
export async function detectBlockingModal() {
  const found = await evaluate(`
    (function() {
      var sels = ['[data-name="dialog"]', '[role="dialog"]', '[class*="dialog-"]'];
      for (var i = 0; i < sels.length; i++) {
        var nodes = document.querySelectorAll(sels[i]);
        for (var j = 0; j < nodes.length; j++) {
          if (nodes[j].offsetParent === null) continue;
          var t = (nodes[j].textContent || '').trim();
          if (!t) continue;
          if (/accessed from another|another browser or device|session (has )?(expired|ended)|sign in|log in|reconnect|disconnected/i.test(t)) {
            return { text: t.slice(0, 300) };
          }
        }
      }
      return null;
    })()
  `);
  return found ? { blocked: true, modal_text: found.text } : { blocked: false };
}


/**
 * Replay guard. TradingView's replay mode truncates the series at the replay
 * point, and the Strategy Tester then computes over the truncated history —
 * producing a complete, plausible, WRONG report with no error anywhere. On
 * 2026-08-23 the live chart was found with the replay toolbar open (a
 * "Re: Mon 12 Jan '26" marker set) while isReplayStarted() was still false;
 * had it been started, every backtest number would have silently covered only
 * part of the range.
 */
export async function checkReplayState() {
  let started;
  try {
    const rp = await getReplayApi();
    started = await evaluate(`(function(){ var v = ${rp}.isReplayStarted(); return (v && typeof v.value === 'function') ? v.value() : v; })()`);
    // Only an explicit boolean false clears the gate. undefined/null during API
    // initialisation or build drift must read as UNKNOWN, never as inactive.
    if (started === false) return { replay_active: false };
    if (typeof started !== 'boolean') {
      return { replay_active: null, replay_check: 'indeterminate', raw: String(started) };
    }
    let date = null;
    try {
      date = await evaluate(`(function(){ var v = ${rp}.currentDate(); return (v && typeof v.value === 'function') ? v.value() : v; })()`);
    } catch { /* started is already known true; a missing date does not soften that */ }
    return { replay_active: true, replay_date: date };
  } catch (err) {
    // FAIL CLOSED. Returning "not active" on an API error is how a truncated
    // backtest gets waved through — the exact silent-wrong-answer shape this
    // gate exists to stop. Unknown is treated as blocking by the caller.
    return { replay_active: null, replay_check: 'failed', error: err.message };
  }
}


/**
 * Open the Pine editor WITHOUT touching the DOM.
 *
 * `ensurePineEditorOpen()` in src/core/pine.js clicks `[aria-label="Pine"]`
 * when Monaco is not already present (pine.js:60,64). Review pass 3 correctly
 * pointed out that importing it put a DOM click back into this module's
 * reachable call graph — the very class of failure the facade rewrite removed.
 * `_pineEditorApi.open()` is the capability-specific equivalent.
 */
async function ensureEditorReady() {
  const ok = await evaluateAsync(`
    (async function() {
      var timeout = new Promise(function(_, rej) { setTimeout(function() { rej(new Error('editor open timed out (15s)')); }, 15000); });
      async function run() {
        var api = window.TradingViewApi && window.TradingViewApi._pineEditorApi;
        if (!api || typeof api.open !== 'function') return { ok: false, error: 'Pine editor API unavailable.' };
        await api.open();
        var f = typeof api.getDialogFacade === 'function' ? api.getDialogFacade() : null;
        if (!f) return { ok: false, error: 'Pine editor facade unavailable after open().' };
        // awaitEditorReady is REQUIRED and awaited; a missing method or a
        // rejection is a failure, not something to swallow — returning ok while
        // initialisation is still pending is a false-success path.
        if (typeof f.awaitEditorReady !== 'function') return { ok: false, error: 'facade.awaitEditorReady is not a function on this build.' };
        await f.awaitEditorReady();
        return { ok: true };
      }
      try { return await Promise.race([run(), timeout]); }
      catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
    })()
  `);
  return ok || { ok: false, error: 'open() returned nothing.' };
}

/**
 * Build attestation. The facade is an opaque implementation: a TradingView
 * update could change addToChart() to save. The reviewed implementations are
 * pinned by sha1 of their String() source; on any drift the tool REFUSES to
 * attach until the new build is re-reviewed and its hashes added here.
 * Recorded from TVDesktop/2.14.0 on 2026-08-23 after reading each function's
 * source: addToChart dispatches to the three _addToChart* branches;
 * _addToChartNewDraft compiles and attaches the editor buffer (its saveAction
 * callback writes only a TV *draft* — the identical write a human triggers by
 * clicking "Add to chart" on an untitled script; saved scripts are untouched).
 */
const ATTESTED_BUILDS = JSON.parse(
  readFileSync(new URL('./attested-tv-builds.json', import.meta.url), 'utf8'),
);

export const sha1 = (text) => createHash('sha1').update(text).digest('hex');

/** sha1 pins derived from the attested sources — used by the Node-side pre-check. */
export const ATTESTED_IMPLEMENTATIONS = Object.fromEntries(
  Object.entries(ATTESTED_BUILDS['TVDesktop/2.14.0'])
    .filter(([k]) => !['reviewed', 'note'].includes(k))
    .map(([k, src]) => [k, sha1(src)]),
);

/**
 * Node-side pre-check (defence in depth; the AUTHORITATIVE check is the atomic
 * one inside attachViaFacade's page code, bound to the exact callables invoked).
 */
async function readFacadeImplementations() {
  return evaluate(`
    (function() {
      try {
        var f = window.TradingViewApi._pineEditorApi.getDialogFacade();
        var p = Object.getPrototypeOf(f);
        var toStr = Function.prototype.toString;
        var out = {};
        // DESCRIPTOR-ONLY reads: p[k] would invoke a prototype getter, running
        // arbitrary code during the check itself (sol-max pass 7).
        ['addToChart', '_addToChartNewDraft', 'isDraft'].forEach(function(k) {
          var own = Object.getOwnPropertyDescriptor(f, k);
          if (own) { out[k] = '__SHADOWED__'; return; }
          var d = Object.getOwnPropertyDescriptor(p, k);
          if (!d || d.get || d.set || typeof d.value !== 'function') { out[k] = null; return; }
          out[k] = toStr.call(d.value);
        });
        return out;
      } catch (e) { return null; }
    })()
  `);
}

export function attestImplementations(impls, attested = ATTESTED_IMPLEMENTATIONS) {
  if (!impls) return { ok: false, error: 'Could not read facade implementations.' };
  for (const [name, expected] of Object.entries(attested)) {
    const src = impls[name];
    if (src === '__SHADOWED__') return { ok: false, error: `facade.${name} is shadowed by an own property — refusing to attach.` };
    if (typeof src !== 'string' || !src) return { ok: false, error: `facade.${name} is missing — build drift, refusing to attach.` };
    const got = sha1(src);
    if (got !== expected) {
      return { ok: false, error: `facade.${name} implementation changed (sha1 ${got} != attested ${expected}). This TradingView build has not been reviewed — refusing to attach until it is.` };
    }
  }
  return { ok: true };
}

/**
 * The attach invocation, isolated so tests can drive it with fake evaluators
 * and their own attested-source maps. Production passes evaluateAsync.
 *
 * ATOMIC ATTESTATION BINDING (sol-max pass 5): hashing prototype methods in one
 * evaluation and invoking `f.addToChart()` in another let an own-property
 * shadow or rebound method run unattested code while the prototype hashes
 * passed. Here, in the SAME evaluation that invokes them:
 *   - the build id is pinned;
 *   - each method must NOT be an own property of the facade;
 *   - the resolved callable must BE the prototype member;
 *   - its source via Function.prototype.toString.call (immune to toString
 *     overrides; throws on a Proxy, which we catch and refuse) must equal the
 *     attested source byte-for-byte;
 *   - the attested draft-branch callable is then invoked as protoFn.call(f) —
 *     never a re-resolved property; no f[k]/p[k] read ever occurs (a getter or
 *     Proxy get trap would execute the very code under vetting).
 *
 * RESIDUAL (accepted, per the pass-5 ruling): a facade OBJECT that is itself a
 * Proxy can run trap code on getOwnPropertyDescriptor/getPrototypeOf. That is
 * page-compromise — an adversary already executing inside TradingView's page —
 * which attestation does not claim to defeat; it targets build drift.
 *
 * REQUIRES the editor to hold a DRAFT: only _addToChartNewDraft is reviewed for
 * the buffer flow. Its saveAction persists a TradingView DRAFT — the identical
 * write a human's "Add to chart" performs on an untitled script. It never
 * writes saved scripts; a modified saved script would route through
 * _addToChartUnsavedVersion, whose semantics we have not accepted.
 */
export async function attachViaFacade(evalAsync, attestedBuilds = ATTESTED_BUILDS) {
  let attached;
  try {
    attached = await evalAsync(`
      (async function() {
        try {
          var ATTESTED = ${JSON.stringify(attestedBuilds)};
          var buildKeys = Object.keys(ATTESTED);
          var build = null;
          for (var bi = 0; bi < buildKeys.length; bi++) {
            if (navigator.userAgent.indexOf(buildKeys[bi]) !== -1) { build = buildKeys[bi]; break; }
          }
          if (!build) return { ok: false, error: 'This TradingView build is not attested (' + navigator.userAgent.slice(0, 120) + ') — refusing to attach until it is reviewed.' };
          var expected = ATTESTED[build];

          var api = window.TradingViewApi && window.TradingViewApi._pineEditorApi;
          if (!api || typeof api.getDialogFacade !== 'function') return { ok: false, error: 'Pine editor API unavailable.' };
          var f = api.getDialogFacade();
          if (!f) return { ok: false, error: 'Pine editor facade unavailable — is the editor open?' };
          var proto = Object.getPrototypeOf(f);
          var toStr = Function.prototype.toString;

          var names = ['addToChart', '_addToChartNewDraft', 'isDraft'];
          var verified = {};
          for (var i = 0; i < names.length; i++) {
            var k = names[i];
            // DESCRIPTOR-ONLY: reading f[k] or p[k] invokes getters/Proxy get
            // traps — executing exactly the code we are trying to vet (sol-max
            // passes 6 and 7, both proven executable). Own-property presence is
            // itself grounds for refusal, whatever it holds.
            var ownDesc = Object.getOwnPropertyDescriptor(f, k);
            if (ownDesc) {
              return { ok: false, error: 'facade.' + k + ' is shadowed by an own property — unattested code would run; refusing.' };
            }
            var desc = Object.getOwnPropertyDescriptor(proto, k);
            if (!desc || desc.get || desc.set || !('value' in desc)) {
              return { ok: false, error: 'facade.' + k + ' is an accessor, not a data property — refusing.' };
            }
            var fn = desc.value;
            if (typeof fn !== 'function') return { ok: false, error: 'facade.' + k + ' is not a function on this build.' };
            var src;
            try { src = toStr.call(fn); } catch (e) { return { ok: false, error: 'facade.' + k + ' source is unreadable (proxy?) — refusing.' }; }
            if (src !== expected[k]) return { ok: false, error: 'facade.' + k + ' does not match the attested ' + build + ' implementation — refusing until re-reviewed.' };
            verified[k] = fn;
          }

          var draft = verified.isDraft.call(f);
          if (draft !== true) return { ok: false, error: 'Editor does not hold a draft (isDraft=' + String(draft) + '). Only the draft attach branch is reviewed; open a new script and set the source again.' };
          // Invoke the DRAFT BRANCH callable directly — the attested one we
          // hold, never a re-resolved property. addToChart's own dispatch
          // re-resolves this._addToChartNewDraft() dynamically, which a
          // prototype getter could redirect to unattested code even after
          // every check above (sol-max pass 6). With draft === true just
          // verified, addToChart's only reviewed behaviour IS this call.
          await verified._addToChartNewDraft.call(f);
          return { ok: true, awaited: true, was_draft: true, attested_build: build, invoked: '_addToChartNewDraft' };
        } catch (e) { return { ok: false, error: (e && e.message) ? e.message : String(e) }; }
      })()
    `);
  } catch (err) {
    return { ok: false, error: `attach evaluation failed: ${err.message}` };
  }
  if (!attached || typeof attached !== 'object') return { ok: false, error: 'attach evaluation returned nothing.' };
  return attached;
}


/**
 * Put SOURCE into a fresh DRAFT via the facade's own setNewScript() —
 * openNewScript() + setScript() — with the buffer read back and sha1-verified.
 * Replaces pine_set_source for the backtest flow: that tool's
 * ensurePineEditorOpen() clicks [aria-label="Pine"] when Monaco is closed,
 * which reintroduces the DOM-click class this module exists to avoid
 * (sol-max pass 7). Guarantees isDraft for the subsequent attach as a bonus.
 */
export async function setDraftSource({ source }) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('source is required.');
  const editorReady = await ensureEditorReady();
  if (!editorReady.ok) return { success: false, error: editorReady.error };

  const res = await evaluateAsync(`
    (async function() {
      try {
        var api = window.TradingViewApi._pineEditorApi;
        var f = api.getDialogFacade();
        if (!f || typeof f.setNewScript !== 'function' || typeof f.getSource !== 'function') {
          return { ok: false, error: 'facade.setNewScript/getSource unavailable on this build.' };
        }
        await f.setNewScript(${JSON.stringify(source)});
        var back = await f.getSource();
        return { ok: true, readback: typeof back === 'string' ? back : null };
      } catch (e) { return { ok: false, error: (e && e.message) ? e.message : String(e) }; }
    })()
  `);
  if (!res || !res.ok) return { success: false, error: res?.error || 'setNewScript failed.' };
  const want = sha1(source);
  const got = res.readback === null ? null : sha1(res.readback);
  if (got !== want) {
    return { success: false, error: `editor readback digest ${got} does not match injected source ${want} — buffer not set.` };
  }
  return { success: true, lines_set: source.split('\n').length, digest: want };
}

/**
 * Attach the Pine script currently in the editor buffer to the chart.
 *
 * Verification is independent of the click: study-count delta plus a read-back
 * of the attached study's own name and strategy flag. The button lookup bug
 * this replaces cannot reach that check — a Save click adds no study, so the
 * delta stays 0 and this returns success:false.
 *
 * @param {string} [expect_name] assertion only; narrows what counts as success.
 */
export async function addToChart({ expect_name } = {}) {
  const guard = await detectBlockingModal();
  if (guard.blocked) {
    return { success: false, error: 'Blocking modal present — not clicking through it.', ...guard };
  }

  const replay = await checkReplayState();
  if (replay.replay_active !== false) {
    return {
      success: false,
      error: replay.replay_active === null
        ? 'Could not determine replay state — refusing to attach. An undetected replay would make the Strategy Tester compute over TRUNCATED history and report a plausible wrong result.'
        : 'Replay mode is active — the Strategy Tester would compute over TRUNCATED history and report a plausible wrong result. Stop replay before backtesting.',
      ...replay,
    };
  }

  const editorReady = await ensureEditorReady();
  if (!editorReady.ok) return { success: false, error: editorReady.error, method: 'pine_editor_facade' };

  const shotBefore = await captureScreenshot({ region: 'full', filename: `add_before_${Date.now()}` })
    .catch((e) => ({ error: e.message }));

  const before = await evaluate(LIST_STUDIES_JS);
  if (before === null) throw new Error('Chart API unavailable — cannot verify attachment, refusing to attach.');

  // Build attestation BEFORE anything is invoked: refuse on any drift.
  const attest = attestImplementations(await readFacadeImplementations());
  if (!attest.ok) return { success: false, error: attest.error, method: 'pine_editor_facade' };

  // Expected identity, read BEFORE the attach so it cannot be influenced by
  // whatever lands on the chart: the editor's script id/version AND the sha1
  // of the editor buffer itself. The chart study's metaInfo.pine.digest is the
  // sha1 of its source (verified: sha1 of the pilot .pine file equals the
  // chart digest byte-for-byte), so this proves SOURCE identity end to end.
  // ALL fields are required up front — attaching with unverifiable identity
  // is refused, not warned about.
  const expectedScript = await evaluateAsync(`
    (async function() {
      try {
        var f = window.TradingViewApi._pineEditorApi.getDialogFacade();
        var v = f.getScriptIdVersion();
        var src = await f.getSource();
        return {
          script_id: (v && v.scriptIdPart) || null,
          version: (v && v.version) || null,
          source: typeof src === 'string' ? src : null,
        };
      } catch (e) { return { error: (e && e.message) ? e.message : String(e) }; }
    })()
  `);
  // A FRESH draft (setNewScript) has no scriptIdPart/version until the attach
  // itself persists it — so id/version are corroboration WHEN PRESENT, and the
  // SOURCE DIGEST is the unconditional binder: sha1 of the buffer we read here
  // must equal the attached study's metaInfo.pine.digest. Refusing on a
  // missing id would refuse every fresh draft; refusing on a missing SOURCE is
  // mandatory — without it there is no identity at all.
  if (!expectedScript || expectedScript.error || !expectedScript.source) {
    return {
      success: false,
      error: `Could not read the editor buffer before attaching (${expectedScript?.error || 'missing source'}) — refusing to attach.`,
      method: 'pine_editor_facade',
    };
  }
  expectedScript.digest = sha1(expectedScript.source);
  delete expectedScript.source;

  const attached = await attachViaFacade(evaluateAsync);

  if (!attached || !attached.ok) {
    return {
      success: false,
      error: attached?.error || 'addToChart() call failed.',
      method: 'pine_editor_facade',
      screenshot_before: shotBefore?.file_path || null,
    };
  }

  // Poll until the chart shows EXACTLY the before-set plus one new study, and
  // require the FULL identity signature (id + script id + digest + version +
  // name of every study) to be seen twice. Signing ids alone accepted a
  // replacement (old id swapped for new id, count unchanged) as an addition.
  let after = null;
  let stable = false;
  let lastSig = null;
  let readFailures = 0;
  for (let i = 0; i < 20; i++) {
    await delay(500);
    const now = await evaluate(LIST_STUDIES_JS);
    if (!now) { readFailures++; lastSig = null; continue; }
    const accept = pollAccepts({ before, now });
    const sig = identitySignature(now);
    if (accept && sig === lastSig) { after = now; stable = true; break; }
    lastSig = sig;
  }

  const shotAfter = await captureScreenshot({ region: 'full', filename: `add_after_${Date.now()}` })
    .catch((e) => ({ error: e.message }));

  const { problems, target } = verifyAttachment({
    before, after, attached, expect_name, readFailures, stable, expectedScript,
  });

  const post = await detectBlockingModal();
  if (post.blocked) problems.push(`Blocking modal appeared after the click: ${post.modal_text}`);

  return {
    success: problems.length === 0 && !!target,
    method: 'pine_editor_facade',
    was_draft: attached.was_draft,
    script_id: target?.script_id ?? null,
    pine_digest: target?.pine_digest ?? null,
    entity_id: target?.id || null,
    study_name: target?.name || null,
    is_strategy: target?.is_strategy ?? null,
    studies_before: before.length,
    studies_after: after === null ? null : after.length,
    ...(expect_name === undefined && { name_unverified: true }),
    screenshot_before: shotBefore?.file_path || null,
    screenshot_after: shotAfter?.file_path || null,
    ...(problems.length && { problems }),
  };
}


/** Full identity signature of a study list — ids alone cannot see a swap. */
export const identitySignature = (list) => (list || [])
  .map((x) => [x.id, x.script_id, x.pine_digest, x.pine_version, x.name].join('|'))
  .sort()
  .join(',');

/**
 * Acceptance predicate for the post-attach poll: exactly one MORE study than
 * before, and every prior id still present. A swap (one removed, one added)
 * keeps the count and must be rejected — it is not the attach we performed.
 */
export function pollAccepts({ before, now }) {
  if (!Array.isArray(before) || !Array.isArray(now)) return false;
  if (now.length !== before.length + 1) return false;
  const nowIds = new Set(now.map((x) => x.id));
  return before.every((x) => nowIds.has(x.id));
}

/**
 * Pure verification of an attachment attempt — extracted so the adversarial
 * cases are unit-testable without a browser. The 2026-08-23 sol-max review
 * found three defects here (update-path accepting an unrelated pre-existing
 * strategy, a name check that any string satisfies, and a poll that exits on a
 * REMOVAL); all three were invisible because this logic could not be tested.
 */
export function verifyAttachment({ before, after, attached, expect_name, readFailures = 0, stable = false, expectedScript = null }) {
  const problems = [];

  // Causality: the attach call must have reported success. Without this, an
  // unrelated study appearing from any source could certify the run.
  if (!attached || attached.ok !== true) problems.push('The attach call did not report success — attachment unverified.');
  else if (attached.awaited !== true) problems.push('The attach call was not awaited — success would only mean a Promise was created.');

  if (after === null || after === undefined) {
    problems.push('Could not read the study list after attaching — attachment unverified.');
  }
  // Stability is REQUIRED, not advisory: a single transient read must never
  // certify. Without this the final loop snapshot was accepted even if the
  // id-set never settled.
  if (!stable) problems.push('Study list never reached a stable state — attachment unverified.');
  if (readFailures) problems.push(`${readFailures} study-list read(s) failed during verification.`);

  const beforeIds = new Set((before || []).map((x) => x.id));
  const added = (after || []).filter((x) => !beforeIds.has(x.id));

  if (added.length === 0) problems.push('No new study appeared on the chart.');
  else if (added.length > 1) {
    problems.push(`Expected exactly 1 new study, got ${added.length}: ${added.map((x) => x.name).join(', ')}.`);
  }

  const candidate = added.length === 1 ? added[0] : undefined;
  let target;

  if (candidate) {
    // A descriptor with no usable id is not evidence of anything.
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!id) problems.push('Attached study has no usable entity id — attachment unverified.');

    if (!candidate.is_strategy) problems.push(`Attached study "${candidate.name}" is not a strategy — no report will compute.`);

    const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    const got = norm(candidate.name);
    if (!got) problems.push('Attached study has no readable name — identity unverified.');

    // expect_name is REQUIRED and matched EXACTLY. Prefix matching accepted
    // "Golden Cross Exec — old variant" for "Golden Cross Exec"; optionality
    // meant any new strategy passed when the caller omitted it.
    const want = norm(expect_name);
    if (!want) {
      problems.push('expect_name is required — an unnamed expectation cannot identify a strategy.');
    } else if (want.length < 4) {
      problems.push(`expect_name "${expect_name}" is too short to identify a strategy (need 4+ characters).`);
    } else if (got !== want) {
      problems.push(`Attached study name "${candidate.name}" does not match expected "${expect_name}" (exact match required).`);
    }

    // SOURCE identity, not just title. The DIGEST is the unconditional binder
    // (sha1(source) cannot collide by accident); it is required on BOTH sides,
    // and a missing value is a failure, never a skipped check. script id and
    // version are corroboration: a fresh draft has neither until the attach
    // persists it, so they are compared exactly WHEN the editor had them, and
    // the attached study must expose a script id either way.
    if (!expectedScript || !expectedScript.digest) {
      problems.push('The editor buffer digest was not established before attaching — source identity unverifiable.');
    } else {
      if (!candidate.pine_digest) problems.push('Attached study exposes no source digest — source identity unverifiable.');
      else if (candidate.pine_digest !== expectedScript.digest) {
        problems.push(`Attached study source digest ${candidate.pine_digest} does not match the editor buffer's sha1 ${expectedScript.digest} — a DIFFERENT source is on the chart.`);
      }
      if (!candidate.script_id) problems.push('Attached study exposes no script id — source identity unverifiable.');
      else if (expectedScript.script_id && candidate.script_id !== expectedScript.script_id) {
        problems.push(`Attached study came from script ${candidate.script_id}, but the editor held ${expectedScript.script_id}.`);
      }
      if (expectedScript.version && candidate.pine_version && candidate.pine_version !== expectedScript.version) {
        problems.push(`Attached study is script version ${candidate.pine_version}, but the editor held ${expectedScript.version}.`);
      }
    }

  }

  // A target is returned ONLY when nothing at all is wrong. Any recorded
  // problem — a failed attach call, an unstable read, a name mismatch —
  // must leave target undefined so success cannot be claimed.
  if (candidate && problems.length === 0) {
    target = candidate;
  }

  return { problems, target, added };
}

/**
 * Remove every study from the chart. No arguments — there is nothing for a
 * caller to aim it at. Needed because findStrategy() (src/core/data.js:50)
 * picks *a* strategy with a computed report; a leftover from a prior run makes
 * data_get_strategy_results return the wrong strategy's numbers with
 * success:true.
 */
export async function clearStudies() {
  const before = await evaluate(LIST_STUDIES_JS);
  if (before === null) throw new Error('Chart API unavailable — cannot enumerate studies.');
  if (before.length === 0) return { success: true, removed_count: 0, removed: [], studies_after: 0 };

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var ids = chart.getAllStudies().map(function(s){ return s.id; });
      for (var i = 0; i < ids.length; i++) {
        try { chart.removeEntity(ids[i]); } catch(e) {}
      }
      return true;
    })()
  `);

  await delay(800);
  const after = await evaluate(LIST_STUDIES_JS);
  const remaining = after === null ? null : after.length;

  return {
    success: remaining === 0,
    removed_count: before.length - (remaining ?? before.length),
    removed: before.map((s) => s.name),
    studies_after: remaining,
    ...(remaining ? { error: `${remaining} study/studies could not be removed.` } : {}),
  };
}
