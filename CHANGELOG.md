# Changelog

## 0.6.2

Keeps the status footer meaningful on a pool model.

- **The footer no longer goes blank when a pool model is selected.** A pool
  picks its account per request, so before the first request of a session
  there was no "current" account and the whole status line (pool, account,
  subscription billing, cooling accounts) disappeared. It now falls back to
  the account the pool would try next, honoring cooldowns.
- **Last-used account is tracked per pool.** `lastPoolAccount(poolName)`
  keeps two pools in one process from reporting each other's account in the
  footer and in cooldown bookkeeping.

## 0.6.1

Fixes a user-agent mismatch on every Anthropic OAuth request.

- **The full Claude Code UA never reached the wire.** The provider-level
  `headers` registration (billing.ts / aliases.ts) does not participate in
  pi's request header assembly — pi builds request headers from model-level
  definitions and caller options only, and pi-ai merges its own bare
  `claude-cli/2.1.75` UA inside the SDK client afterwards. So every OAuth
  request actually went out with the bare UA, which does not match the
  billing header's `cc_version=2.1.217.*`. (Tool-name aliasing, the billing
  header injection, and plan billing itself were unaffected — Anthropic does
  not currently reject the mismatch.)
- **Fixed at the only point where the final headers exist**: the request-time
  fetch wrapper (pool.ts `captureFetch` and the alias stream delegates), which
  runs after the SDK's full header merge and is scoped to exactly the OAuth
  requests this extension authenticates. The override rewrites only UAs
  pi-ai's OAuth client itself produced (`claude-cli/*`), so API-key, Copilot
  and Codex requests pass through untouched, and it is idempotent. The
  `before_provider_headers` event was considered and rejected: it fires
  before pi-ai's merge (no UA yet) and carries no provider id.
- **Verified end-to-end**: requests now carry
  `claude-cli/2.1.217 (external, sdk-cli)` on the wire (logged as
  `request.user_agent` at debug level), matching the billing header.

## 0.6.0

Adds user-defined aggregate account pools with automatic failover.

- **Aggregate pools (`/pool-create`).** Name a provider, pick the accounts it
  may use ("every current account" or a specific ordered list), and requests
  through `<pool>/<model>` try them in order — failing over automatically on
  429/401/403/408/5xx before any content was streamed. The pool appears in
  `/model` under the name you chose; nothing is registered until you create
  one, so the default behavior is unchanged. A pool literally named
  `anthropic` overrides the native provider instead — that is the one reserved
  name, and choosing it is explicit.
- **Per-account cooldowns.** A rate-limited account cools down (honoring the
  server's `retry-after`, doubling per repeat, capped at 15 minutes); auth
  failures cool down briefly and mark the credential for refresh (the existing
  401 machinery). The footer shows which accounts are cooling.
- **Safe retries.** An attempt that failed before any content was streamed is
  retried on the next account; an error after content started is forwarded
  as-is, because retrying then could duplicate or diverge partial output.
- **Failover notifications.** Mid-stream failovers are queued (the pool runs
  where no UI context exists) and shown on the next provider response.
- **Management commands.** `/pools` lists pools and their status;
  `/pool-add`, `/pool-remove` (freezes an "all" pool into the explicit
  remainder), `/pool-delete` manage them interactively. Definitions persist
  in `~/.pi/agent/pi-multi-account-pools.json` and re-register on session
  start.
- **New env vars.** `PI_MULTI_ACCOUNT_FAILOVER=0` disables pool registration
  entirely; `PI_MULTI_ACCOUNT_POOLS_FILE` moves the definitions file.

## 0.5.2

Keeps the Claude Code request fingerprint current with Anthropic's server-side
checks, following the actively maintained proxy projects (griffinmartin/
opencode-claude-auth, ex-machina-co/opencode-anthropic-auth).

- **Bump the Claude Code client version used in the user-agent and billing
  header from `2.1.160` to `2.1.217`.** A stale version string is one of the
  client-fingerprint signals behind Anthropic's `reverse engineering or
  duplicating model outputs` blocks (see opencode-claude-auth #188 and
  opencode-anthropic-auth #80, Apr 2026, and the recurring enforcement since).
  The signing algorithm itself (billing salt, `cch`, version suffix, identity
  block) already matches the current-generation proxy implementations, so no
  other request-shape change was needed. `ANTHROPIC_CLI_VERSION` still
  overrides the version at runtime.
## 0.5.1

Fixes what the 0.5.0 log immediately exposed about itself.

- **A repeating failure is logged once, not once per attempt.** The failure was
  recorded both inside the store lock and again by the sweep that called it, so
  every failed refresh produced two identical lines.

- **Refresh backoff.** A dead refresh token (`invalid_grant`) was retried every
  60 seconds forever, because the account never stops being expired. Retries now
  back off — a minute doubling to fifteen for failures that might be transient,
  six hours for one that only a re-login can fix — and a stored credential that
  changed (someone re-logged in, here or elsewhere) is retried immediately.

- **No `/account-log` command.** The log is a file; reading it is `tail`'s job.
  The account probe went with it.

## 0.5.0

Makes credential failures diagnosable, and stops a rejected token from failing
every request until something happens to rotate it.

- **Refresh on rejection, not only on expiry.** A revoked Anthropic token dies
  *before* its stored `expires` timestamp — that is what happens when a second
  installation refreshes the same rotating credential — so the expiry-driven
  sweep had no reason to touch it and every request kept failing with the same
  401. A 401 now marks the account, and the next sweep refreshes it regardless
  of the stored expiry: the account either heals before the next turn or reports
  an honest "needs re-login". The active account is still protected while a run
  is in flight, so the fix cannot break an outstanding request.

- **Foreign writes to the account store are detected and reported.**
  `pi-accounts.json` is global mutable state with several writers: other
  sessions, containers sharing the home directory, and host applications (pi web
  among them) that switch accounts by rewriting the file. A session whose model
  is plain `anthropic/...` follows whichever account is active *at request time*,
  so a foreign write silently changes which account it bills to. Changes this
  process did not make are now logged as `origin=foreign` and surfaced in the
  session as a warning.

- **Debug log** at `~/.pi/agent/pi-multi-account.log` (JSONL): which account each
  session and each aliased request resolved, every refresh with before/after
  token fingerprints, provider rejections with request ids, and account-store
  changes. Tokens are never written — only 8-character SHA-256 fingerprints,
  which are enough to see that a token rotated, or that two installations hold
  the same one. `PI_MULTI_ACCOUNT_LOG=debug` adds per-request lines,
  `PI_MULTI_ACCOUNT_LOG=0` disables it, `PI_MULTI_ACCOUNT_LOG_FILE` moves it.

  (0.5.0 also added an `/account-log` command; 0.5.1 removed it again.)

## 0.4.9

- Add `PI_MULTI_ACCOUNT_BACKGROUND_REFRESH=0`, which makes an installation a
  passive reader of the credential file: it still uses the stored accounts, and
  pi-accounts still refreshes on demand when a token is actually needed, but it
  never runs the unprompted sweep.

  Anthropic rotates refresh tokens, so a refresh mints a new one and invalidates
  the previous one. Two installations sharing a credential file — a host install
  and a container handed a copy of it for testing — rotate each other's tokens
  away, which the API reports as `"OAuth access token has been revoked."` rather
  than as an expiry. Setting the variable on the secondary installation keeps
  the primary one the sole owner of rotation.

  The guard sits inside the refresh loop rather than at its call sites, so it
  also covers the account menu and the import commands.

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
