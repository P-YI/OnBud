# OnBud 0.2.7

A minor update to 0.2.6 (2026-11-25): updates. Apple silicon, macOS 26 or later, Apple Intelligence on.

## Changes
- **Update check, with your consent.** OnBud asks once whether it may check for updates. If you allow it, it asks
  GitHub once a day for the latest release (one request to api.github.com; nothing about you or your files is
  sent). Settings > Updates has the switch and **Check now**.
- **Update on your click.** A new version is announced once, with what changed; Settings keeps an **Update…**
  button. The update runs in Terminal: with Homebrew if you installed with it, otherwise by downloading the
  release DMG, checking it against the SHA-256 published in the cask (a mismatch installs nothing), replacing
  the app (the previous copy goes to the Trash) and reopening OnBud.
- **Controller update offered** on the first launch after an update, when the installed controller is older.
- Folder search for terminal requests ("docs 폴더에서 터미널 열어줘") looks in the project and the folders you
  name before your home folder, so it no longer waits on macOS folder-access prompts.

Measured: npm test 242/242, skill eval 63/63.

## Upgrade
This is the last update you install by hand: Homebrew `brew upgrade --cask onbud`, or the DMG below, then
Settings > Backend > **Update…**. From 0.2.7 on, OnBud offers updates itself once you allow the check.
Upgrading from 0.1.0 (then called OpenAFM): see the 0.2.0 release notes.

## License
MIT. Third-party notices: THIRD_PARTY_NOTICES.md.
