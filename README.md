# pi-multi-account

`pi-multi-account` adds two capabilities to pi:

1. **Multi-account OAuth switching** via [`@narumitw/pi-accounts`](https://www.npmjs.com/package/@narumitw/pi-accounts), so Anthropic, GitHub Copilot, and OpenAI Codex accounts can be managed from one `/accounts` menu.
2. **Claude subscription billing bridging** for Anthropic OAuth (`sk-ant-oat...`) requests, by sending the Claude Code-style user-agent and `x-anthropic-billing-header` required to route usage to a Claude Pro / Max subscription instead of pay-as-you-go API billing / extra usage.

It also includes:

- automatic import of existing **Claude Code** sign-ins from this machine, with **you** choosing the account alias
- per-account `anthropic-<account>` aliases in `/model` that **stay selected**, so `/model` and the footer always show which account a session talks to
- automatic recovery when the active Anthropic account is deleted, so the entire `anthropic` provider does not disappear from `/model`

---

## Compatibility

- **Tested with pi**: `0.84.1`
- **Runtime model**: TypeScript extension loaded directly by pi through `jiti` (no prebuild required)
- **Credential discovery**:
  - primarily supports **macOS Keychain** for Claude Code detection
  - also supports `~/.claude/.credentials.json`

---

## Features

| Feature | What it does |
| --- | --- |
| `/accounts` | Manage named OAuth accounts for Anthropic / GitHub Copilot / OpenAI Codex and switch the active account |
| `/sub-accounts` | Detect subscription-backed accounts already available on this machine (currently Claude Code) and show whether they are imported |
| `/sub-import [name...]` | Import detected subscription accounts; asks for a name per account interactively, or takes names as arguments |
| `anthropic-<name>` provider aliases | Every named Anthropic account appears directly in `/model`, e.g. `anthropic-personal`, `anthropic-work`, and stays selected for the whole session |
| `/accounts` → *Rename account* | Rename a stored account (e.g. an auto-imported `cc-max` → `work`); the alias and the current session follow the new name |
| Claude subscription billing bridge | Adds the Claude Code style user-agent and billing header to Anthropic OAuth requests so usage is charged to the Claude subscription path |
| Active-account auto-heal | If the current active Anthropic account is deleted, the next `session_start` automatically activates the first remaining account |
| Status footer | Shows `anthropic-<account> · subscription billing` when a session is pinned to an alias, otherwise `anthropic: <active-account> · subscription billing` |

---

## Installation

> Recommended: install it as a **pi package**, so it can be managed with `pi install`, `pi update`, and `pi remove`.

### Option A: install from the private GitHub repo

If your machine has access to the private repository:

#### SSH

```bash
pi install git:git@github.com:VincentHanxiaoDu/pi-multi-account.git@v0.4.0
```

#### HTTPS

```bash
pi install git:https://github.com/VincentHanxiaoDu/pi-multi-account.git@v0.4.0
```

Then run:

```bash
/reload
```

Or simply restart pi.

### Option B: install from a local path

```bash
pi install /absolute/path/to/pi-multi-account
```

### Option C: install by cloning into the extensions directory

```bash
git clone git@github.com:VincentHanxiaoDu/pi-multi-account.git \
  ~/.pi/agent/extensions/pi-multi-account
```

Then:

```bash
/reload
```

---

## Quick start

Recommended first-run flow:

1. `/sub-accounts`  
   See which Claude Code subscription accounts are already detectable on this machine.

2. `/sub-import`  
   Import those accounts into the `pi-accounts` store, naming each one yourself. On an empty Anthropic account store, an interactive session asks the same question on startup instead of importing silently.

3. `/accounts`  
   Verify the active account and switch if needed.

4. `/model`  
   Choose either:
   - native `anthropic/...` models, which use the current active account
   - or `anthropic-<name>/...`, which pins a specific named account for this session and keeps showing it in `/model` and the footer

5. Check the footer  
   It should show:

   ```text
   (anthropic-work) claude-opus-5 · medium
   anthropic-work · subscription billing
   ```

---

## How pi installs and loads this package

This repository follows the **Pi Package** format.

Its `package.json` includes:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

That means pi can install it directly as a package with:

- `pi install git:...`
- `pi install /path/to/package`

At install time, pi will:

- clone or copy the package
- run `npm install`
- load the TypeScript extension through `jiti`

And `/reload` can hot-reload installed packages and auto-discovered extensions.

Because of that, this repository works both as:

- a GitHub-hosted installable pi package
- a local extension directory

---

## Commands

### `/accounts`

Provided by `@narumitw/pi-accounts`.

Use it to:

- list provider accounts
- switch the active account
- delete accounts
- add new OAuth accounts

Persistent store:

- `~/.pi/agent/pi-accounts.json`

### `/sub-accounts`

Lists subscription-backed accounts that can be imported.

Current sources:

- Claude Code credentials stored in the macOS Keychain
- `~/.claude/.credentials.json`

### `/sub-import [name...]`

Imports detected subscription-backed accounts into the `pi-accounts` Anthropic store.

Behavior:

- with no arguments, asks for one alias per detected account (blank answer falls back to `cc`, `cc-pro`, `cc-max`)
- supports custom names as arguments, for example:

```bash
/sub-import claude-main claude-work
```

- names are validated (`A-Za-z0-9._-`, max 64 chars) and `default` is reserved for pi's own login
- accounts can be renamed later from `/accounts` → *Rename account*

- reads Claude Code credentials in **read-only** mode
- does **not** write anything back into Claude Code's own credential storage

### `/anthropic-account-providers`

Force-resyncs the `anthropic-<name>` provider aliases shown in `/model`.

---

## How the billing bridge works

pi's built-in Anthropic OAuth path already sends:

- a Claude Code identity block
- Anthropic OAuth bearer tokens
- the expected beta headers

But that alone is not enough to consistently hit the Claude subscription billing path.

This extension adds two missing pieces:

1. a full Claude Code user-agent:

```text
claude-cli/<version> (external, sdk-cli)
```

2. a payload-level billing header block:

```text
x-anthropic-billing-header
```

Together, those make Anthropic treat the request as Claude Code-style subscription traffic instead of a normal API request.

### Cases that are intentionally skipped

The billing injection is skipped for:

- non-Claude models
- non-Anthropic OAuth requests
- plain API key requests
- GitHub Copilot / Codex traffic

---

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_MULTI_ACCOUNT_AUTO_IMPORT` | enabled | Set to `0` to disable first-run auto-import when the Anthropic account store is empty |
| `PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES` | unset | Comma/space separated account names used by first-run import, e.g. `work,personal`. When set, import runs immediately without asking |
| `PI_MULTI_ACCOUNT_ALIASES` | enabled | Set to `0` to disable `anthropic-<name>` provider aliases |
| `PI_MULTI_ACCOUNT_BACKGROUND_REFRESH` | enabled | Set to `0` on a secondary installation that shares the credential file, so only one installation rotates tokens |
| `PI_MULTI_ACCOUNT_LOG` | `info` | `debug` adds per-request credential resolution; `0`/`off` disables the debug log |
| `PI_MULTI_ACCOUNT_LOG_FILE` | `~/.pi/agent/pi-multi-account.log` | Where the debug log is written |
| `ANTHROPIC_CLI_VERSION` | `2.1.160` | Overrides the Claude CLI version used in the billing header and user-agent |
| `CLAUDE_CODE_ENTRYPOINT` | `sdk-cli` | Overrides the user-agent entrypoint |
| `ANTHROPIC_USER_AGENT` | auto-generated | Fully overrides the Anthropic user-agent |

---

## Storage and runtime behavior

### Account storage

- `~/.pi/agent/pi-accounts.json`

### Debug log

`~/.pi/agent/pi-multi-account.log`, one JSON object per line. No command reads
it; it is a file, meant for `tail -f` and for answering the questions a
surprise 401 raises after the fact.

| Event | Meaning |
| --- | --- |
| `session.account` | Which account a session resolved, and from where (pinned alias vs stored active) |
| `store.changed` | The account store changed; `origin=foreign` means another process did it |
| `refresh.due` / `refresh.succeeded` / `refresh.failed` | Token rotation, with before/after fingerprints |
| `refresh.superseded` | Another writer had already replaced the token this process was holding |
| `refresh.backoff` | A credential that needs a re-login, being left alone until `retryAt` |
| `credential.suspect` / `response.rejected` | The provider rejected a token, with the request id |
| `active.switched` / `model.selected` | Account and model changes made by this session |

Tokens are never written to the log; each one appears as an 8-character SHA-256
fingerprint, which is enough to see that a token changed — or that two
installations hold the same one — without leaking the secret.

A failure that keeps repeating is logged once, not once per attempt: the retry
itself backs off (a minute, doubling to fifteen; six hours for an
`invalid_grant` that only a re-login can fix), and a stored credential that
changes — someone re-logged in — is retried immediately.

```bash
tail -f ~/.pi/agent/pi-multi-account.log
```

### Auto-import sources

- macOS Keychain services: `Claude Code-credentials` / `Claude Code-credentials-*`
- `~/.claude/.credentials.json`

### Alias provider behavior

`anthropic-<name>` aliases are runtime providers that:

- are registered during extension bootstrap (so `pi -p --model anthropic-work/...`, `--models` cycling, and session restore all resolve them) and re-synced on `session_start`
- resolve their **own** account's OAuth credential per request, refreshing it under the shared account-store lock, independently of every other alias
- hand pi the raw `sk-ant-oat...` token as the request api key, which is what puts pi's Anthropic adapter into Claude Code / OAuth mode (bearer auth, oauth betas, identity block, Claude Code tool names) and therefore keeps subscription billing working exactly like native `anthropic/...`
- stay selected: choosing `anthropic-work/claude-opus-5` keeps that provider for the session and also points the stored active account at `work`, so `/accounts` agrees with the last explicit choice

A persisted `defaultProvider: "anthropic-work"` in `~/.pi/agent/settings.json` is kept as-is, and only rewritten to `anthropic` if that account no longer exists.

### Print mode

`pi -p --model anthropic-work/claude-haiku-4-5` works: aliases exist before the model is resolved. First-run import in a non-TTY run does not prompt; it uses `PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES` when set, otherwise generated names.

---

## Upgrade and migration notes

If you previously used:

- a custom `anthropic-multi-account.ts`
- a custom `anthropic-account-providers.ts`
- a standalone `@narumitw/pi-accounts` package install

remove duplicate loading sources so the same `/accounts` menu or provider logic is not loaded twice.

### Remove a standalone pi-accounts package

```bash
pi remove npm:@narumitw/pi-accounts
```

### Check your settings and extension directories

Inspect:

- `~/.pi/agent/settings.json`
- `~/.pi/agent/extensions/`

Make sure only one copy of this behavior is active.

---

## Troubleshooting

### 1) `anthropic` does not appear in `/model`

Common causes:

- there is no active Anthropic account
- you deleted the active account
- the current session has not been reloaded yet

Try:

1. `/accounts` to verify the active account
2. `/reload`
3. check whether the footer shows:

```text
anthropic: <name> · subscription billing
```

This extension auto-heals the active account on `session_start`, but you can always choose the active account manually in `/accounts`.

### 2) Deleted account aliases still appear in `/model`

Run:

```bash
/reload
```

The extension cleans stale `anthropic-<name>` aliases during `session_start`.

### 3) `/sub-accounts` does not detect any Claude Code accounts

Check:

- whether Claude Code is actually logged in on this machine
- whether the macOS Keychain contains `Claude Code-credentials...`
- whether `~/.claude/.credentials.json` exists

### 4) `/model` switched me back to plain `anthropic`

That was the behavior of 0.4.3 – 0.4.7, which treated `anthropic-<name>` as a selection shortcut and normalized the session back to `anthropic/<model>`. Since 0.4.8 the alias stays selected. Upgrade, then `/reload`.

---

## Security and policy note

> Important: the Claude subscription billing bridge in this extension intentionally makes third-party pi requests look like Claude Code subscription requests.

That means:

- this is explicitly enabled by user request
- it is different from using a normal Anthropic API key
- for long-term use, you should keep an eye on Anthropic's terms for third-party CLI / subscription usage

Also remember:

- pi extensions run with full permissions on your machine
- install only code you trust
- `pi install git:...` and `pi install npm:...` both install executable code

---

## Development

### Repository layout

| File | Responsibility |
| --- | --- |
| `index.ts` | Extension entrypoint: wiring and event handlers only |
| `adapters.ts` | pi-accounts provider adapters, patched for Node 24 signals and credential metadata |
| `refresh.ts` | Background refresh sweep, single-credential refresh, refresh-failure state |
| `aliases.ts` | `anthropic-<account>` provider aliases shown by `/model` |
| `accounts-menu.ts` | `/accounts`: login, re-login, switch, rename, remove |
| `subscription-import.ts` | `/sub-accounts`, `/sub-import`, first-run interactive import |
| `session-state.ts` | Which account a session uses, alias restore, footer status |
| `debug-log.ts` | JSONL debug log: token fingerprints, never tokens |
| `store-watch.ts` | Detects account-store changes made by other processes |
| `billing.ts` | Claude Code user-agent and `x-anthropic-billing-header` injection |
| `names.ts`, `errors.ts` | Account-name and error-shaping helpers |
| `subscription-credentials.ts` | Claude Code credential discovery (Keychain, `~/.claude`) |

```bash
cd ~/.pi/agent/extensions/pi-multi-account
npm install
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
```

Runnable checks:

```bash
npx jiti ./import-names.test.ts     # account-import naming
npx jiti ./store-watch.test.ts      # foreign-writer detection
npx jiti ./revoked-refresh.test.ts  # 401-driven refresh, backoff, log-once
npx jiti ./wiring.test.ts           # event wiring + the log sink really writes
```

### Local testing

```bash
pi -e /absolute/path/to/pi-multi-account
```

Or place it directly in:

```bash
~/.pi/agent/extensions/pi-multi-account
```

Then run:

```bash
/reload
```

---

## Credits

- Multi-account runtime support comes from [`@narumitw/pi-accounts`](https://www.npmjs.com/package/@narumitw/pi-accounts)
- `billing.ts` and `subscription-credentials.ts` were adapted from [`pi-claude-auth`](https://github.com/pankajudhas81/pi-claude-auth) (MIT)

See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for attribution and licensing notes.
