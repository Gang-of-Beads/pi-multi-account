#!/bin/bash
# Isolated regression for the codex alias bridge (codex-aliases.ts), which arrived here
# from the standalone codex-accounts extension. pi 1.1.0 in a container, fixture HOME,
# plugin loaded explicitly: nothing here touches the host's store, settings or extensions.
#
# What it pins down: a codex login/removal that lands in the shared store *while a
# session runs* must show up in that session, because /accounts usually runs in another
# session and the refresh sweep rewrites the file underneath a live one.
set -u
export HOME=/home/pitest
export PI_CODING_AGENT_DIR=/home/pitest/.pi/agent
cd "$HOME"

PMA=/opt/plugins/pi-multi-account/src/index.ts
PROBE=/opt/plugins/probe.ts
prompt='Use the bash tool exactly once to run `ls /` and then reply with the single word done.'

fail=0
set_codex() { # $1 = none | one | two
  MODE="$1" python3 - <<'PY'
import json, os
p = '/home/pitest/.pi/agent/pi-accounts.json'
s = json.load(open(p)); s['providers'].pop('openai-codex', None)
account = lambda: {'type': 'oauth', 'access': 'fake-access-token', 'refresh': 'fake-refresh', 'expires': 4102444800000}
if os.environ['MODE'] == 'one':
    s['providers']['openai-codex'] = {'active': 'work2', 'accounts': {'work2': account()}}
elif os.environ['MODE'] == 'two':
    s['providers']['openai-codex'] = {'active': 'work2', 'accounts': {'work2': account(), 'work3': account()}}
json.dump(s, open(p, 'w'), indent=1)
PY
}

run() { # $1 label, $2 store, $3 mutation, $4 required aliases at the last observation (comma list, or NONE)
  local label="$1" store="$2" mutate="$3" expect="$4"
  set_codex "$store"; rm -f /tmp/probe.log
  PROBE_MUTATE="$mutate" PROBE_LOG=/tmp/probe.log \
    pi -p -e "$PMA" -e "$PROBE" --no-extensions --session-dir "/tmp/s-$label" \
       --model botim-bllm/deepseek-v4.1-flash --thinking off "$prompt" >/tmp/pi-$label.out 2>&1
  local code=$?
  local first last firstActive lastActive
  read -r first last firstActive lastActive <<<"$(python3 - <<'PY'
import json
rows=[json.loads(l) for l in open('/tmp/probe.log') if l.strip() and '"providers"' in l]
names=lambda r: ','.join(r.get('codex') or []) or 'NONE'
print(names(rows[0]), names(rows[-1]), rows[0].get('active') or 'NONE', rows[-1].get('active') or 'NONE')
PY
)"
  local verdict=PASS
  # empty last => python failed (missing/empty probe.log, no "providers" row, log drift): a dead probe must not pass
  [ -z "$last" ] && verdict=FAIL
  # `first` is recorded on turn 1 before the debounced/polled resync can fire, so it
  # reflects the store the session started with; `last` reflects post-mutation state.
  local wantFirst=present
  [ "$store" = none ] && wantFirst=absent
  case "$wantFirst" in
    present) [ "$first" = "NONE" ] && verdict=FAIL ;;
    absent)  [ "$first" != "NONE" ] && verdict=FAIL ;;
  esac
  # `expect` is the alias set that must be visible at the last observation, or NONE.
  # Naming the ids matters: with only "present", a scenario that gains work3 would still
  # pass while the session kept showing the alias set it started with.
  local want
  for want in ${expect//,/ }; do
    if [ "$want" = NONE ]; then
      [ "$last" = "NONE" ] || verdict=FAIL
    else
      case ",$last," in *",$want,"*) ;; *) verdict=FAIL ;; esac
    fi
  done
  # An exit code other than 0 means the session itself broke, which is a failure too.
  [ "$code" -ne 0 ] && verdict=FAIL
  [ "$verdict" = FAIL ] && fail=1
  printf '%s  %-26s exit %s  aliases first[%s] last[%s]  active first[%s] last[%s]\n' "$verdict" "$label" "$code" "$first" "$last" "$firstActive" "$lastActive"
  local warn
  warn=$(grep -iE "codex|not loaded" /tmp/pi-$label.out | head -2)
  [ -n "$warn" ] && printf '       %s\n' "$warn"
}

echo "== control: account present at session start, nothing changes"
run control one none codex,codex-work2
echo "== the reported bug: a login lands while the session runs"
run login-mid-session none add codex,codex-work2
echo "== the account is removed while the session runs"
run logout-mid-session one remove NONE
echo "== the active account switches while the session runs"
run switch-active one switch codex-work3
echo
[ "$fail" -eq 0 ] && echo "ALL SCENARIOS PASS" || { echo "SCENARIO FAILURES"; exit 1; }
