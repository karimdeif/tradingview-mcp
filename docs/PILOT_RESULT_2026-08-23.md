# Phase 2 pilot — Golden Cross on EGX:COMI, daily

Run 2026-08-23 on asus15 against the live TradingView Desktop 2.14.0 session.
Everything below was read back off the chart or the Strategy Tester panel, and
the panel was screenshotted and inspected.

## Verdict

**The Strategy Tester path works.** The 2026-08-22 blocker is fixed and proven
live: `pine_add_to_chart` returned `control_tag: "span"` — the control that
`querySelectorAll('button')` could never see. The Pine console line reads
`Added to chart.` and the study count went 0 → 1 with the expected name.

Karim's SAVED scripts were never written — `listSavedScripts()` pinned at 12
across every run. Attaching an untitled draft does persist a TradingView
*draft* (the identical write a manual "Add to chart" performs); that is the
precise claim, everywhere in this document.

## Result — Golden Cross Exec (SMA50/200), EGX:COMI, 1D

Coverage window, read off the panel: **May 15, 2001 — Aug 23, 2026.** The
Strategy Tester computed over the full server-side history, not the ~300 chart
bars, confirming the note in [[tradingview-mcp-gotchas]].

| metric | value |
|---|---|
| Total PnL | +599.58 EGP (**+0.60%**) |
| Max drawdown | 1,058.66 EGP (**1.06%**) |
| Trades | **12** (6 win / 6 loss, **50.0%**) |
| Profit factor | 1.215 |
| Sharpe / Sortino | −1.448 / −0.869 |
| Commission paid | 240.84 EGP |
| Buy & hold | 16,826,798.98 EGP (**≈16,827%**) |
| Initial capital | 100,000 EGP |

## G4 cross-engine check vs `pine-audit/backtest.mjs`

| | TradingView Strategy Tester | JS re-implementation | agreement |
|---|---|---|---|
| Buy & hold | ≈16,827% | 16,607.3% | **within 1.3%** |
| Trades | 12 | 10 | diverges |
| Net | +0.60% | +2.2% | diverges |
| Max DD | 1.06% | 0.6% | diverges |
| Win rate | 50% | 60% | diverges |

Buy & hold agreeing to ~1% is strong evidence both engines see substantially the
same price history, which isolates the divergence to **execution**, not data
span: fill timing (`process_orders_on_close=false` → next-bar fills), and
QuestDB's `daily_ohlcv` holding raw unadjusted prices where TradingView's EGX
feed is back-adjusted. Two extra trades out of ten is consistent with a
cross firing on slightly different adjusted values.

Neither number is "the" answer. That is the point of G4 — the divergence is the
finding, and it is reported rather than averaged away.

## Unit trap (verified by arithmetic and against the UI)

`data_get_strategy_results` returns **fractions, not percentages**:

- `net_profit_percent: 0.0059957972` → UI shows **+0.60%** (599.58 / 100,000 ✓)
- `max_drawdown_percent: 0.010586` → UI shows **1.06%**
- `percent_profitable: 0.5` → UI shows **50.00%**
- `buy_hold_return: 16826798.98` is **absolute currency**, not a percent —
  divide by initial capital.

A report that prints these raw understates every return by 100×. The harness
must multiply by 100 and must not treat `buy_hold_return` like the others.

## Two code-level findings, both fixed

**1. The add control is a `<span>`** (the known blocker). `pine_smart_compile`
and `pine_compile` still scan `button` only (`src/core/pine.js:290`, `:452`) and
fall through to Save. `pine_add_to_chart` scans all elements, takes the
innermost visible exact-label match, and refuses the Save fallback outright.

**2. NEW — the strategy flag lives on a different collection.**
`chart.getAllStudies()` returns plain `{id, name}` descriptors in this build:
`metaInfo` is not a function on them, so `isTVScriptStrategy` reads `undefined`.
The flag lives on `model().model().dataSources()`, which is what
`src/core/data.js` uses. My first pass read it off `getAllStudies()` and a
correctly-attached strategy reported `is_strategy: false`. Fixed, with a
regression test.

