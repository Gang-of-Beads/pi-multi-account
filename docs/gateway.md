# Shared runtime and optional API gateway

The v1 runtime has two entrypoints over the same implementation:

- **Pi extension**: account providers and route models are used directly in the TUI or pi-web.
  No HTTP listener or extra agent session is needed.
- **Standalone command**: `pi-multi-account serve` exposes the same accounts and model runtime
  to API clients. It does not create a Pi agent, load a project's instructions, or execute tools.

The architecture was informed by [magpie](https://github.com/yetone/magpie): separate live model
catalogs, account providers, routing, and protocol transports. This is an independent TypeScript
implementation using pi-ai's provider and transcript contracts, not a copy of magpie's Go gateway.
It is not feature parity with magpie's desktop app, search, image generation, agent configuration,
privacy masking, or plugin marketplace.

## Installation and entrypoints

Install the package normally in Pi:

```sh
pi install npm:@gang-of-beads/pi-multi-account
```

Pure extension use remains unchanged. `/accounts` manages sign-ins, `/model` selects a named
account, and `/pma-models` explicitly refreshes model catalogs. `/routes` lists saved routes.

An npm installation also installs the `pi-multi-account` executable. For a Git/local checkout:

```sh
npm install
node bin/pi-multi-account.mjs --help
node bin/pi-multi-account.mjs serve
```

The standalone command needs the package's Pi peer dependencies installed, but does not start
Pi's TUI, session daemon, or SDK agent session. "Standalone" therefore means an independent
process, not an independent install: no Pi runs alongside it, but pi-ai must resolve and the agent
directory must be there. Account and configuration paths follow Pi's
agent directory; `--agent-dir <path>` selects another directory for the standalone command.

## Model discovery

The shared core keeps complete model records, not just context windows:

1. An account's vendor list determines its advertised model IDs.
2. Vendor metadata wins for account-specific windows, names, input modalities and reasoning levels.
3. models.dev fills in missing metadata, including prices and output ceilings.
4. Installed pi-ai definitions are a fallback when discovery is unavailable.

Unknown models do **not** borrow a sibling's price or compatibility flags. Missing prices are
represented by zero because Pi's catalog requires numeric prices; this means **unpriced**, not
free. These figures must not be used as a monetary billing guarantee. The gateway's admission
limits are token based, not dollar based.

ChatGPT's catalog is gated by the requesting Codex version. The highest valid floor from the
plugin, environment, installed CLI and the cached npm latest (or Grok stable channel) is used.
Published Codex, Claude Code and Grok versions and models.dev metadata are refreshed at most every
six hours. Account catalogs have a 15-minute freshness window. `/pma-models` forces a refresh;
normal runtime refreshes retain the last good list on errors. `PI_OFFLINE=1` prevents discovery
network traffic.

For Anthropic, the model-list endpoint may not reveal every subscription entitlement. Only IDs the
endpoint listed are offered, with models.dev enriching their metadata: a listed model is still not a
promise that the subscription is entitled to it. A failed discovery keeps the account's last good
list (or pi's built-in catalogue, which carries the Claude extras) instead of inventing IDs from
models.dev, so nothing unconfirmed appears after a 429 or an offline start.

`pi-multi-account-catalog.json` contains non-secret snapshots, keyed by hashed account identities.
The older `pi-multi-account-codex-catalog.json` window cache remains readable; no credential
migration or rewrite is required. Re-login under the same account name does not reuse an unrelated
ChatGPT account's entitlements.

Ordinary new models using an existing protocol can be discovered without a package release.
A genuinely new protocol, capability, authentication scheme or compatibility requirement still
needs an implementation update.

## Routes

```sh
pi-multi-account route add daily codex/gpt-6.2-sol xai/grok-4.7
# In Pi:
# /routes add daily codex/gpt-6.2-sol xai/grok-4.7
```

Select `pma/daily` in Pi. API clients use `"model": "daily"`.

Advanced routes live in `pi-multi-account-routes.json`:

```json
{
  "version": 1,
  "routes": [
    {
      "id": "daily",
      "mode": "order",
      "translate": true,
      "targets": [
        { "provider": "openai-codex", "account": "work", "model": "gpt-6.2-sol" },
        { "provider": "xai", "account": "*", "model": "grok-4.7" }
      ]
    }
  ]
}
```

An explicit account pins it; `"*"` expands all currently stored OAuth accounts of that provider.
A provider alias such as `codex-work` is also usable. The native `codex`/`xai` alias follows the
active named account. Providers registered by other trusted Pi extensions can be imported by the
Pi adapter; those extension-specific providers are not magically available in standalone mode.

A target may carry `:api` (`relay/model:openai-responses`) to be served on that shape whatever the provider speaks by default, and a definition's model may pin its own `api`. Nothing pinned keeps the client's protocol natively where the upstream speaks it and translates otherwise.

| Mode | First candidate |
| --- | --- |
| `order` | First configured target |
| `rotate` | Next target for each request |
| `weighted` | Weighted selection, with positive integer `weight` per target |
| `usage` | Target with the least tokens observed by this router instance |

There is no parallel hedging or answer blending. A successful conversation can stay on its target
for one hour to retain prompt caches. HTTP clients opt into that affinity with `x-session-id`;
it is namespaced by gateway key so unrelated callers cannot share affinity. Router counters and
affinity are in-memory; the usage ledger, not the scheduling counter, is durable.

Only retryable failures before output can move to the next target: transport/setup failures,
401/403/404/408/429, 5xx, or an unsuccessful 200 stream. A 400 validation error is not retried.
When every target fails, the caller gets the last failure's own status where it is meaningful, so an
upstream 429 stays a 429 with its `Retry-After` rather than turning into a 502.
Once content has been sent, failure ends that stream; it never silently replays on another account.
Aborts propagate upstream and release admission reservations.

Routes are re-read for each HTTP request. Changes affect new calls; in-flight calls keep their
snapshot. Invalid configuration fails closed and is not overwritten as an empty configuration.
Legacy Anthropic `/pool-*` commands and stored pool definitions remain compatible; new cross-
provider groups use routes rather than changing the old pool file's schema.

## HTTP lifecycle

From Pi:

```text
/gateway key laptop daily
/gateway start 8787
/gateway status
/gateway stop
```

A new key is shown only in a private editor dialog, not added to the chat. A listener started by
this extension instance stops when its Pi session shuts down or reloads. Other sessions do not
silently inherit or stop that listener.

For a service independent of any chat session:

```sh
pi-multi-account key create laptop daily > /path/to/private-key-file
pi-multi-account serve --host 127.0.0.1 --port 8787
```

Protect any file you choose to redirect the secret into (`umask 077`). The command prints the
secret once; the gateway's own key database stores only its SHA-256 hash. Do not paste OAuth
credentials or caller keys into agent chats. Use your own user service supervisor for automatic
startup. Installing the extension never starts a service automatically.

A live PID owns the listener's agent directory. Another process cannot take it over because a
timestamp expired, even on another port. SIGINT/SIGTERM close a standalone listener. After a
crash, only a verifiably dead owner on this host can be replaced. Unverifiable ownership requires
manual inspection; do not remove a live owner's metadata.

Binding another explicit IP is an opt-in. There is no built-in TLS termination: use a trusted TLS
reverse proxy or private tunnel when sharing beyond loopback. Browser Origin requests and CORS
are disabled by default. Do not expose this gateway publicly without a separate security review.

## API and caller keys

- `GET /healthz`: minimal unauthenticated health result.
- `GET /v1/models`: only model/route IDs the caller may use.
- `POST /v1/messages`: Anthropic Messages.
- `POST /v1/chat/completions`: OpenAI Chat Completions.
- `POST /v1/responses`: OpenAI Responses.
- `GET /stats`: bounded recent usage and admission state; admin key required.

Send a caller key using `Authorization: Bearer <key>` or `x-api-key: <key>`. Conflicting headers
are refused. Caller credentials are never sent to the upstream provider. Keys can be scoped to
exact model or route IDs; `"*"` explicitly grants all currently available IDs. `/v1/models` also
lists permitted direct `provider/model` IDs.

```sh
pi-multi-account key list
pi-multi-account key revoke <id>
```

Key metadata is in `pi-multi-account-gateway.json`. Optional positive integer fields are `rpm`,
`dailyTokens`, `maxConcurrent` (default 4), and `expires` (Unix milliseconds); `admin` grants stats
access, not an HTTP configuration mutation API. Edit limits locally. Revocation and scope changes
are read on each new request. Existing streams are not retroactively revoked.

Daily admission is UTC based and includes conservative reservations for in-flight calls. Usage
reported by providers replaces the reservation at completion. Unknown/failed usage is charged as
an **estimated** reservation rather than silently counted as zero. Estimates can overcount; these
are admission controls, not a precise subscription quota meter or an absolute vendor spending cap.
RPM and daily totals are restored from `pi-multi-account-usage.jsonl` on startup. Provider billing
and subscription quota windows remain the source of truth. The ledger records IDs/counts/status,
not prompts, tool arguments, provider responses or credentials.

## Protocol fidelity and limitations

A matching protocol is relayed without normalizing the conversation. Opaque thinking, native
tools and provider-specific fields can therefore survive. A subscription backend can still require
small provider-specific adjustments: Claude OAuth billing/identity, Grok's client-version header,
and Codex's streamed stateless request contract. Native passthrough is not a promise that any
arbitrary provider accepts another provider's private fields.

A cross-protocol request is decoded into pi-ai's transcript and streamed through its provider
implementation, then encoded back into the requested public protocol. Text, inline base64 image
input, function calls/results, basic reasoning effort and usage are supported. Tools are only
serialized: **the server never executes a client's tools or local shell commands**.

Set `"translate": false` on a route to require a matching wire protocol. Direct model IDs allow
translation by default. Unsupported translated requests return an explicit 400 rather than
silently losing data. In particular:

- stateful/background Responses and opaque/encrypted reasoning need native Responses;
- signed Anthropic thinking needs native Messages;
- remote image URLs and provider file IDs need a native route (the gateway will not fetch
  arbitrary client URLs);
- native server tools, forced tool choices, structured output and unsupported extra fields
  need a native route;
- translated requests are not an implementation of Responses conversation storage, WebSockets,
  Realtime, embeddings, image generation or Gemini's public HTTP API.

Messages, Chat and Responses all have streaming and non-streaming output. A stream failure after
output is signalled on that stream, never converted into a new HTTP success containing a replay.
Keep the service on a private interface until your client/protocol combination has been tested.
Subscription terms, permissions and upstream protocol changes still apply.

## Development map

- `src/core/catalog.ts`: vendor discovery, metadata, version and disk cache.
- `src/core/engine.ts`: account providers and credential-resolved model calls.
- `src/core/routes.ts`: scheduling, affinity, pre-output failover and route storage.
- `src/pi-adapter.ts`: Pi provider registration, commands, watches and optional listener ownership.
- `src/gateway/`: HTTP auth/admission, protocol decoding/encoding, native transport and listener.
- `src/cli.ts`, `bin/pi-multi-account.mjs`: independent command entrypoint.

```sh
npm run check
npm test
npm run test:gateway
```

The checked tests use temporary data directories, stub upstreams and real loopback sockets. Live
subscription checks must be run separately; passing a stubbed wire test does not establish vendor
entitlement or full compatibility with a third-party agent.
