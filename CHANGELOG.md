# Changelog

## 0.4.9

Internal restructure only — no behavior change.

- Split the 1.6k-line `index.ts` into focused modules: `adapters.ts`, `refresh.ts`,
  `aliases.ts`, `accounts-menu.ts`, `subscription-import.ts`, `session-state.ts`,
  `names.ts`, `errors.ts`. `index.ts` is now wiring only (~200 lines), and
  `registerBillingLayer()` moved next to the billing code it configures.
- Remove duplicated logic and dead code: the alias-specific `refreshCredential()`
  duplicated `refreshStoredCredential()` (now one `refreshAccountCredential()`
  used by the sweep, the alias auth path, and the runtime sync), the unused
  `anthropicProvider` local is gone, provider adapters are built once per process
  instead of per session, and `sanitizeRefreshError()` no longer re-wraps an
  already sanitized error.
- The refresh-failure map is private to `refresh.ts` behind
  `accountsNeedingRelogin()`, and the in-flight run counter behind
  `markRunStarted()` / `markRunFinished()`.
- Checked with `tsc --noEmit --noUnusedLocals --noUnusedParameters`.

## 0.4.8

Aliases are now first-class, and account naming is user-owned.

- **Keep `anthropic-<account>` selected.** 0.4.3 – 0.4.7 treated the alias as a shortcut and immediately normalized the session back to `anthropic/<model>`, so `/model` and the footer lost track of which account was in use. The alias now stays selected for the whole session; `/model`, `--model`, model cycling, and a persisted `defaultProvider` alias all keep the account visible, e.g. `(anthropic-work) claude-opus-5`.
- **Fix subscription billing for alias requests.** Aliases used to resolve to a pre-built `Authorization: Bearer` header, leaving the request api key empty. pi's Anthropic adapter decides between Claude Code / OAuth mode and plain API-key mode by *inspecting the key* (`sk-ant-oat...`), so the header-only form silently took the API-key path: no Claude Code identity block, no `claude-code-20250219` / `oauth-2025-04-20` betas, no Claude Code tool names, and therefore no billing-header injection — alias traffic was billed as pay-as-you-go extra usage. Aliases now hand pi the raw access token, so they behave exactly like native `anthropic/...`.
- **Ask for the account alias on first-run import** instead of inventing `cc-max` / `cc-pro`. Interactive sessions confirm the detected Claude Code accounts and prompt for one name each (blank keeps the generated name); non-TTY runs are unchanged, and `PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES=work,personal` names them without any prompt. `/sub-import` with no arguments now prompts as well.
- **Add `/accounts` → Rename account**, so an already-imported `cc-max` can become `work`. The alias provider and a session pinned to the old alias both follow the new name.
- Footer status reports the account the session actually authenticates as (`anthropic-work · subscription billing`), instead of always reporting the stored active account.
- A persisted `defaultProvider: "anthropic-<name>"` is preserved and only rewritten to `anthropic` when that account is gone.
- Add a runnable naming check: `npx jiti ./import-names.test.ts`.

## 0.4.7

- Stop writing recurring background-refresh failures to the transcript; retain a deduplicated in-memory failure state instead
- Surface a compact native footer summary such as `2 accounts need re-login`
- Fix the missing refresh-failure bookkeeping helpers introduced during the 0.4.6 UI cleanup

## 0.4.6

- Keep `anthropic-<account>` aliases visible in `/model` even when that account's refresh token is stale by adding a side-effect-free availability check that only verifies the stored account exists
- Defer the actual refresh attempt to model use, where the shorter 0.4.5 sanitized re-login guidance is shown if the token is invalid

## 0.4.5

- Sanitize Anthropic OAuth refresh failures before rethrowing them through pi's provider auth path, so `/model` availability checks and alias token resolution no longer surface the upstream full stack trace in normal invalid-refresh-token cases
- Keep the actionable error short, e.g. `invalid_grant (refresh token not found or invalid). Re-login this account in /accounts.`

## 0.4.4

Fixes a regression introduced by the 0.4.2 background refresh.

- Leave the **active** account alone while a run is in flight. Anthropic rotates
  OAuth tokens: a refresh mints a new access token and invalidates the previous
  one, which the API reports as `"OAuth access token has been revoked."` rather
  than as an expiry. A long agentic turn resolves its credential once, at
  `before_agent_start`, so the background sweep rotating that same account
  pulled the token out from under an in-flight request and failed the run
  mid-flight. Idle accounts are still swept, which was the point of the feature.
- Refresh once per process instead of once per session. pi loads the extension
  per session, so N sessions previously meant N sweeps of one credential file
  and N chances to rotate a token another session was about to use.
- Refresh immediately after `agent_end`, when no request is outstanding, so a
  long idle stretch does not begin with a nearly expired token.

## 0.4.3

- Treat `anthropic-<account>` as a selection alias rather than the canonical persisted provider when possible: selecting one switches the active Anthropic account and normalizes the session model back to `anthropic/<model>`
- Normalize a persisted `defaultProvider` alias in `~/.pi/agent/settings.json` back to `anthropic` during extension startup while keeping the targeted account active
- Preserve the 0.4.2 re-login and background refresh behavior

## 0.4.2

- Fix Anthropic OAuth refresh handling on Node 24 by always supplying a concrete `AbortSignal`
- Add background refresh for all stored multi-account OAuth credentials before expiry
- Add explicit `/accounts` re-login support for existing accounts instead of requiring a manual same-name replace flow
- Sync the active runtime immediately after account changes so account switches take effect without waiting for another turn
- Keep PI WEB alias compatibility from 0.4.1, including bootstrap registration of `anthropic-<name>` providers and OAuth bearer auth for aliases

## 0.4.1

- Fix `anthropic-<name>` aliases in PI WEB by registering them during extension bootstrap, so sessiond captures them in the frozen provider baseline
- Fix Anthropic account aliases to authenticate with OAuth bearer headers instead of `x-api-key`, resolving `401 invalid x-api-key` failures in aliased models
- Keep alias models visible in `/model` for both terminal pi and PI WEB multi-session flows

## 0.4.0

- Re-published the repository with English-only documentation and metadata
- Keeps the installable Pi Package structure for `pi install git:...`
- Includes multi-account switching via `@narumitw/pi-accounts`
- Includes Claude Code-style subscription billing for Anthropic OAuth
- Includes subscription account import from Claude Code credentials
- Includes `anthropic-<name>` model aliases
- Cleans stale aliases on reload
- Auto-heals a missing active Anthropic account after deleting the active entry

## 0.3.0

- First GitHub-packaged release
- Supports `pi install git:...`
- Bundles multi-account switching via `@narumitw/pi-accounts`
- Adds Claude Code style subscription billing bridge for Anthropic OAuth
- Adds subscription account import from Claude Code credentials
- Adds `anthropic-<name>` model aliases
- Cleans stale aliases on reload
- Auto-heals missing active Anthropic account after deleting the active entry
