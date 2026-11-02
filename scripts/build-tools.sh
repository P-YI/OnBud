#!/usr/bin/env bash
# Build small native helpers into ../runtime/bin (outside git). Needs Command Line Tools (swiftc).
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OPENAFM_HOME:-$(dirname "$REPO")}/runtime/bin"
mkdir -p "$OUT"
swiftc -O -o "$OUT/pdftext" "$REPO/tools/pdftext/main.swift" -framework PDFKit -framework Vision -framework AppKit
echo "built $OUT/pdftext"
