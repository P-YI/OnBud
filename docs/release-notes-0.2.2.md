# OnBud 0.2.2

A minor update to 0.2.1 (2026-11-10): everyday requests. Apple silicon, macOS 26 or later, Apple Intelligence on.

## Changes
- **System Settings panes open directly** ("open the VPN settings", "설정 앱의 VPN 항목 열어줘"; 36 panes). A
  request for a Wi-Fi password opens the Wi-Fi pane; the Keychain is never read.
- **Codex usage:** your Codex limits and when they reset, read from the Codex CLI's own session logs (only their
  `rate_limits` lines).
- **Quick answers by code** (new `quick_answer` in the mac skill): time and dates, arithmetic, percentages, unit
  conversions, macOS shortcuts and the local IP, exact and without a model call.
- A general question asked from a personal folder (Desktop or home) is answered as chat, not from unrelated
  documents in that folder.
- Short translations are more accurate (the reply's script is checked).
- Lists of one file type ("PDF 목록") are faster: only that type, without per-file descriptions.
- Routing fixes: a quoted "help" no longer opens help; an English sentence is not taken for a command; how-to
  questions never change Mac settings; "how many Copilot requests are left" reads usage; "what can OnBud do"
  opens help.

Measured: npm test 211/211, skill eval 55/55 (mac +6 and core +3 cases).

## Upgrade
Homebrew: `brew upgrade --cask onbud`. DMG: replace OnBud.app with the one below, then Settings > Backend >
**Update…** to copy the new controller. Upgrading from 0.1.0 (then called OpenAFM): see the 0.2.0 release notes.

## License
MIT. Third-party notices: THIRD_PARTY_NOTICES.md.
