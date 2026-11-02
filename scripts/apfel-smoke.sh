#!/usr/bin/env bash
# Small functional smoke tests of the apfel CLI (on-device only). Not a benchmark.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPENAFM_HOME="${OPENAFM_HOME:-$(dirname "$REPO")}"
OUT="$OPENAFM_HOME/runtime/reports/apfel-smoke-$(date +%Y%m%d-%H%M%S).txt"
SYS="$REPO/policies/AFM.md"
SCHEMA="$REPO/policies/schemas/error-report.schema.json"
FIX="$REPO/eval/fixtures/error-import.txt"

pass=0; fail=0
run() {  # run <name> <cmd...>; records latency + exit code
  local name="$1"; shift
  local t0 t1 out rc
  t0=$(python3 -c 'import time;print(time.time())')
  # stdin closed: apfel waits on an open non-TTY stdin (observed hang in non-interactive shells)
  out="$("$@" </dev/null 2>&1)"; rc=$?
  t1=$(python3 -c 'import time;print(time.time())')
  printf '\n--- %s (exit %s, %.2fs)\n%s\n' "$name" "$rc" "$(echo "$t1 - $t0" | bc)" "$out" | tee -a "$OUT"
  LAST_OUT="$out"; LAST_RC=$rc
}
check() {  # check <name> <condition-exit-code>
  if [ "$2" -eq 0 ]; then pass=$((pass+1)); echo "  PASS $1" | tee -a "$OUT"
  else fail=$((fail+1)); echo "  FAIL $1" | tee -a "$OUT"; fi
}

echo "apfel smoke $(date -Iseconds) | $(apfel --version) | $(sw_vers -productVersion) ($(sw_vers -buildVersion))" | tee "$OUT"

run "count-tokens system+fixture" apfel --count-tokens --system-file "$SYS" -f "$FIX" "Summarize this error."
check "count-tokens" "$LAST_RC"

run "plain + system-file" apfel -q --temperature 0 --max-tokens 200 --system-file "$SYS" -f "$FIX" "Summarize this error in two sentences and say how to fix it."
[ "$LAST_RC" -eq 0 ] && echo "$LAST_OUT" | grep -qi sklearn; check "plain mentions sklearn" $?

run "schema-guided JSON" apfel -q --temperature 0 --max-tokens 300 --system-file "$SYS" --schema "$SCHEMA" -f "$FIX" "Classify this error."
echo "$LAST_OUT" | python3 -c '
import json,sys
d=json.load(sys.stdin)
s=json.load(open(sys.argv[1]))
assert set(d)==set(s["required"]), d.keys()
assert d["category"] in s["properties"]["category"]["enum"]
assert d["confidence"] in s["properties"]["confidence"]["enum"]
assert isinstance(d["escalate"], bool)
print("  semantic category:", d["category"])
' "$SCHEMA" | tee -a "$OUT"
check "schema valid" "${PIPESTATUS[0]}"

# Escalation is read from a schema field. Free-text sentinels are informational only:
# "ESCALATE:" came back markdown-mangled ("ESCA**LATE**"), and NEEDS_ESCALATION is not always emitted.
TRIAGE="$REPO/policies/schemas/task-triage.schema.json"
run "triage: large task" apfel -q --temperature 0 --max-tokens 150 --system-file "$SYS" --schema "$TRIAGE" "Triage this request: Refactor our 40-file Django monolith into microservices with a migration plan."
echo "$LAST_OUT" | python3 -c 'import json,sys; assert json.load(sys.stdin)["escalate"] is True'
check "triage escalates large task" $?

run "triage: small task" apfel -q --temperature 0 --max-tokens 150 --system-file "$SYS" --schema "$TRIAGE" "Triage this request: Explain what this one-line Python function does: def sq(x): return x * x"
echo "$LAST_OUT" | python3 -c 'import json,sys; assert json.load(sys.stdin)["escalate"] is False'
check "triage keeps small task local" $?

run "sentinel (info only)" apfel -q --temperature 0 --max-tokens 120 --system-file "$SYS" "Refactor our 40-file Django monolith into microservices with a migration plan."
echo "$LAST_OUT" | grep -q "NEEDS_ESCALATION" && echo "  INFO sentinel exact" | tee -a "$OUT" || echo "  INFO sentinel not exact (expected; not gating)" | tee -a "$OUT"

echo -e "\nresult: $pass passed, $fail failed  -> $OUT" | tee -a "$OUT"
[ "$fail" -eq 0 ]
