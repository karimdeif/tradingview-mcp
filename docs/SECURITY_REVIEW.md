# Security review — `tradingview-mcp` (pre-integration gate)

**Reviewer:** a15-linux session, asus15
**Date:** 2026-08-18
**Subject:** `github.com/karimdeif/tradingview-mcp` @ `c05b8f5`
**Scope:** static review only. Nothing was executed, no MCP registered, no CDP port opened, no TradingView restart.
**Verdict:** **No exfiltration, no telemetry, no credential theft.** But two premises in the recon brief are wrong, and the "read-only usage" goal is **not achievable as configured**. Proceed only with the mitigations in §6.

---

## 1. Provenance — the fork gives us nothing yet

```
origin/main  : c05b8f5755ed8e64ea242de88ddbf46aa24d56a4
upstream/main: c05b8f5755ed8e64ea242de88ddbf46aa24d56a4
commits origin/main NOT in upstream/main: 0
commits upstream/main NOT in origin/main: 0
```

The fork is a byte-identical mirror of `tradesdontlie/tradingview-mcp`. **Reviewing the fork is reviewing upstream.** Forking gives us change control going forward; it confers no trust today. All code below is third-party.

`upstream` remote added locally for syncing, per brief.

## 2. Dependency surface — clean

- Declared runtime deps: `@modelcontextprotocol/sdk ^1.12.1`, `chrome-remote-interface ^0.33.2`. Brief was correct here.
- 173 transitive packages in `package-lock.json`. All standard (eslint tree, MCP SDK tree, express/hono, zod).
- **Zero packages with `hasInstallScript`.** No postinstall execution risk on `npm ci`.
- CI (`.github/workflows/ci.yml`) is lint + unit tests + `npm audit`. No publish step, no secrets referenced.

## 3. Network behaviour — brief was wrong on two counts

### 3a. CDP binding is correct ✅
`src/connection.js:8-9`
```js
export const CDP_HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
export const CDP_PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222;
```
Defaults to `127.0.0.1` (deliberately, not `localhost` — comment explains the Windows `::1` issue). Env-overridable, but we simply won't set those vars. Every CDP call routes through `CDP_HOST`/`CDP_PORT` — verified across `connection.js:78,111,120`, `core/tab.js:19,44,88,150,229`, `core/health.js:220,390`.

### 3b. ❌ The server DOES make an outbound third-party call
`src/core/health.js:24-27` — `checkForUpdate()` hits `api.github.com/repos/<owner>/<repo>/commits/HEAD` on **every `tv_health_check`** (1-hour cache, `health.js:13`).

Sends only a `User-Agent` and the repo path parsed from `git config remote.origin.url`. No chart data, no credentials, no host info. Wrapped in try/catch, 3s timeout, fails closed to `null`. **Benign, but it is a real outbound call and the brief said there were none.** Disclosure is limited to "this machine polls karim's public repo."

### 3c. ❌ It DOES talk to TradingView servers — as karim, with his cookies
The brief said "does NOT talk to TradingView servers and stores no credentials." Half right: it **stores** no credentials, but it **injects JavaScript into the authenticated page** that calls TradingView APIs with `credentials: 'include'`, i.e. karim's live session cookies:

| Endpoint | Called from | Effect |
|---|---|---|
| `pricealerts.tradingview.com/create_alert` | `core/alerts.js:49` | **Writes** — creates an alert on his account |
| `pricealerts.tradingview.com/delete_alerts` | `core/alerts.js:115` | **Destructive** — deletes alerts |
| `www.tradingview.com/api/v1/symbols_list/custom/<id>/remove/` | `core/watchlist.js:198` | **Writes** — mutates saved watchlists |
| `pine-facade.tradingview.com/pine-facade/{list,get,translate_light}` | `core/pine.js:190,546,567,593` | Reads + saves Pine scripts |
| `symbol-search.tradingview.com/symbol_search/v3/` | `core/chart.js:284` | Read-only lookup |

These persist to his **cloud account**, not just the local app. This is normal for a browser-automation bridge — but it is not "no server contact," and it is not read-only.

## 4. ⛔ Order-capability — the finding that matters

The brief asked for "no order-capable actions via CDP even if tools exist for it." They exist, in two forms.

**`ui_open_panel` has a literal `trading` target.** `src/tools/ui.js:14-15` exposes `panel: z.enum([... 'trading'])`, and `src/core/ui.js:70` maps it to the real button:
```js
'trading': { dataNames: ['trading-button'], ariaLabels: ['Trading Panel'] },
```
It clicks the Trading Panel button on a signed-in TradingView Desktop.

