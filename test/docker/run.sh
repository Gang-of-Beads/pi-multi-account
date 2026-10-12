#!/bin/bash
# Runs the codex alias regression in an isolated container.
#
# Everything the container reads is staged from the host at build time and baked into the
# image: this repository, a probe, and a fixture HOME holding the host's models.json and
# auth.json plus a copy of the account store. Nothing writes back, so a refresh inside the
# container cannot rotate the host's tokens away, and the host's other extensions,
# settings and MCP servers are absent.
#
# Usage: test/docker/run.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/home/.pi/agent" "$stage/plugins"

rsync -a --exclude .git --exclude 'test/docker' --exclude test-results "$repo/" "$stage/plugins/pi-multi-account/"
cp "$here/probe.ts" "$here/entrypoint.sh" "$stage/plugins/"
cp "$here/Dockerfile" "$stage/"
cp "$agent_dir/models.json" "$stage/home/.pi/agent/models.json"
cp "$agent_dir/auth.json" "$stage/home/.pi/agent/auth.json"

# The store is copied with the codex provider REMOVED: each scenario decides which
# accounts exist, so the host's own logins cannot leak in.
STORE="$agent_dir/pi-accounts.json" OUT="$stage/home/.pi/agent/pi-accounts.json" python3 - <<'PY'
import json, os
store = json.load(open(os.environ["STORE"]))
store["providers"].pop("openai-codex", None)
json.dump(store, open(os.environ["OUT"], "w"), indent=1)
json.dump({"model": {"provider": "botim-bllm", "id": "deepseek-v4.1-flash"}},
          open(os.path.join(os.path.dirname(os.environ["OUT"]), "settings.json"), "w"), indent=1)
PY

export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
docker build -q -t pi-multi-account-codex-test "$stage" >/dev/null
docker run --rm -t pi-multi-account-codex-test
