# pi-multi-account

A shared multi-account model runtime, a [pi](https://pi.dev) extension, and an optional subscription API gateway. Pure extension use needs no HTTP server or extra agent session.

See the [gateway and v1 architecture guide](docs/gateway.md) for standalone operation, routing, protocol compatibility and security limits.

- Manage Anthropic, ChatGPT Codex, xAI/Grok and GitHub Copilot accounts with `/accounts`.
- Discover new models from account-specific vendor catalogs; enrich metadata from models.dev and retain an offline cache.
- Share route scheduling and pre-output failover between Pi's `pma/<route>` models and the optional HTTP gateway.
- Import existing Claude Code sign-ins and expose pinned `anthropic-<name>` providers in `/model`.
- Send Claude Code-style billing metadata for Anthropic OAuth (`sk-ant-oat...`) requests.
- Shape the request body so Anthropic's payload classifier stops answering with `You're out of extra usage` or the `reasoning_extraction` refusal. See [Request shaping](#request-shaping).
- Create aggregate pools that fail over to another Anthropic account on 401/403/408/429/5xx errors before output starts.

## Compatibility

- v1 uses Pi `1.5.0` or newer provider/registry APIs; keep v0.8.x if you need an older Pi
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
| `/accounts` | Add, switch, rename, re-login, or remove named OAuth accounts (anthropic, codex, xai, copilot); add one to a pool |
| `/sub-accounts` | List Claude Code accounts available for import |
| `/sub-import [name...]` | Import detected accounts; names accept `A-Za-z0-9._-` (max 64 chars) |
| `/anthropic-account-providers` | Re-sync `anthropic-<name>` entries in `/model` |
| `/pools` | List legacy Anthropic aggregate pools |
| `/pma-models` | Refresh live subscription model catalogs |
| `/routes [add <id> <provider/model>...]` | List or create shared cross-provider routes |
| `/gateway start [port]`, `stop`, `status`, `key` | Explicitly manage an optional HTTP listener and caller keys |
| `/fast [on\|off\|status]` | Codex Fast mode for this session; see [Codex Fast mode](#codex-fast-mode) |
| `/pool-create [name] [accounts...]` | Create a pool; omitted accounts can be chosen interactively |
| `/pool-add`, `/pool-remove`, `/pool-delete` | Change or delete a pool |

Imported credentials are read-only: this package never writes into Claude Code's own credential storage.

## Subscriptions as an API

The optional gateway serves Messages, Chat Completions and Responses using the same core as the extension. `/gateway start` starts a session-owned loopback listener; `pi-multi-account serve` runs independently. Neither starts an agent loop or executes client tools. Caller keys are mandatory, hashed at rest and can be scoped to routes/models.

Use `/routes add daily codex/gpt-6.2-sol xai/grok-4.7`, then select `pma/daily` in Pi or send `"model":"daily"` over HTTP. Advanced routes support ordered, rotating, weighted and observed-usage scheduling, explicit accounts and account groups.

Read [the full guide](docs/gateway.md) before sharing subscriptions. Native protocols are preserved where possible; translation has explicit rejection boundaries and is not lossless for every vendor feature. The gateway is not started automatically.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_MULTI_ACCOUNT_AUTO_IMPORT` | enabled | Set to `0` to disable first-run import |
| `PI_MULTI_ACCOUNT_AUTO_IMPORT_NAMES` | unset | Comma/space-separated first-run aliases; imports without prompting |
| `PI_MULTI_ACCOUNT_ALIASES` | enabled | Set to `0` to hide named-account alias registrations in Pi |
| `PI_MULTI_ACCOUNT_FAILOVER` | enabled | Set to `0` to disable pools |
| `PI_MULTI_ACCOUNT_SHAPE` | enabled | Set to `0` to stop de-fingerprinting the request body and stripping transcribed reasoning. The billing header and the errored-tool-result fix still apply. See [Request shaping](#request-shaping) |
| `PI_MULTI_ACCOUNT_GROK_CLI_VERSION` | the pinned floor | Raises the Grok CLI version claimed on xAI requests. The proxy refuses older clients with 426; a floor, never a downgrade. The published stable Grok CLI version is also followed |
| `PI_OFFLINE` | off | Set to `1` to stop catalog discovery network traffic; cached and built-in models stay usable |
| `--host`, `--port`, `--agent-dir` | loopback, 8787 | `serve` flags only; `--agent-dir` also moves the key/route/ledger files. See [the gateway guide](docs/gateway.md) |
| `PI_MULTI_ACCOUNT_CODEX_FAST` | off | Set to `1` to send Codex Fast mode (`service_tier: priority`) on every Codex request. `/fast off` still overrides it for the session |
| `PI_MULTI_ACCOUNT_POOLS_FILE` | `~/.pi/agent/pi-multi-account-pools.json` | Pool definitions file |
| `PI_MULTI_ACCOUNT_BACKGROUND_REFRESH` | enabled | Set to `0` on a secondary install sharing the account store |
| `PI_MULTI_ACCOUNT_LOG` | `info` | `debug` enables request diagnostics; `0`/`off` disables logs |
| `PI_MULTI_ACCOUNT_LOG_FILE` | `~/.pi/agent/pi-multi-account.log` | JSONL diagnostics file |
| `ANTHROPIC_CLI_VERSION_MIN` | the highest of the pinned `2.1.322`, a local `claude --version`, and this value | Raises the version claimed in the billing header and the user-agent. It is a floor, never a downgrade: a value below the pin or below a local claude is ignored. The gateway enforces a per-model minimum (`claude_code_version_too_old`), so only a claim at or above it reaches a new model. An exact version comes from `ANTHROPIC_USER_AGENT` instead |
| `CODEX_CLIENT_VERSION_MIN` | the highest of the pinned `0.170.0`, cached npm latest, a local `codex --version`, and this value | Raises the Codex CLI version the ChatGPT `/codex/models` catalog request claims. The catalog hides newer models from older clients, and a model missing from it keeps pi's base window (272k) instead of the account's maximum. A floor, never a downgrade; a value that is not a dotted version such as `0.163.0` is ignored |
| `CLAUDE_CODE_ENTRYPOINT` | `sdk-cli` | User-agent entrypoint override |
| `ANTHROPIC_USER_AGENT` | generated | Complete user-agent override. It is the last word: the `claude-cli/<version>` it names becomes the billing header's `cc_version` too, so the two cannot disagree |

The account store remains `~/.pi/agent/pi-accounts.json`. Full, non-secret model snapshots are kept in `pi-multi-account-catalog.json`; the old Codex window cache remains readable. Bootstrap uses cached/built-in models and bounded discovery with already-live tokens; it does not rotate expiring named tokens. `PI_OFFLINE=1` disables discovery network traffic. Logs use short SHA-256 credential fingerprints, never raw tokens. Inspect them with:

```bash
tail -f ~/.pi/agent/pi-multi-account.log
```

## New models

Model IDs no longer have to wait for a pi-ai or plugin release. Codex and Grok query their account's vendor catalog; vendor metadata takes priority and models.dev fills missing facts. `/pma-models` forces a refresh. Cached catalogs remain available offline, and an older client-version claim cannot hide new Codex models when a newer CLI/npm version is known.

Anthropic subscription entitlements are less discoverable: only models its endpoint listed are offered, with models.dev enriching their metadata, and a failed discovery keeps the last good or built-in catalogue instead of inventing IDs. Existing entries in `src/models.ts` remain an offline safety net, not the main update mechanism. Unknown prices are unpriced (numeric zero for Pi's required schema), not evidence that a model is free. New wire protocols or compatibility requirements can still require an update. See [model discovery and its limits](docs/gateway.md#model-discovery).

## Grok (xAI subscription)

`/accounts` can log in a SuperGrok / X Premium account (xAI's device-code flow) and it appears as `xai` and `xai-<account>` in `/model`. Two things differ from an API-key setup, both because of the subscription:

- a subscription token is refused by `api.x.ai` ("you need a Grok subscription"), so the aliases talk to the Grok CLI proxy those subscriptions are for — an `XAI_API_KEY` user keeps pi's own provider;
- that proxy refuses a request that names no recent Grok CLI (HTTP 426), so every request carries `x-grok-client-version`. The floor also follows Grok's published stable CLI version; `PI_MULTI_ACCOUNT_GROK_CLI_VERSION` can raise it explicitly.

`PI_MULTI_ACCOUNT_ALIASES=0` hides them with the other aliases; `PI_MULTI_ACCOUNT_XAI_ALIASES=0` hides only these.

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

## Codex Fast mode

Codex has a faster service tier, which OpenAI renamed from Priority processing to **Fast mode** (they are the same thing: the REST API accepts `service_tier: "fast"` and `"priority"`, while the ChatGPT Codex backend accepts only `"priority"` and answers `400 Unsupported service_tier: fast` for the other). Your subscription's own catalog advertises it as `priority`, "1.5x speed, increased usage", and Fast turns spend about 2.5x the subscription usage.

`/fast on` sends it for this session; `PI_MULTI_ACCOUNT_CODEX_FAST=1` does it for every session. Measured here on `gpt-5.6-sol` with thinking off, alternating identical prompts: 10.5s / 12.8s / 10.5s without it and 2.3s / 2.7s / 3.6s with it, and 5.8s against 2.7s for a single pair on the default websocket transport. It applies to the Codex providers only (`openai-codex`, `codex`, `codex-<account>`), so `/fast status` on another model says so and nothing changes.

The extension has to do this because pi loses the field on the way: pi-ai's `openai-codex` adapter reads `options.serviceTier` and writes it to the body, but `buildBaseOptions` rebuilds the options for `streamSimple` — the path the runtime calls — without it, so a tier set on the request options never reaches the wire ([earendil-works/pi#11040](https://github.com/earendil-works/pi/issues/11040), with a fix in [#11042](https://github.com/earendil-works/pi/pull/11042)). Setting it on the payload instead survives both. Until that lands, pi's own cost figure for a Fast turn stays at 1x while the subscription spends 2.5x — the field is also set on the options, so the figure corrects itself the day pi forwards it.

## Troubleshooting

- **`anthropic` is absent from `/model`:** add or select an account in `/accounts`, then `/reload`.
- **Deleted aliases remain:** run `/reload`; session startup removes stale `anthropic-<name>` providers.
- **`/sub-accounts` finds nothing:** confirm Claude Code is logged in and that Keychain or `~/.claude/.credentials.json` contains credentials.
- **`400 … all content must be type text if is_error is true`:** a failing tool returned an image; see [Request shaping](#request-shaping). This extension normalizes it on OAuth requests only — with a plain API key it is upstream pi-ai and unfixed.
- **Another installation rotates shared tokens:** set `PI_MULTI_ACCOUNT_BACKGROUND_REFRESH=0` on the passive installation.
- **Requests are blocked as "reverse engineering or duplicating model outputs":** retry once; if it persists across accounts, check that shaping is on (`PI_MULTI_ACCOUNT_SHAPE` is unset) and that pi or a tool has not reworded the prompt anchors (see the drift test in `test/anthropic-shape.test.ts`).
- **A pool error says it is waiting N seconds:** all accounts have failed several requests in a row; see [Pools and failover](#pools-and-failover).
- **A pool error says it could not refresh past the token endpoint:** the network, not the accounts. The endpoint was unreachable (`getaddrinfo`, connection reset) or answered `403`/`429`/`5xx`. A stored token that still has life keeps being used through it; `/accounts` only helps once it says `invalid_grant` or `401`. Check the link, then the VPN or proxy.
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
- Shared catalog/provider/gateway architecture informed by [`yetone/magpie`](https://github.com/yetone/magpie) (independently implemented here)
