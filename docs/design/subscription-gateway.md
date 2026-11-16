# Subscriptions as an API

Status: design, not implemented. Owner asked for it 2026-11-14; nothing here is
committed code yet.

## The ask

Subscriptions and logged-in accounts (Claude OAuth, SuperGrok / X Premium, ChatGPT Codex,
GitHub Copilot) and configured endpoints should be reachable over HTTP the way an LLM
gateway serves them, with policy on top: aggregation, a fallback chain, per-caller keys.

Today they are only reachable from inside pi. The pool feature already rotates and fails
over across accounts of one provider; the gateway generalises that from "a provider inside
pi" to "an endpoint for other clients".

## What already exists, and what is missing

| Piece | State |
| --- | --- |
| Named OAuth accounts per provider | yes — `pi-accounts` store, `/accounts` (anthropic, openai-codex, github-copilot) |
| Per-request credential resolve | yes — `pool.ts` `resolveAccount`, refreshes under the store lock |
| Failover with reasons and stall pacing | yes — but the pool is hardcoded to `anthropic` |
| Anthropic request shaping + billing header | yes — irrelevant to other providers, keeps working per target |
| Caller-facing listener, keys, model mapping | **missing** |
| OpenAI-shaped endpoints and shape translation | **missing** |
| Quotas, per-key scopes, accounting | **missing** |
| xAI / Grok subscription | **missing from pma** — implemented in pi-ai (`xai` provider, device-code OAuth, refresh); needs an adapter, aliases and a generic pool |
| `/accounts` aggregation step | **missing** — asked for; small (`pools-store` + one menu action) |

The hardcoded `anthropic` in `pool.ts` is the first thing to lift: routes span providers, so
the pool becomes a provider-agnostic route runtime the gateway and the picker both use.

## Shape of the design

```
routes.json                      # the only new user-facing config
{
  "version": 1,
  "routes": [
    {
      "id": "claude",            # also the public model name
      "kind": "chain",           # chain | fanout
      "targets": [
        { "provider": "anthropic", "model": "claude-opus-5-5", "weight": 1 },
        { "provider": "xai",       "model": "grok-4",         "weight": 1 }
      ],
      "limits": { "perKeyRpm": 30, "perKeyDailyTokens": 2000000 }
    }
  ]
}
```

- **`chain`** — try targets in order; a retryable status or a failed stream moves to the
  next one. This is the fallback chain, and the existing pool semantics, generalised.
- **`fanout`** — pick one target per request by weight, round-robin within a key's session so
  a conversation stays on one account. Aggregation without a merge: no double billing, no
  output blending.
- Stats feed the picker: a target that keeps failing is paced out exactly like a pool account
  is today (`poolStallPauseMs`).

### Inbound

Two families, passthrough first:

- `POST /v1/messages` (Anthropic shape) — for Claude Code and anything Anthropic-native.
- `POST /v1/chat/completions`, `POST /v1/responses` (OpenAI shape) — for the long tail.
- `GET /v1/models` — the routes that key may use, in OpenAI's list shape.
- `GET /healthz`, plus `/stats` behind an admin key.

Passthrough rule: when the inbound family matches the target's API family, the body is
forwarded with the target's credentials and headers unchanged (only the model name is
rewritten). Translation happens only on a cross-family target, and a translation failure is
a target failure, not a request failure.

Translation cost is real: thinking blocks, tool schemas and image parts do not survive a
round trip. So the default route keeps one family end to end, and cross-family is opt-in per
target (`"translate": true`).

### Caller auth

- Keys minted by the extension: `pmak_<id>_<secret>`, stored hashed (SHA-256) in
  `~/.pi/agent/pi-multi-account-gateway.json`, scopes per route, optional expiry.
- `Authorization: Bearer …` on every request, `x-api-key` accepted for Anthropic clients.
- Bind `127.0.0.1` by default; `PI_MULTI_ACCOUNT_GATEWAY_BIND` opts into a LAN address.
- Tokens never logged; account fingerprints only, like the rest of the extension.

### Ownership

One process owns the listener. Claiming is a lock file with the owning pid next to the port
file; a second process that wants it either respects the owner or takes over after a stale
lease (10 minutes). `pi-web` and the CLI therefore cannot silently serve two different route
tables. Restart-safe: the socket is closed on `session_shutdown` unless `serve --detached`
owns it under its own supervisor.

### Accounting

Usage comes back on the stream; the gateway records per key, route and target in a JSONL
ledger, and enforces the route limits before the request. Subscription windows (Anthropic
5h/7d, xAI rates) are already probed by the extension for the footer; the gateway reuses
those probes as pacing input, not as hard caps — the provider is the source of truth.

### Where it runs

`pi-multi-account serve [--port 8787]` as a CLI subcommand, started under the same user
supervisor the rest of the machine uses. Not inside the TUI: a gateway that dies with the
editor is a toy, and pi-web's daemon restarts would drop every client.

## Phases

0. **Small, now.** `/accounts` gains "Add account to a pool"; `pool.ts` loses the
   `anthropic` hardcode (provider comes from the definition); xAI adapter, aliases and
   `pi auth login xai` import so a Grok subscription is usable in pi first.
1. **Listener.** `serve`, route table, caller keys, `/v1/models`, Anthropic passthrough of a
   single-target chain. Enough for Claude Code against a local route.
2. **Policy.** Multiple targets, weights, fanout, stall pacing, per-key limits, ledger.
3. **Translation.** OpenAI-shaped inbound and cross-family targets, with the fidelity tests
   they need.

## Risks

- **Terms.** Subscription OAuth from a non-vendor client is the same bet the shaping work
  already makes for Anthropic; xAI publishes no third-party client policy that we found, so
  phase 0 verifies a Grok turn end to end before anything is promised.
- **Shape drift.** Translation breaks silently when a provider adds a field. Family-matched
  routes avoid it; that is why they are the default.
- **Double spend.** A route that includes the same account the editor uses shares the
  subscription window; the ledger has to attribute both, or the user cannot tell why a limit
  hit.
- **Port and lease bugs** are the boring failure that makes a gateway untrustworthy; the
  lease is phase 1, not an afterthought.

## Verification plan

- Claude Code pointed at `127.0.0.1:<port>` with a minted key and one route: a real turn.
- Kill the account's token mid-run: the chain moves, the client sees no error.
- 20 concurrent streams; abort one mid-stream and assert the account returns to the pool.
- Route table edited while serving: reload without dropping in-flight requests.
- Assert no token ever reaches the log, and `/v1/models` never lists a route a key cannot use.
