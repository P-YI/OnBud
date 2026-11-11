# Homebrew cask for OnBud. This repository is its own tap (Homebrew reads Casks/ at the repo root):
#   brew tap p-yi/onbud https://github.com/P-YI/OnBud
#   brew trust --cask p-yi/onbud/onbud      (Homebrew 7+ loads third-party casks only once trusted)
#   brew install --cask p-yi/onbud/onbud
# apps/spotlight/scripts/release.sh updates version and sha256 for each release.
cask "onbud" do
  version "0.2.3"
  sha256 "ab9b2560fa0e4e25e723eb009d2ecf958925a35a67225a5c227de7cb73217474"

  url "https://github.com/P-YI/OnBud/releases/download/v#{version}/OnBud-#{version}.dmg"
  name "OnBud"
  desc "Spotlight-style local on-device framework for macOS"
  homepage "https://github.com/P-YI/OnBud"

  depends_on arch: :arm64
  # The core runs on these two; Homebrew installs them from their own projects.
  depends_on formula: "apfel"
  depends_on formula: "node"
  depends_on macos: :tahoe

  app "OnBud.app"

  zap trash: [
    "~/Library/Application Support/OnBud",
    "~/Library/Preferences/dev.onbud.spotlight.plist",
  ]

  caveats <<~EOS
    OnBud is not signed with a Developer ID or notarized. If macOS says it cannot verify
    the app, open System Settings > Privacy & Security and click "Open Anyway", or run:
      xattr -dr com.apple.quarantine /Applications/OnBud.app

    Then open OnBud and click "Set up OnBud…": it copies the controller to
    ~/OnBud/adaptive-coding-agent and starts apfel and the controller at login
    (it asks before each step). Apple Intelligence must be turned on.

    Uninstalling keeps ~/OnBud (controller copy, token, logs). Stop the services first:
      ~/OnBud/adaptive-coding-agent/scripts/afm-launchagent.sh uninstall agent
      ~/OnBud/adaptive-coding-agent/scripts/afm-launchagent.sh uninstall apfel
  EOS
end