This one is worth stating plainly: the tool's verification was itself wrong in
the *safe* direction — it refused to claim success. Had the check been written
the other way round it would have passed a broken attach.

## Replay very nearly poisoned the run

Preflight found the replay toolbar open with a point set. `isReplayStarted()`
was false, so it looked idle — **but switching the symbol to EGX:COMI activated
it**, with `replay_date: 989884800` (2001-05-15). The quote then refused to
load, which is the only reason it surfaced.

Had replay started silently on a later symbol, the Strategy Tester would have
computed over truncated history and returned a complete, plausible, wrong
report. `checkReplayState()` is now a hard gate in `addToChart`, and the harness
must re-check it **after every symbol switch**, not once at startup.

## Still open

- **Coverage window per run is not yet machine-readable.** `data_get_trades`
  returns `time_index` (bar index) and no timestamps; the window shown above was
  read off the panel. Phase 3 needs either a bar-index → date mapping or a panel
  read to fill the mandatory coverage column.
- `data_get_trades` returns **orders**, not round-trip trades: 20 rows (its cap)
  against 12 trades. Do not derive trade counts from its length.
- Codex review has not run — see below.

## Review status: five sol-max passes; architecture changed as a result

`codex exec --model gpt-5.6-sol -c model_reasoning_effort=max`, run on a15.

**Pass 1** — BLOCK, 6 High + 1 Medium. Fixed: the double gate was single (an
unset allowlist resolves to `null`, which permits everything, so
`TV_MCP_ALLOW_SCOPED_WRITERS=1` alone registered the tools); the update path
could certify a pre-existing strategy; name matching was near-vacuous; polling
exited on a study being REMOVED; the test file was in no npm script.

**Pass 2** — BLOCK again, and it was right about something structural:

> Post-verification cannot undo an account write. This invariant requires a
> capability-specific internal attach API or equally strong control identity;
> unrestricted label-based DOM `.click()` cannot prove it.

It demonstrated live bypasses that label matching cannot defend — a delegated
`addEventListener` on a container, nesting deeper than any hop limit,
`<label for="save-submit">`, implicit form submission, and composed events
through a shadow root. Patching the scanner further was whack-a-mole.

### The fix: stop clicking

`window.TradingViewApi._pineEditorApi.getDialogFacade()` exposes `addToChart()`
as its own method. Read off the live build:

```js
async addToChart() {
  isDraft    ? await this._addToChartNewDraft()
: isModified ? await this._addToChartUnsavedVersion()
:              await this._addToChartSavedLastVersion()
}
```

All three branches attach. (Pass-4 correction, applied throughout: the draft
branch persists a TradingView *draft* — the same write a manual "Add to chart"
performs on an untitled script — and never writes saved scripts.) `saveScript()`
and `saveDraftIfModified()` are separate methods this module never references.
There is no click, so bubbling, delegation, default actions and shadow DOM
stop being relevant at all.

**And it found a live hazard in the old design.** `updateOnChart()` begins:

```js
async updateOnChart() {
  if (!isDraft) return void this.saveScript();   // ← a save path
```

"Update on chart" — a control the DOM version was willing to click — **saves to
the cloud account** when the script is not a draft. It is now never called.

### Verified live after the rewrite

`method: "pine_editor_facade"`, `was_draft: true` (the no-save branch),
studies 0 → 1, exact name match, `is_strategy: true` — and the metrics came back
**byte-identical** to the DOM-click run (+0.60%, 12 trades, PF 1.215, max DD
1.06%), which is a useful cross-check that the new attach path changes nothing
about the result.

**Nothing was written to the account, checked rather than asserted:**
`listSavedScripts()` returns **12** scripts, exactly matching
`pine-audit/inventory.json`. The editor's `scriptIdPart`
(`USER;645f172f…`, version 0.9) is a local draft and appears nowhere in that
saved list.

### Other pass-2 findings, all closed

