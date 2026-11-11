# OnBud 0.2.3

A minor update to 0.2.2 (2026-11-11): work where your path points. Apple silicon, macOS 26 or later, Apple
Intelligence on.

## Changes
- **Paths set the work folder.** Name a file or folder by its path (absolute or `~/`, spaces, quotes and Korean
  particles included) and every skill works there, even when the panel has another folder open (Desktop, say).
  Commands, edits, local jobs and hand-offs you approve then run in that folder.
- **Safe by default:** paths stay inside your home folder, hidden folders are never used, and the security gate
  checks every file. Keys, `.pem` and `.env` files are refused (`path_blocked`); a path that does not exist is
  reported as not found (`path_not_found`).
- **LaTeX:** the `.tex` you name is the one compiled, also outside the open folder. Citations and labels are
  checked only over that document's own files (the main file, its `\input` / `\include` / `\subfile`
  files and its bibliography), so other projects no longer produce false duplicates. With several LaTeX
  documents in a personal folder and none named, OnBud asks which one.
- **Translation:** the target language is the one marked as the target ("영어에서 한국어로", "from English into
  Korean"), even when the source language comes first; output that only echoes the request is rejected.

Measured: npm test 216/216, skill eval 55/55.

## Upgrade
Homebrew: `brew upgrade --cask onbud`. DMG: replace OnBud.app with the one below, then Settings > Backend >
**Update…** to copy the new controller. Upgrading from 0.1.0 (then called OpenAFM): see the 0.2.0 release notes.

## License
MIT. Third-party notices: THIRD_PARTY_NOTICES.md.
