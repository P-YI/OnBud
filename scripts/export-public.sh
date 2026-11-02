#!/usr/bin/env bash
# Copies the public OpenAFM tree (tracked files at HEAD, minus internal notes) into <dest>, for the public
# repository, which keeps its own history. Internal step reports and benchmark logs stay
# in this repository; docs/OVERVIEW.md and docs/BENCHMARKS.md summarize them.
#   scripts/export-public.sh <dest>     (dest must not exist, or be an earlier export: its .git is kept)
set -eu
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?usage: export-public.sh <dest>}"
KEEP_DOCS='^docs/(OVERVIEW|BENCHMARKS|DEVELOPMENT)\.md$|^docs/release-notes-.*\.md$|^docs/assets/'
mkdir -p "$DEST"
find "$DEST" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$SRC" ls-files -z | tr '\0' '\n' \
  | grep -v -E '^docs/' | cat - <(git -C "$SRC" ls-files docs | grep -E "$KEEP_DOCS") \
  | (cd "$SRC" && rsync -a --files-from=- ./ "$DEST/")
echo "exported $(cd "$DEST" && find . -type f ! -path './.git/*' | wc -l | tr -d ' ') files to $DEST"