- `verifyAttachment()` now requires the attach call to have reported success,
  a **stable** double read (previously advisory), a usable entity id, exactly
  one new study, `is_strategy`, and an **exact** normalised name match.
  `expect_name` is now **required** (`z.string().min(4)`) — prefix matching had
  accepted `"Golden Cross Exec — old variant"` for `"Golden Cross Exec"`, and
  optionality let any new strategy pass. A target is returned only when
  `problems` is empty.
- `checkResultIntegrity()` was exported but had no production caller, which is
  not a gate. **Removed from this branch**; it lands with the phase-3 harness
  that actually calls it. Shipping an unwired gate reads as protection and is
  not.

**Tests: 28 in this suite, all passing**, including source-level assertions that
this module never calls `.click()`, never names any save capability, and never
calls `updateOnChart`.

### Pass 3 — BLOCK again, and it found a bug in my own fix

**The attach was never awaited.** `facade.addToChart()` is `async`, but it was
called without `await` inside a synchronous page-context wrapper that then
returned `{ok: true}` — and `evaluate()` defaults to `awaitPromise: false`. So
`attached.ok === true` meant only *"a Promise was created"*, and a rejection
became an unhandled rejection rather than a failure. That is a false-success
path introduced by the fix for a false-success path. Now uses `evaluateAsync`
(`awaitPromise: true`) with `await f.addToChart()` inside a real try/catch, and
verification additionally requires an `awaited: true` flag.

**A title is not an identity.** Two different Pine files can both declare
`strategy("Golden Cross Exec")`, so exact name matching could accept the wrong
source. The chart exposes real identity — read live from the attached study:

```
scriptIdPart: "USER;645f172f6ab844b2845c4abd7297e936"
pine:         { digest: "7eed590e3a06e5b6a6e368ad1ce06cdd2f17a0cc", version: "0.9" }
```

`scriptIdPart` matches the editor's `getScriptIdVersion()` captured **before**
the attach, and `pine.digest` is a hash of the source. Verification now requires
the script id and version to match; the digest is reported. Two files sharing a
title cannot share a digest.

**A DOM click was still reachable.** `addToChart()` imported
`ensurePineEditorOpen()` from `src/core/pine.js`, which clicks
`[aria-label="Pine"]` when Monaco is absent — putting the whole clicking problem
back in the call graph by the side door. Replaced with
`_pineEditorApi.open()`; `backtest.js` no longer imports from `pine.js` at all,
and a test asserts it.

**Replay was not fully fail-closed.** `if (!started)` treated `undefined`/`null`
as inactive. Now only an explicit `false` clears the gate; any non-boolean reads
as unknown and blocks.

Also fixed: the "too short expectation" test used `"Gold"` — already four
characters — so it never exercised the bound it claimed to test.

Closed at pass 3: polling stability, `checkResultIntegrity` removal, the double
gate, and npm test wiring.

### Verified live after all three passes

`script_id: USER;645f172f…`, `pine_digest: 7eed590e…`, `was_draft: true`,
studies 0 → 1, exact name match. Metrics came back **identical for the third
time across three different attach implementations** (+0.60%, 12 trades,
PF 1.215, max DD 1.06%).

`listSavedScripts()` still returns **12** — unchanged across every attach run.

**Tests: 37, all passing.**

### Pass 4 — BLOCK; the remaining gaps were about proof, not plumbing

1. **Build drift (High).** The facade is opaque; a TradingView update could make
   `addToChart()` save. Fixes: (a) **draft-only gate** — the page code refuses
   unless `isDraft() === true`, so only `_addToChartNewDraft` (whose source was
   read and reviewed) is ever exercised; (b) **build attestation** — the sha1 of
   `String(addToChart)`, `String(_addToChartNewDraft)` and `String(isDraft)` is
   pinned from TVDesktop/2.14.0; any drift refuses to attach until the new
   build is re-reviewed. Honesty note that came out of reading
   `_addToChartNewDraft`: its `saveAction` writes a TV **draft** — the identical
   write a human triggers clicking "Add to chart" on an untitled script. Saved
   scripts are never touched (list pinned at 12 across every run). The claim is
   now "never writes saved scripts", not "zero cloud bytes".
