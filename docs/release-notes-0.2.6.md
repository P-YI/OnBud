# OnBud 0.2.6

A minor update to 0.2.5 (2026-11-17): stop and undo. Apple silicon, macOS 26 or later, Apple Intelligence on.

## Changes
- **Stop** (button or ⌘.): the request ends at once. Running tools are stopped and on-device or web calls are
  cancelled; nothing is left waiting, and the next question goes through right away.
- **Undo** (button, ⇧⌘Z, or "되돌려줘" / "undo"): undoes the last conversion, applied edit, applied local job, or a
  Mac action that has an opposite (dark mode, volume, mute, Wi-Fi, Bluetooth, hidden files). A file is restored
  only when it is exactly as OnBud left it (SHA-256); if you changed it since, you choose: restore anyway, keep
  your version and take the old one out as "(before OnBud)", or leave it. Files OnBud made are moved into the
  undo record, never deleted. Records are kept 14 days in `~/OnBud/runtime/undo`. Approvals of commands that
  cannot be undone say so.
- **Atomic outputs:** conversions are written to a hidden temporary file and appear only when complete; a new
  file never overwrites an existing one.
- **Launcher:** Stop and Undo buttons. If the project folder was deleted, the panel switches to Desktop with a
  notice (it used to show only "Commands"). At most three quick-action chips; the rest are under **More**.

Measured: npm test 242/242, skill eval 63/63.

## Upgrade
Homebrew: `brew upgrade --cask onbud`. DMG: replace OnBud.app with the one below, then Settings > Backend >
**Update…** to copy the new controller. Upgrading from 0.1.0 (then called OpenAFM): see the 0.2.0 release notes.

## License
MIT. Third-party notices: THIRD_PARTY_NOTICES.md.