**And the UI toolset is a general-purpose driver for whatever that panel exposes:**
- `ui_evaluate` (`tools/ui.js:88`) → arbitrary JS in page context. `core/ui.js:299-300` passes the expression straight to `evaluate()` with **no sanitization, no allowlist** — the `safeString()` helper at `connection.js:41` is used elsewhere but deliberately not here.
- `ui_click`, `ui_mouse_click` (raw x/y), `ui_keyboard`, `ui_type_text` → full synthetic input.

**Assessment:** there is no dedicated "place order" tool, and nothing in the code is *trying* to trade. But if karim's TradingView has a broker connected, `ui_open_panel{trading} → ui_click/ui_type_text` is a complete, documented order-entry path, and `ui_evaluate` is unbounded. The safety property cannot come from the code; it has to come from not exposing these tools. **Open question for karim: is any broker linked to the TradingView account signed in on asus15?** If yes, treat this as high severity; if no, medium.

**`replay_trade` is a false alarm.** `core/replay.js:112-114` calls `_replayApi.buy()/sell()/closePosition()` — TradingView's bar-replay simulator. Paper only, no broker. Noted because the name reads alarming in a tool list.

## 5. Other write/destructive surfaces

- **No tool gating exists.** `src/server.js:73-86` registers all 14 groups (84 tools) unconditionally. There is no read-only mode, no env flag, no allowlist. This is the core problem for our use case.
- **`tv_update` = remote code execution by design.** `core/update.js:79,86` does `git merge --ff-only origin/main` then `npm ci`. Well guarded (`main` only :41, clean tree only :48, ff-only, no divergence :68) and manually triggered — but whatever lands on the fork's `main` executes here. Note `update.js:31` still hardcodes the **upstream** URL in its error text.
- **`tv_launch` kills the app.** `core/health.js:355`: `pkill -f TradingView` on Linux — a broad pattern match, not PID-scoped.
- **Account-state writers:** `alert_create`, `alert_delete`, `watchlist_add`, `watchlist_add_bulk`, `watchlist_remove`, `pine_new`, `pine_save`, `pine_set_source`, `draw_shape`, `draw_clear`, `draw_remove_one`, `layout_new`, `tv_update`.
- **Even "read" tools mutate visible state.** `tools/data.js:38`: `quote_get` briefly switches the chart symbol and restores it. Karim will see the chart flicker; a crashed call could leave it on the wrong symbol.

## 6. Required mitigations before anything runs

1. **Confirm no broker is linked** to the signed-in TradingView account on asus15 (§4). This gates everything else.
2. **Client-side tool allowlist.** The server won't restrict itself, so restrict at MCP registration. For futures recon the sufficient set is read-only:
   `tv_health_check`, `chart_get_state`, `chart_set_symbol`, `chart_set_timeframe`, `quote_get`, `data_get_ohlcv`, `symbol_info`, `symbol_search`, `capture_screenshot`.
   Explicitly excluded: **all `ui_*`**, all `alert_*`, all `watchlist_*`, all `pine_*`, all `draw_*`, all `replay_*`, `tv_update`, `tv_launch`, `batch_run`.
3. **Verify the port binding after launch** — `ss -ltn | grep 9222` must show `127.0.0.1:9222` and nothing on `0.0.0.0`, `192.168.0.6`, or the Tailscale IP `100.93.111.7`. Port 9222 is full control of a signed-in trading app; on this box it must never face the LAN or the tailnet.
4. **Launch manually, not via `tv_launch`** — avoids `pkill -f TradingView` (§5) and keeps app restart under karim's control.
5. **Never invoke `tv_update`** in this deployment. Pin to a reviewed commit; update deliberately via reviewed PR on the fork.
6. Optionally neuter §3b by removing the `checkForUpdate()` call — a one-line fork change, and a clean first use of change control.

## 7. Current machine state (nothing touched)

- TradingView Desktop **2.14.0** (Electron 38.2.2) running as PID 7043 since 09:06, Wayland, `--user-data-dir=/home/karim/.config/TradingView`.
- **No `--remote-debugging-port` on the running process.** `ss -ltn` shows nothing on 9222. Restart with the flag is still required.
- Listening sockets are unchanged: 3306/33060 (MySQL, loopback), 631 (CUPS, loopback), 53 (resolved), 22 (sshd, all interfaces), and Tailscale-bound 34362/63128.

## 8. Status

§1–§5 complete. **Steps 2–4 of the mission are held pending karim's direct go-ahead** — app restart and MCP registration are his calls, not a peer session's. No futures recon has run; §6 of the eventual deliverable (integration path) is unwritten by design, per candidate-night hands-off.
