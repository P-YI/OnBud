#!/usr/bin/env bash
# Optional: install SearXNG (open-source metasearch, AGPL) for the AFM web-search tool, in a private
# venv under ~/OnBud/runtime/searxng, bound to 127.0.0.1:8888 only. Without it the tool falls back to
# DuckDuckGo Lite + arXiv + Wikipedia. Run it yourself (it downloads code from GitHub and PyPI).
#   scripts/searxng-setup.sh install   → clone + venv + settings (~150 MB)
#   scripts/searxng-setup.sh start     → run in the background (tmux -L onbud, session "searxng")
#   scripts/searxng-setup.sh stop | status
set -eu
D="${ONBUD_HOME:-$HOME/OnBud}/runtime/searxng"
PY="${PYTHON:-$(ls -d "$HOME"/.local/share/uv/python/cpython-3.1[0-9]*/bin/python3 2>/dev/null | tail -1)}"
case "${1:-status}" in
  install)
    [ -x "$PY" ] || { echo "need Python >= 3.10 (set PYTHON=...)"; exit 1; }
    mkdir -p "$D"; cd "$D"
    [ -d src ] || git clone --depth 1 https://github.com/searxng/searxng.git src
    [ -x venv/bin/python ] || "$PY" -m venv venv
    # Same order as SearXNG's own utils/searxng.sh: setup.py imports searx, which needs these first.
    venv/bin/pip install -q -U pip setuptools wheel pyyaml msgspec typing-extensions pybind11
    venv/bin/pip install -q -r src/requirements.txt
    (cd src && ../venv/bin/pip install -q --use-pep517 --no-build-isolation -e .)
    KEY="$(openssl rand -hex 32)"
    umask 077
    cat > settings.yml <<YML
use_default_settings: true
general: { instance_name: "onbud-local" }
server: { bind_address: "127.0.0.1", port: 8888, secret_key: "$KEY", limiter: false, image_proxy: false }
search: { formats: [html, json], safe_search: 0 }
YML
    echo "installed in $D"; du -sh "$D" ;;
  start)
    tmux -L onbud new-session -d -s searxng -c "$D/src" "SEARXNG_SETTINGS_PATH=$D/settings.yml $D/venv/bin/python -m searx.webapp"
    sleep 3; curl -s -m 3 http://127.0.0.1:8888/healthz && echo " searxng up" ;;
  stop) tmux -L onbud kill-session -t searxng ;;
  status) curl -s -m 2 http://127.0.0.1:8888/healthz && echo " running" || echo "not running" ;;
esac
