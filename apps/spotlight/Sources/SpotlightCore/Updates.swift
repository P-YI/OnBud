// Update check (2026-11-25). Off until the user allows it once; then at most once a day one GET to GitHub's
// public API for the latest release of P-YI/OnBud (no account, nothing about the user or their files). A newer
// version is offered; nothing is installed without a yes. The update runs in Terminal, visible:
//   Homebrew install → `brew update && brew upgrade --cask onbud`
//   DMG install      → download the release DMG, check its SHA-256 against the cask at that tag, replace the app
//                      (the old copy goes to the Trash), reopen it.
// After an update the app offers to update the controller copy too (Settings > Backend > Update…).
import Foundation

public enum Updates {
    public static let repo = "P-YI/OnBud"
    public static let latestURL = URL(string: "https://api.github.com/repos/\(repo)/releases/latest")!
    public static let checkInterval: TimeInterval = 24 * 60 * 60

    public struct Release: Equatable, Sendable {
        public var version: String          // "0.2.7"
        public var notesURL: URL            // the release page
        public var dmgURL: URL?             // the OnBud-<version>.dmg asset
        public var summary: String          // the first lines of the release notes
    }

    /** "v0.2.7" / "0.2.7" → [0, 2, 7]; nil for anything that is not dotted numbers. */
    public static func parts(_ v: String) -> [Int]? {
        let s = v.hasPrefix("v") ? String(v.dropFirst()) : v
        let p = s.split(separator: ".").map { Int($0) }
        return p.isEmpty || p.contains(nil) ? nil : p.compactMap { $0 }
    }

    /** True when `candidate` is a later version than `current` (missing parts count as 0). */
    public static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let a = parts(candidate), let b = parts(current) else { return false }
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    /** The GitHub "latest release" JSON → Release (drafts and prereleases never come from that endpoint). */
    public static func parseLatest(_ data: Data) -> Release? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = o["tag_name"] as? String, parts(tag) != nil,
              let page = (o["html_url"] as? String).flatMap(URL.init(string:)), page.host == "github.com" else { return nil }
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        let dmg = (o["assets"] as? [[String: Any]] ?? [])
            .compactMap { $0["browser_download_url"] as? String }
            .first { $0.hasSuffix("/OnBud-\(version).dmg") }
            .flatMap(URL.init(string:))
            .flatMap { $0.host == "github.com" ? $0 : nil }
        return Release(version: version, notesURL: page, dmgURL: dmg, summary: summary(o["body"] as? String ?? ""))
    }

    /** The "## Changes" bullets of the release notes (else the first lines), plain, at most `limit` characters. */
    public static func summary(_ body: String, limit: Int = 600) -> String {
        let lines = body.components(separatedBy: "\n")
        let start = lines.firstIndex { $0.hasPrefix("## Changes") }.map { $0 + 1 } ?? 0
        var out: [String] = []
        for l in lines[start...] {
            if l.hasPrefix("## ") { break }
            let t = l.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { continue }
            if t.hasPrefix("- ") { out.append("• " + t.dropFirst(2)) } else if let last = out.popLast() { out.append(last + " " + t) } else { out.append(t) }
        }
        let text = out.joined(separator: "\n").replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
        return text.count > limit ? String(text.prefix(limit)) + "…" : text
    }

    /** Installed with Homebrew (`brew install --cask onbud`): its Caskroom folder exists. */
    public static func installedWithHomebrew(fm: FileManager = .default) -> Bool {
        ["/opt/homebrew/Caskroom/onbud", "/usr/local/Caskroom/onbud"].contains { fm.fileExists(atPath: $0) }
    }

    static func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    /** The Terminal script that installs `release`; it stops on any error and never deletes the old app. */
    public static func script(for release: Release, appPath: String, homebrew: Bool) -> String {
        let v = release.version
        if homebrew {
            return """
            #!/bin/zsh
            echo "Updating OnBud to \(v) with Homebrew."
            BREW="$(command -v brew || echo /opt/homebrew/bin/brew)"
            osascript -e 'quit app "OnBud"' 2>/dev/null; sleep 2
            "$BREW" update && "$BREW" upgrade --cask onbud || { echo "Homebrew did not update OnBud; nothing else was changed."; exit 1; }
            open -a OnBud
            echo "Done. OnBud \(v) is open."

            """
        }
        let dmg = release.dmgURL?.absoluteString ?? "https://github.com/\(repo)/releases/download/v\(v)/OnBud-\(v).dmg"
        return """
        #!/bin/zsh
        set -eu
        V=\(q(v)); APP=\(q(appPath)); T="$(mktemp -d)"
        echo "Updating OnBud to $V from GitHub Releases."
        curl -fL --proto '=https' --tlsv1.2 -o "$T/OnBud-$V.dmg" \(q(dmg))
        WANT="$(curl -fsSL --proto '=https' --tlsv1.2 "https://raw.githubusercontent.com/\(repo)/v$V/Casks/onbud.rb" | sed -n 's/^  sha256 "\\([0-9a-f]*\\)"$/\\1/p')"
        GOT="$(shasum -a 256 "$T/OnBud-$V.dmg" | cut -d' ' -f1)"
        if [ -z "$WANT" ] || [ "$WANT" != "$GOT" ]; then echo "The download does not match the published checksum; nothing was installed."; exit 1; fi
        echo "Checksum OK ($GOT)."
        mkdir "$T/mnt"; hdiutil attach -nobrowse -readonly -mountpoint "$T/mnt" "$T/OnBud-$V.dmg" >/dev/null
        osascript -e 'quit app "OnBud"' 2>/dev/null || true; sleep 2
        [ ! -e "$APP.new" ] || mv "$APP.new" "$T/left-over.app"   # from an interrupted update
        ditto "$T/mnt/OnBud.app" "$APP.new"
        hdiutil detach "$T/mnt" >/dev/null || true
        mv "$APP" "$HOME/.Trash/OnBud (before $V) $(date +%H%M%S).app"
        mv "$APP.new" "$APP"
        open "$APP"
        echo "Done. OnBud $V is open; the previous app is in the Trash."

        """
    }
}
