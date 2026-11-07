#!/usr/bin/env bash
# Builds a release: the DMG (make dmg) and its sha256, and writes version and sha256 into the Homebrew cask
# (Casks/onbud.rb at the repository root; the repository is its own tap). Publishing stays manual: the
# commands are printed, nothing is pushed or uploaded.
#   scripts/release.sh            (GITHUB_REPO=owner/name to override P-YI/OnBud)
set -eu
cd "$(dirname "$0")/.."
REPO_SLUG="${GITHUB_REPO:-P-YI/OnBud}"
VERSION="$(plutil -extract CFBundleShortVersionString raw Resources/Info.plist)"
make dmg
DMG="build/OnBud-$VERSION.dmg"
SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
CASK="../../Casks/onbud.rb"
sed -i '' -e "s/^  version \".*\"/  version \"$VERSION\"/" -e "s/^  sha256 \".*\"/  sha256 \"$SHA\"/" "$CASK"
ruby -c "$CASK" >/dev/null
cat <<MSG

Release v$VERSION
  DMG:    apps/spotlight/$DMG
  sha256: $SHA   (written to Casks/onbud.rb)

Publish (manual, from the public repository):
  git commit -am "Release $VERSION" && git tag v$VERSION && git push --follow-tags
  gh release create v$VERSION apps/spotlight/$DMG --repo $REPO_SLUG --title "OnBud $VERSION" --notes-file docs/release-notes-$VERSION.md
  brew tap p-yi/onbud https://github.com/$REPO_SLUG && brew trust --cask p-yi/onbud/onbud && brew install --cask p-yi/onbud/onbud    # check it
MSG
