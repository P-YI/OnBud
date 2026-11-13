# OnBud 0.2.4

A minor update to 0.2.3 (2026-11-13): do, don't describe. Apple silicon, macOS 26 or later, Apple Intelligence on.

## Changes
- **Mac actions in plain English are carried out**, not explained: "Open the setting app and show bluetooth
  setting", "Could you open Notes for me?", "get Xcode running". Polite wording and compound requests are
  understood.
- **More Mac actions:** volume up/down/min/max, brightness, lock screen, Wi-Fi on/off, Bluetooth (with
  `blueutil` or through its settings pane), empty the Trash, show or hide hidden files in Finder, quit an app,
  open Finder folders, "check for macOS updates". Anything that changes the Mac waits for your approval.
- **Beyond the listed actions, still local:** the on-device model picks one of about 30 vetted recipes (timers,
  alarms, reminders, notes, notifications, music, mail drafts, lookups, …); code checks the values it fills in
  and builds the command, and clock times are computed by code. When no recipe fits, the on-device model writes
  one command; it must pass `bash -n` / `osacompile` and the security gate. Read-only commands run, anything else
  is shown as written by the on-device model and waits for your yes.
- **Missing shortcuts:** a Shortcut you do not have opens a search in the Shortcuts Gallery, with similar
  shortcuts you have and what OnBud can do instead.
- **Fixed:** approving dark mode (and other Mac actions) asked for the same approval again; an approved action now
  shows its result.
- For development: `ONBUD_DRY_ACTIONS=1` describes Mac actions instead of running them (probes and evals).

## Known limit
- Asking about the front app or the open apps uses System Events, so macOS asks once whether OnBud may control
  System Events (Automation permission).

Measured: npm test 227/227, skill eval 61/61.

## Upgrade
Homebrew: `brew upgrade --cask onbud`. DMG: replace OnBud.app with the one below, then Settings > Backend >
**Update…** to copy the new controller. Upgrading from 0.1.0 (then called OpenAFM): see the 0.2.0 release notes.

## License
MIT. Third-party notices: THIRD_PARTY_NOTICES.md.
