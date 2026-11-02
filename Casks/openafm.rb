# Homebrew cask for OpenAFM. This repository is its own tap (Homebrew reads Casks/ at the repo root):
#   brew tap p-yi/openafm https://github.com/P-YI/OpenAFM
#   brew install --cask openafm
# apps/spotlight/scripts/release.sh updates version and sha256 for each release.
cask "openafm" do
  version "0.1.0"
  sha256 "732eb7e7827bc75f9add2eb648cf88228f7adfb0285843acf531174e973e83e8"

  url "https://github.com/P-YI/OpenAFM/releases/download/v#{version}/OpenAFM-#{version}.dmg"
  name "OpenAFM"
  desc "Spotlight-style launcher and local agent for Apple's on-device model"
  homepage "https://github.com/P-YI/OpenAFM"

  depends_on arch: :arm64
  # The core runs on these two; Homebrew installs them from their own projects.
  depends_on formula: "apfel"
  depends_on formula: "node"
  depends_on macos: :tahoe

  app "OpenAFM.app"

  zap trash: [
    "~/Library/Application Support/OpenAFM",
    "~/Library/Preferences/dev.openafm.spotlight.plist",
  ]

  caveats <<~EOS
    OpenAFM is not signed with a Developer ID or notarized. If macOS says it cannot verify
    the app, open System Settings > Privacy & Security and click "Open Anyway", or run:
      xattr -dr com.apple.quarantine /Applications/OpenAFM.app

    Then open OpenAFM and click "Set up OpenAFM…": it copies the controller to
    ~/OpenAFM/adaptive-coding-agent and starts apfel and the controller at login
    (it asks before each step). Apple Intelligence must be turned on.

    Uninstalling keeps ~/OpenAFM (controller copy, token, logs). Stop the services first:
      ~/OpenAFM/adaptive-coding-agent/scripts/afm-launchagent.sh uninstall agent
      ~/OpenAFM/adaptive-coding-agent/scripts/afm-launchagent.sh uninstall apfel
  EOS
end
