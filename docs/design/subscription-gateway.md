# Subscription gateway architecture

The original design proposal has been superseded by the [v1 runtime and gateway guide](../gateway.md).

## Owner decisions

- Build the shared model/account/routing core, not only a static GPT-6.2 catalog patch.
- Pi TUI and pi-web can use that core as a pure extension without an HTTP service.
- The same project also provides an independent `serve` process.
- The standalone gateway must not create a Pi agent session or execute callers' tools.
- Existing account files, aliases, and Anthropic pools remain usable without destructive migration.

## Boundaries

```text
shared core (catalog / accounts / request dispatch / routes)
    ├── Pi extension adapter → /accounts, /model, route providers, optional /gateway
    └── HTTP adapter → standalone serve or an explicitly started extension-owned listener
```

The core owns discovery, credential resolution and routing. The Pi adapter owns only Pi registration,
interaction and session resources. Both entrypoints reuse the HTTP server when a listener is requested.

Magpie's separation of catalog, providers/accounts and gateway informed this boundary. Its full UI,
agent configuration management, search/media services, privacy masking and plugin marketplace are
not part of this release's gateway scope.

## Safety invariants

- Discovery caches are not credential stores or entitlement guarantees.
- Credentials are resolved per request; network refreshes serialize per account across processes.
- An invalid user configuration never becomes an empty configuration that is silently overwritten.
- Another account/target can be tried only before output is committed to the caller.
- A live listener owner is never evicted merely because a timestamp or lease expired.
- Native protocol payloads stay native where possible; unsupported translations fail explicitly.
- Caller keys are mandatory even on loopback; scopes also constrain the model list.
- No listener starts from extension loading alone.
- HTTP requests do not execute tools, inject project files, or enter an agent loop.

The guide documents actual APIs, limits, commands, storage formats and protocol exclusions. Refer to
its verification section and the executable tests rather than the former phase checklist.
