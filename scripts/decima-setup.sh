#!/usr/bin/env bash
# Decima (decima:agent, ~321M decision encoder, ~1.3 GB fp32, Apache-2.0 model; some training data CC BY-NC)
# served by Ollaya (Apache-2.0) for the OnBud router. Everything stays under ~/OnBud/runtime/ollaya
# (binary) and ~/.ollaya (models); no sudo, no system service, loopback only, port 11436
# (11435 is the AFM agent server). Run the steps yourself: they download code and weights.
#   scripts/decima-setup.sh install   → Ollaya via its official installer, into ~/OnBud/runtime/ollaya
#   scripts/decima-setup.sh pull      → decima:agent weights (~1.3 GB), pinned to the version the routing
#                                       thresholds were calibrated on (policies/routing.yaml decima_model_digest)
#   scripts/decima-setup.sh start     → `ollaya serve` on 127.0.0.1:11436 in tmux (-L onbud, session "ollaya")
#   scripts/decima-setup.sh test | status | stop | uninstall
set -eu
PREFIX="${ONBUD_HOME:-$HOME/OnBud}/runtime/ollaya"
BIN="$PREFIX/bin/ollaya"
export OLLAYA_HOST=127.0.0.1:11436     # every CLI call must carry this, or the CLI would start a server on 11435
URL="http://$OLLAYA_HOST"
# Full digest of the calibrated decima:agent (routing-v0.8). A moved library tag would otherwise give new users
# another version, which the controller only runs in shadow. DECIMA_DIGEST=latest pulls the current tag instead.
DECIMA_DIGEST="${DECIMA_DIGEST:-sha256:e14e614ce4ab1ae2e7a0f1203b91e4d38fb645d100202726abe59f78e2c0077b}"
case "${1:-status}" in
  install)
    tmp="$(mktemp -d)"; curl -fsSL https://ollaya.dev/install.sh -o "$tmp/install.sh"
    echo "installer sha256: $(shasum -a 256 "$tmp/install.sh" | cut -c1-16)…  (read it: $tmp/install.sh)"
    OLLAYA_INSTALL_DIR="$PREFIX" OLLAYA_NO_SERVICE=1 OLLAYA_NO_CUDA=1 OLLAYA_NO_ROCM=1 sh "$tmp/install.sh"
    "$BIN" --version ;;
  pull)
    if [ "$DECIMA_DIGEST" = latest ]; then "$BIN" pull decima:agent; else "$BIN" pull "decima:agent@$DECIMA_DIGEST"; fi
    du -sh "$HOME/.ollaya" 2>/dev/null || true ;;
  start)
    curl -s -m 2 "$URL/api/tags" >/dev/null && { echo "already running on $OLLAYA_HOST"; exit 0; }
    tmux -L onbud new-session -d -s ollaya "OLLAYA_HOST=$OLLAYA_HOST '$BIN' serve"
    for _ in 1 2 3 4 5 6 7 8 9 10; do sleep 1; curl -s -m 2 "$URL/api/tags" >/dev/null && { echo "ollaya up on $OLLAYA_HOST"; exit 0; }; done
    echo "ollaya did not come up; see: tmux -L onbud attach -t ollaya"; exit 1 ;;
  test)
    curl -s -m 30 "$URL/api/decide" -H 'Content-Type: application/json' -d '{"model":"decima:agent","state":"request: refactor the whole repository into separate packages and update all imports","questions":{"route":{"type":"choice","instructions":"Which handler should take this coding-assistant request?","criteria":{"LOCAL_AFM":"small on-device model: question or one-file change","FRONTIER_GPT":"strong cloud coding model: multi-file change, design, hard debugging","ASK_USER":"ambiguous or risky"}},"destructive":{"type":"noul","instructions":"The request asks to delete data or run a destructive command."}}}' | python3 -m json.tool ;;
  status) curl -s -m 2 "$URL/api/tags" && echo || echo "not running ($OLLAYA_HOST)" ;;
  stop)   tmux -L onbud kill-session -t ollaya 2>/dev/null || true; pkill -f "$BIN serve" 2>/dev/null || true ;;
  uninstall)
    "$0" stop; rm -rf "$PREFIX"; echo "removed $PREFIX (models kept in ~/.ollaya; delete with: rm -rf ~/.ollaya)" ;;
  *) echo "usage: $0 install|pull|start|test|status|stop|uninstall"; exit 2 ;;
esac
