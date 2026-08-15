# Changelog

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
