# pi-multi-account

A [pi](https://pi.dev) package for named OAuth accounts, Claude subscription billing, and optional account failover.

- Manage Anthropic, GitHub Copilot, and OpenAI Codex accounts with `/accounts`.
- Import existing Claude Code sign-ins and expose pinned `anthropic-<name>` providers in `/model`.
- Send Claude Code-style billing metadata for Anthropic OAuth (`sk-ant-oat...`) requests.
- Create aggregate pools that fail over to another Anthropic account on 401/403/408/429/5xx errors before output starts.

## Compatibility

- Tested with pi `0.85.1`
- Runs directly as TypeScript through pi's `jiti` loader
- Claude Code credentials are discovered from macOS Keychain or `~/.claude/.credentials.json`

## Install

Install as a pi package so pi can manage updates:

```bash
pi install git:https://github.com/Gang-of-Beads/pi-multi-account.git
# or
pi install /absolute/path/to/pi-multi-account
```

Restart pi or run `/reload`.

> Remove any separately installed `@narumitw/pi-accounts` package first, otherwise its commands and provider logic load twice:
>
> ```bash
> pi remove npm:@narumitw/pi-accounts
> ```

## Quick start

1. Run `/sub-accounts` to see detected Claude Code accounts.
2. Run `/sub-import` and choose aliases, or pass names: `/sub-import personal work`.
3. Use `/accounts` to manage accounts and choose the native active account.
4. In `/model`, choose either `anthropic/<model>` (active account) or `anthropic-<name>/<model>` (pinned account).

The footer shows the selected account and `subscription billing` when applicable.

## Pools and failover

Create a pool with an ordered account list:

```text
/pool-create team personal work
```

Then select `team/<model>` in `/model`. The pool tries one account at a time and retries the same request with the next account only before any content has streamed. An attempt is worth another account when it never answered (a timeout, a stream that threw), when it answered with a retryable status (401/403/408/429, 5xx), or when it answered `200` and the stream then failed — the shape the Anthropic gateway uses for its client-fingerprint block. It has no cooldown or retry-after scheduler; a failed account is simply no longer the next starting point.

A pool named `anthropic` deliberately replaces the native Anthropic provider, so `anthropic/<model>` also fails over. All pools are stored in `~/.pi/agent/pi-multi-account-pools.json` and are restored at session start.

## Commands

| Command | Purpose |
| --- | --- |
| `/accounts` | Add, switch, rename, re-login, or remove named OAuth accounts |
| `/sub-accounts` | List Claude Code accounts available for import |
| `/sub-import [name...]` | Import detected accounts; names accept `A-Za-z0-9._-` (max 64 chars) |
| `/anthropic-account-providers` | Re-sync `anthropic-<name>` entries in `/model` |
| `/pools` | List aggregate pools |
| `/pool-create [name] [accounts...]` | Create a pool; omitted accounts can be chosen interactively |
| `/pool-add`, `/pool-remove`, `/pool-delete` | Change or delete a pool |

Imported credentials are read-only: this package never writes into Claude Code's own credential storage.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_MULTI_ACCOUNT_AUTO_IMPORT` | enabled | Set to `0` to disable first-run import |
| `PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES` | unset | Comma/space-separated first-run aliases; imports without prompting |
| `PI_MULTI_ACCOUNT_ALIASES` | enabled | Set to `0` to hide `anthropic-<name>` providers |
| `PI_MULTI_ACCOUNT_FAILOVER` | enabled | Set to `0` to disable pools |
| `PI_MULTI_ACCOUNT_POOLS_FILE` | `~/.pi/agent/pi-multi-account-pools.json` | Pool definitions file |
| `PI_MULTI_ACCOUNT_BACKGROUND_REFRESH` | enabled | Set to `0` on a secondary install sharing the account store |
| `PI_MULTI_ACCOUNT_LOG` | `info` | `debug` enables request diagnostics; `0`/`off` disables logs |
| `PI_MULTI_ACCOUNT_LOG_FILE` | `~/.pi/agent/pi-multi-account.log` | JSONL diagnostics file |
| `ANTHROPIC_CLI_VERSION_MIN` | the highest of the pinned `2.1.296`, a local `claude --version`, and this value | Raises the version claimed in the billing header and the user-agent. It is a floor, never a downgrade: a value below the pin or below a local claude is ignored. The gateway enforces a per-model minimum (`claude_code_version_too_old`), so only a claim at or above it reaches a new model. An exact version comes from `ANTHROPIC_USER_AGENT` instead |
| `CODEX_CLIENT_VERSION_MIN` | the highest of the pinned `0.162.1`, a local `codex --version`, and this value | Raises the Codex CLI version the ChatGPT `/codex/models` catalog request claims. The catalog hides newer models from older clients, and a model missing from it keeps pi's base window (272k) instead of the account's maximum. A floor, never a downgrade |
| `CLAUDE_CODE_ENTRYPOINT` | `sdk-cli` | User-agent entrypoint override |
| `ANTHROPIC_USER_AGENT` | generated | Complete user-agent override. It is the last word: the `claude-cli/<version>` it names becomes the billing header's `cc_version` too, so the two cannot disagree |

The account store is `~/.pi/agent/pi-accounts.json`. Each Codex account's context windows from its last catalog are kept in `~/.pi/agent/pi-multi-account-codex-catalog.json`, so the `codex` providers register with them when the extension loads. Logs never contain tokens; they use short SHA-256 fingerprints. Inspect them with:

```bash
tail -f ~/.pi/agent/pi-multi-account.log
```

## Troubleshooting

- **`anthropic` is absent from `/model`:** add or select an account in `/accounts`, then `/reload`.
- **Deleted aliases remain:** run `/reload`; session startup removes stale `anthropic-<name>` providers.
- **`/sub-accounts` finds nothing:** confirm Claude Code is logged in and that Keychain or `~/.claude/.credentials.json` contains credentials.
- **Another installation rotates shared tokens:** set `PI_MULTI_ACCOUNT_BACKGROUND_REFRESH=0` on the passive installation.

## Security

This package makes eligible Anthropic OAuth requests resemble Claude Code subscription traffic. Use it only when permitted by Anthropic's terms and your subscription. Pi extensions have full local system permissions; install only code you trust.

## Development

```text
src/   extension implementation and refresh CLI
test/  runnable self-checks
```

```bash
npm install
npx tsc --noEmit
for test in test/*.test.ts; do npx jiti "$test"; done
```

The pi entrypoint is `src/index.ts`; local testing works with:

```bash
pi -e /absolute/path/to/pi-multi-account
```

## Credits

- Multi-account runtime: [`@narumitw/pi-accounts`](https://www.npmjs.com/package/@narumitw/pi-accounts)
- Billing and credential-discovery code adapted from [`pi-claude-auth`](https://github.com/pankajudhas81/pi-claude-auth) (MIT); see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
