# pi-multi-account

A [pi](https://pi.dev) package for named OAuth accounts, Claude subscription billing, and optional account failover.

- Manage Anthropic, GitHub Copilot, and OpenAI Codex accounts with `/accounts`.
- Import existing Claude Code sign-ins and expose pinned `anthropic-<name>` providers in `/model`.
- Send Claude Code-style billing metadata for Anthropic OAuth (`sk-ant-oat...`) requests.
- Shape the request body so Anthropic's payload classifier stops answering with `You're out of extra usage` or the `reasoning_extraction` refusal. See [Request shaping](#request-shaping).
- Create aggregate pools that fail over to another Anthropic account on 401/403/408/429/5xx errors before output starts.

## Compatibility

- Tested with pi `0.85.1`
- Runs directly as TypeScript through pi's `jiti` loader
- Claude Code credentials are discovered from macOS Keychain or `~/.claude/.credentials.json`

## Install

Install as a pi package so pi can manage updates:

```bash
pi install npm:@gang-of-beads/pi-multi-account
```

Choose one source for this fork. If switching from a Git or local installation, remove its existing package declaration before installing the npm distribution; do not load both copies. No account or credential migration is performed.

Restart pi or run `/reload`.

Pi-owned account, pool, settings and log paths follow `PI_CODING_AGENT_DIR` (or Pi's default agent directory). Explicit `PI_MULTI_ACCOUNT_POOLS_FILE` and `PI_MULTI_ACCOUNT_LOG_FILE` overrides still take precedence. Claude Code credentials remain in Claude Code's own locations.

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

The one pace control is for the case where nothing works anywhere: after three consecutive requests in which every account failed, the next request waits before its first attempt, doubling from 1 s to a 30 s ceiling. A request that streams anything clears the streak, and a request more than a minute after the last failure does not count as part of one — coming back to a session later never makes you wait. The pool's error says so when it fires, and logs `pool.stall_pause`.

```bash
PI_MULTI_ACCOUNT_LOG=debug; tail -f ~/.pi/agent/pi-multi-account.log | grep stall
```

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
| `PI_MULTI_ACCOUNT_SHAPE` | enabled | Set to `0` to stop de-fingerprinting the request body and stripping transcribed reasoning. The billing header and the errored-tool-result fix still apply. See [Request shaping](#request-shaping) |
| `PI_MULTI_ACCOUNT_POOLS_FILE` | `~/.pi/agent/pi-multi-account-pools.json` | Pool definitions file |
| `PI_MULTI_ACCOUNT_BACKGROUND_REFRESH` | enabled | Set to `0` on a secondary install sharing the account store |
| `PI_MULTI_ACCOUNT_LOG` | `info` | `debug` enables request diagnostics; `0`/`off` disables logs |
| `PI_MULTI_ACCOUNT_LOG_FILE` | `~/.pi/agent/pi-multi-account.log` | JSONL diagnostics file |
| `ANTHROPIC_CLI_VERSION_MIN` | the highest of the pinned `2.1.296`, a local `claude --version`, and this value | Raises the version claimed in the billing header and the user-agent. It is a floor, never a downgrade: a value below the pin or below a local claude is ignored. The gateway enforces a per-model minimum (`claude_code_version_too_old`), so only a claim at or above it reaches a new model. An exact version comes from `ANTHROPIC_USER_AGENT` instead |
| `CODEX_CLIENT_VERSION_MIN` | the highest of the pinned `0.162.1`, a local `codex --version`, and this value | Raises the Codex CLI version the ChatGPT `/codex/models` catalog request claims. The catalog hides newer models from older clients, and a model missing from it keeps pi's base window (272k) instead of the account's maximum. A floor, never a downgrade; a value that is not a dotted version such as `0.163.0` is ignored |
| `CLAUDE_CODE_ENTRYPOINT` | `sdk-cli` | User-agent entrypoint override |
| `ANTHROPIC_USER_AGENT` | generated | Complete user-agent override. It is the last word: the `claude-cli/<version>` it names becomes the billing header's `cc_version` too, so the two cannot disagree |

The account store is `~/.pi/agent/pi-accounts.json`. Each Codex account's context windows from its last catalog are kept in `~/.pi/agent/pi-multi-account-codex-catalog.json`, so the `codex` providers register with them when the extension loads. An account with no cached catalog is fetched at load (at most 3 s, not with `PI_OFFLINE`); no token is refreshed at load, so an account whose token is about to expire waits for the session-start sync. Logs never contain tokens; they use short SHA-256 fingerprints. Inspect them with:

```bash
tail -f ~/.pi/agent/pi-multi-account.log
```

## Request shaping

Anthropic's server reads the request *body* to decide what produced it — not the user-agent, headers or TLS. Two payload shapes are answered with a refusal that names neither the model nor the account:

```text
400 invalid_request_error: You're out of extra usage.
   … or …
This request was blocked as it seems to violate Anthropic's Terms of Service
restrictions on reverse engineering or duplicating model outputs.
```

The second one is Anthropic's `reasoning_extraction` category, and it fires when the model's own reasoning reaches it as **plain text**. pi does that on purpose in every summarization transcript, which is why `/compact` is the usual place to see it. Measured on `claude-opus-5-5`, a summarization request carrying `[Assistant thinking]: ` was refused 5 times out of 5; the same request with those segments removed was accepted 5 times out of 5.

So two things are shaped on OAuth requests (`src/anthropic-shape.ts`):

- pi's own prompt prose is de-fingerprinted — its verbose preamble is replaced with a neutral minimum, its `docs` section is dropped, and the tools section's "custom tools" filler paragraph goes. The prompt stays in `system[]`; nothing is relocated into a message. A custom or subagent preamble is left alone.
- `[Assistant thinking]: …` segments are removed from summarization transcripts (`/compact`, turn prefix, branch summary), and the billing header's `cch` is then computed from the text that actually ships.

One rule is not about fingerprints at all, and is not behind the switch: a **failing tool that also returned a picture** is rejected outright with

```text
400 messages.N.content.0.tool_result: all content must be type `text` if `is_error` is true
```

pi-ai encodes a tool result as a content-block array whenever it carries an image, and copies the tool's own error flag, so the two together never pass. The errored result is rewritten to text (the image becomes `(see attached image)`, pi-ai's own wording) — the text block already describes the failure, and Anthropic accepts no non-text block there.

Only requests that already carry the Claude Code identity block are touched, so API-key accounts and GitHub Copilot are unaffected. `PI_MULTI_ACCOUNT_SHAPE=0` turns off the de-fingerprinting and the reasoning strip; the billing header and the errored-tool-result fix still apply.

Shaping is attached in the runtime's `prepareRequest` patch, not only to pi's `before_provider_request` hook. That hook is driven by the agent loop and `/compact` is not part of it — it calls the provider stream directly with its own options — so a summarization request used to reach the wire with neither the billing header nor the strip (measured on pi 1.1.0). `prepareRequest` runs for every provider and every request, including compaction, and unlike a `registerProvider("anthropic", …)` it cannot take the `anthropic` id away from the pool.

A successful `/compact` therefore no longer carries the assistant's reasoning into the summary. That is the deliberate trade: the alternative is a summarization request that is refused outright.

## Troubleshooting

- **`anthropic` is absent from `/model`:** add or select an account in `/accounts`, then `/reload`.
- **Deleted aliases remain:** run `/reload`; session startup removes stale `anthropic-<name>` providers.
- **`/sub-accounts` finds nothing:** confirm Claude Code is logged in and that Keychain or `~/.claude/.credentials.json` contains credentials.
- **`400 … all content must be type text if is_error is true`:** a failing tool returned an image; see [Request shaping](#request-shaping). This extension normalizes it on OAuth requests only — with a plain API key it is upstream pi-ai and unfixed.
- **Another installation rotates shared tokens:** set `PI_MULTI_ACCOUNT_BACKGROUND_REFRESH=0` on the passive installation.
- **Requests are blocked as "reverse engineering or duplicating model outputs":** retry once; if it persists across accounts, check that shaping is on (`PI_MULTI_ACCOUNT_SHAPE` is unset) and that pi or a tool has not reworded the prompt anchors (see the drift test in `test/anthropic-shape.test.ts`).
- **A pool error says it is waiting N seconds:** all accounts have failed several requests in a row; see [Pools and failover](#pools-and-failover).
- **Billing lands on "extra usage" instead of the plan:** the billing header is not reaching the wire. Confirm the account is OAuth (`sk-ant-oat…`) and that the request is `anthropic` or a pool, not a plain API-key provider.

## Security

This package makes eligible Anthropic OAuth requests resemble Claude Code subscription traffic — headers, user-agent, the billing header block, and the request body (see [Request shaping](#request-shaping)). Use it only when permitted by Anthropic's terms and your subscription. Pi extensions have full local system permissions; install only code you trust.

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
- Request shaping (`src/anthropic-shape.ts`) ported in spirit from [`gotgenes/pi-anthropic-auth`](https://github.com/gotgenes/pi-anthropic-auth) (MIT)