2. **Digest collected but never compared (High).** And version was checked only
   when both values were truthy — a reused Untitled draft id/version with stale
   source passed. Fixes: the editor identity (id + version + **sha1 of the
   buffer read via `facade.getSource()`**) is established BEFORE attaching and
   is refused if incomplete; verification requires all three to match the
   study's `metaInfo` exactly, missing values failing rather than skipping.
   Verified end to end: `metaInfo.pine.digest` equals `sha1` of the .pine file
   byte-for-byte.
3. **`awaitEditorReady()` un-awaited, errors swallowed (Medium).** Now required,
   awaited, error-propagating, with a 15s timeout.
4. **Polling accepted a swap (Medium).** It signed ids only, so old-id-replaced-
   by-new-id (count unchanged) read as an addition. Now: exactly
   `before + 1` studies, every prior id preserved, and stability over the FULL
   identity tuple (id, script id, digest, version, name) seen twice.
5. **Tests were source-text assertions (Medium).** The attach invocation is now
   an injectable `attachViaFacade(evalAsync)` tested with rejecting/empty/failing
   evaluators plus an ordering assertion that the draft gate precedes the attach
   call; attestation and poll-acceptance are pure functions with their own
   adversarial cases, including same-id/version-wrong-digest.

**Tests: 55, all passing.** Live pilot re-run through every new gate: identical
metrics for the fourth consecutive time; digest correlation held.

### Pass 5 — the residual-risk line was drawn

Verdict BLOCK on one High + one Medium; everything else CLOSED, with the
reviewer independently recomputing the pilot digest and marking transitive
build-drift as **accepted residual risk** once the High was fixed.

1. **High — attestation was not bound to the invoked callables.** Hashing the
   *prototype* methods in one evaluation and invoking `f.addToChart()` in
   another meant an own-property shadow or rebound method could run unattested
   code while the prototype hashes passed. Fixed atomically inside the single
   evaluation that attaches: the build id must be attested
   (`src/core/attested-tv-builds.json`, pinned from TVDesktop/2.14.0); each
   method must NOT be an own property; the resolved callable must BE the
   prototype member; its source via `Function.prototype.toString.call`
   (throws on a Proxy — caught, refused) must equal the attested source
   byte-for-byte; and isDraft/addToChart are then invoked as the exact
   `verified.*.call(f)` callables just checked. The binding tests EXECUTE the
   real page expression against fake facades — shadowed, drifted, wrong-build
   and non-draft all refuse, with the unattested function proven never to run.
2. **Medium — wording.** "No save path"/"none saves" residues replaced
   everywhere with the precise claim: the draft attach persists a TradingView
   *draft* (identical to a manual "Add to chart" on an untitled script) and
   never writes saved scripts.

**Accepted residual risk (reviewer's words):** unchanged reviewed wrappers with
changed transitive helpers (`_compileAndAddToChart`, `saveNewDraft`, closure
state). Judged proportionate for a double-opt-in tool on the user's own
account. Their recommendation — after any TradingView upgrade, compare the full
saved-script id+version inventory, not merely the count — is adopted as a
phase-3 harness invariant.

**Tests: 60, all passing.** Fifth consecutive live pilot run: identical metrics
through the full gate stack (attestation → draft gate → identity digest).

### One unrelated failing test, pre-existing

`tests/write_window.test.js` → "drain dry-run is non-destructive (regression)"
fails, and **not because of this branch** — `git diff main...feat/backtest-preset`
touches neither that test nor `scripts/council_drain.mjs`.

It is time-dependent: it runs `council_drain.mjs --dry-run`, which correctly
refuses during the 14:30–18:30 Cairo QuestDB write blackout and exits non-zero;
`execFileSync` then throws. **That test fails every day inside that window.**
Worth fixing separately — a dry run writes nothing, so arguably it should not be
gated by a *write* window at all.
