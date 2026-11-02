// Plugins: optional pieces on top of the AFM Agent (the always-on core: apfel + the OpenAFM controller +
// the bundled pdftext helper).
//   decima  Router model on Ollaya (127.0.0.1:11436; decima:agent by default, or another installed one)
//           → the "AFM + <router>" model (the id stays "decima" so saved choices keep working)
//   codex   Codex through OpenCode (desktop app or CLI, `codex` agent) → hand-offs for tasks too big for AFM
//   web     Web search: approval-gated search through a local SearXNG (127.0.0.1:8888), else DuckDuckGo/arXiv
//   latex   MacTeX (latexmk) → compiling and fixing LaTeX papers
//   translate  Apple's on-device translation languages (the controller's translator, tools/translate, is
//           always used; it only works offline for languages whose packs are downloaded)
// A plugin that is already installed starts out enabled. "Install" opens Terminal with the plugin's install
// commands, so the user sees every step (and types their password where macOS asks); nothing runs hidden.
import Foundation

public enum PluginID: String, CaseIterable, Sendable, Identifiable {
    case decima, codex, web, latex, translate
    public var id: String { rawValue }
    public var name: String {
        switch self {
        case .decima: return "Router model"
        case .codex: return "Codex via OpenCode"
        case .web: return "Web search (SearXNG)"
        case .latex: return "LaTeX (MacTeX)"
        case .translate: return "Translation languages"
        }
    }
    public var symbol: String {
        switch self {
        case .decima: return "arrow.triangle.branch"
        case .codex: return "chevron.left.forwardslash.chevron.right"
        case .web: return "globe"
        case .latex: return "function"
        case .translate: return "character.bubble"
        }
    }
    public var summary: String {
        switch self {
        case .decima: return "A small local model (served by Ollaya on 127.0.0.1:11436) that advises the AFM Agent where a request should go. Pick one of the installed models; adds the “AFM + <model>” choice. decima:agent is the one the routing thresholds were tuned on; another model only advises in shadow."
        case .codex: return "Sends tasks that are too big for the on-device model (multi-file code changes, new features) to Codex in OpenCode — the desktop app if installed, else the CLI."
        case .web: return "Lets the AFM Agent search the web after you approve the query. Uses a private SearXNG on 127.0.0.1:8888 when installed (AGPL, ~150 MB), else DuckDuckGo Lite, arXiv and Wikipedia. Queries leave this Mac."
        case .latex: return "MacTeX's latexmk, so the AFM Agent can compile papers and fix LaTeX errors. Citation/reference checks and prose polishing work without it. (~6 GB, needs your password.)"
        case .translate: return "The AFM Agent translates Korean questions into English search words with Apple's on-device translator (built once with swiftc on first use). It needs the language packs; without them only that step is skipped."
        }
    }
    /** Shell commands the Install button runs in Terminal. */
    public func installScript(repo: URL) -> String {
        let r = shellQuote(repo.path)
        switch self {
        case .decima:
            return "cd \(r) && scripts/decima-setup.sh install && scripts/decima-setup.sh pull && scripts/decima-setup.sh start"
        case .codex:
            return "curl -fsSL https://opencode.ai/install | bash && echo 'Now sign in: opencode auth login (ChatGPT), then use “Link OpenCode config” in OpenAFM Settings.'"
        case .web:
            return "cd \(r) && scripts/searxng-setup.sh install && scripts/searxng-setup.sh start"
        case .latex:
            return "if command -v brew >/dev/null; then brew install --cask mactex-no-gui; else open https://www.tug.org/mactex/mactex-download.html; fi"
        case .translate:   // language packs download through macOS (Settings shows a Download button per language)
            return "open 'x-apple.systempreferences:com.apple.Localization-Settings.extension'"
        }
    }
    /** What the Install button will do, in one line, for the confirmation dialog. */
    public var installNote: String {
        switch self {
        case .decima: return "Runs scripts/decima-setup.sh: downloads Ollaya (Apache-2.0) into ~/OpenAFM/runtime/ollaya and the decima:agent model into ~/.ollaya, then starts it on 127.0.0.1:11436."
        case .codex: return "Runs OpenCode's official installer (curl https://opencode.ai/install | bash) into ~/.opencode. You then sign in to ChatGPT in OpenCode."
        case .web: return "Runs scripts/searxng-setup.sh: clones SearXNG from GitHub into ~/OpenAFM/runtime/searxng with its own Python venv (~150 MB), bound to 127.0.0.1:8888."
        case .latex: return "Runs Homebrew's MacTeX cask (mactex-no-gui, ~6 GB; macOS asks for your password), or opens the MacTeX download page if Homebrew is missing."
        case .translate: return "macOS downloads the language pack (Apple's on-device translation models, a few hundred MB each)."
        }
    }
}

