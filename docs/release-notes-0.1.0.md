# OpenAFM 0.1.0

First public release. Apple silicon, macOS 26 or later, Apple Intelligence on.

## What's in it
- **Launcher** (⌥ Space): ask about a folder, documents (PDF, Word, slides, sheets, images with OCR), code
  or git changes; answers render as Markdown with clickable links; approve or deny each command and edit.
- **On-device by default**: Apple's model through apfel; the controller listens on 127.0.0.1 only.
- **Guided setup**: installs Homebrew, apfel and Node.js only if missing, asking first; starts the
  services at login.
- **Plugins, added when you need them**: router model (Ollaya + Decima), Codex via OpenCode, web search
  (SearXNG), LaTeX (MacTeX), translation languages.
- Chat widget, chat history, attachments, Services menu "Ask OpenAFM", `openafm://` URLs, menu-bar
  activity indicator.

## Install
- Homebrew:
  ```bash
  brew tap p-yi/openafm https://github.com/P-YI/OpenAFM
  brew trust --cask p-yi/openafm/openafm      # Homebrew 7+: allow this one third-party cask
  brew install --cask p-yi/openafm/openafm
  ```
- DMG: below. The app is not signed or notarized: allow it once in System Settings > Privacy & Security > Open Anyway.

## License
MIT. Third-party notices: THIRD_PARTY_NOTICES.md. Apple's models are used under Apple's terms; see the README.
