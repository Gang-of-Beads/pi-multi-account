# Changelog

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