public struct PluginStatus: Equatable, Sendable {
    public var installed = false
    public var ready = false          // installed and usable right now
    public var detail = ""
    public init() {}
}

public enum OpenCodeInstall {
    public static let desktopBundleID = "ai.opencode.desktop"
    public static var desktopApp: URL? {
        ["/Applications/OpenCode.app", NSHomeDirectory() + "/Applications/OpenCode.app"]
            .map(URL.init(fileURLWithPath:)).first { FileManager.default.fileExists(atPath: $0.path) }
    }
    public static var cli: URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [home + "/.opencode/bin/opencode", "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode", home + "/.local/bin/opencode"]
            .map(URL.init(fileURLWithPath:)).first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }
}

public enum Plugins {
    public static let latexmk = "/Library/TeX/texbin/latexmk"

    public static func detect(_ id: PluginID, backend: BackendStatus, paths: OpenAFMPaths = OpenAFMPaths()) -> PluginStatus {
        var s = PluginStatus()
        let fm = FileManager.default
        switch id {
        case .decima:
            let binary = paths.home.appendingPathComponent("runtime/ollaya").path
            let models = fm.homeDirectoryForCurrentUser.appendingPathComponent(".ollaya/models").path
            s.installed = backend.decima || fm.fileExists(atPath: binary) || fm.fileExists(atPath: models)
            s.ready = backend.decima
            s.detail = backend.decima ? "Ollaya running on 127.0.0.1:11436" : s.installed ? "Installed, not running (scripts/decima-setup.sh start)" : "Not installed"
        case .codex:
            let app = OpenCodeInstall.desktopApp, cli = OpenCodeInstall.cli
            s.installed = app != nil || cli != nil
            let link = OpenCodeLink().inspect()
            let linked: Bool = { if case .symlinkedToRepo = link { return true }; return link == .alreadyLinked }()
            s.ready = s.installed && linked
            s.detail = !s.installed ? "OpenCode not installed"
                : [app != nil ? "desktop app" : nil, cli != nil ? "CLI" : nil].compactMap { $0 }.joined(separator: " + ")
                  + (linked ? " · codex agent configured" : " · OpenCode config not linked yet")
        case .web:
            let searx = fm.fileExists(atPath: paths.home.appendingPathComponent("runtime/searxng/settings.yml").path)
            s.installed = searx
            s.ready = backend.searxng
            s.detail = backend.searxng ? "SearXNG running on 127.0.0.1:8888"
                : searx ? "SearXNG installed, not running (scripts/searxng-setup.sh start) — DuckDuckGo is used meanwhile"
                : "SearXNG not installed — when enabled, DuckDuckGo Lite, arXiv and Wikipedia are used"
        case .latex:
            s.installed = fm.isExecutableFile(atPath: latexmk)
            s.ready = s.installed
            s.detail = s.installed ? "latexmk at \(latexmk)" : "MacTeX not installed"
        case .translate:   // language packs are checked by the app (Translation framework); this is the translator
            let bin = paths.home.appendingPathComponent("runtime/bin/afm-translate").path
            s.installed = fm.isExecutableFile(atPath: bin)
            s.ready = s.installed
            s.detail = s.installed ? "Translator built (\(bin))" : "Translator not built yet (built on first use, or press Build)"
        }
        return s
    }

    /** Enabled = the user's choice; until they choose, a plugin is enabled when it is installed. */
    public static func isEnabled(_ id: PluginID, installed: Bool, defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: "plugin.\(id.rawValue)") as? Bool ?? installed
    }
    public static func setEnabled(_ id: PluginID, _ on: Bool, defaults: UserDefaults = .standard) {
        defaults.set(on, forKey: "plugin.\(id.rawValue)")
    }

    /** A Terminal script for the install: shows the commands, asks to continue, runs them, keeps the window open. */
    public static func installCommandFile(_ id: PluginID, repo: URL) -> String {
        let cmd = id.installScript(repo: repo)
        return """
        #!/bin/zsh
        echo "OpenAFM — install plugin: \(id.name)"
        echo
        echo \(shellQuote(id.installNote))
        echo
        echo "Commands:"
        echo \(shellQuote(cmd))
        echo
        read -q "?Run them now? [y/N] " || { echo; echo "Cancelled."; exit 0; }
        echo
        \(cmd)
        echo
        echo "Done. Go back to OpenAFM and press Check again."

        """
    }
}
