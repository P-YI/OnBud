// Settings: hotkey, model (AFM Agent = S2, AFM + a router model = S3), plugins (router model, Codex via OpenCode
// with the opt-in OpenCode config link, web search, LaTeX, translation languages), the widget, launch at login,
// and a button for the Backend window.
import AppKit
import SpotlightCore
import SwiftUI

/** View-local state; an ObservableObject because the Command Line Tools ship no SwiftUI macro plugin for @State. */
@MainActor
final class SettingsModel: ObservableObject {
    @Published var loginMessage: String?
    @Published var linkState: LinkState?
    @Published var diff: String?
    @Published var linkMessage: String?
    @Published var pendingHotKey: HotKeyChoice?
    @Published var pendingInstall: PluginID?
    let translation = TranslationModel()
}

struct SettingsView: View {
    @ObservedObject var state: AppState
    @ObservedObject var m: SettingsModel
    var openBackend: () -> Void

    var body: some View {
        Form {
            Section("Shortcut") {
                Picker("Open OpenAFM", selection: Binding(get: { state.hotKey }, set: { choice in
                    if choice == .commandSpace { m.pendingHotKey = choice } else { state.hotKey = choice }
                })) {
                    ForEach(HotKeyChoice.allCases) { Text($0.label).tag($0) }
                }
                if let w = state.hotKeyWarning { Text(w).font(.callout).foregroundStyle(.orange) }
            }
            Section("Model") {
                Picker("Model", selection: $state.useDecima) {
                    Text(Setting.s2.label).tag(false)
                    Text(state.routerLabel).tag(true).disabled(!state.decimaAvailable)
                }
                Text(state.decimaAvailable
                     ? "\(state.modelLabel): " + (state.setting == .s3 ? "AFM Agent, advised by \(state.activeRouter?.name ?? "the router model")." : "\(state.setting.detail).")
                     : "AFM + a router model needs the Router model plugin, enabled and running.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Section("Plugins") {
                ForEach(PluginID.allCases) { id in pluginRow(id) }
            }
            Section("OpenCode config (for the Codex plugin)") { linkSection }
            Section("General") {
                Toggle("Launch at login", isOn: Binding(get: { state.launchAtLogin }, set: { m.loginMessage = state.setLaunchAtLogin($0) }))
                Toggle("Keep chat history (on this Mac, ~/Library/Application Support/OpenAFM)", isOn: $state.keepHistory)
                Toggle("Notify when an answer arrives while the panel is closed", isOn: Binding(get: { state.notifyWhenDone }, set: {
                    state.notifyWhenDone = $0; if $0 { state.requestNotificationPermission() } }))
                Toggle("Chat widget shows the last question and answer (else only the Ask box)", isOn: $state.widgetShowsChat)
                if let msg = m.loginMessage { Text(msg).font(.callout).foregroundStyle(.secondary) }
                HStack {
                    Text("Backend")
                    Spacer()
                    Text(state.status.usable ? "AFM Agent running" : "AFM Agent not reachable")
                        .foregroundStyle(state.status.usable ? .green : .orange)
                    Button("Show Backend…", action: openBackend)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 580)
        .frame(minHeight: 620)
        .task { await state.probe(); m.linkState = OpenCodeLink().inspect() }
        .alert("Install \(m.pendingInstall?.name ?? "")?", isPresented: Binding(get: { m.pendingInstall != nil }, set: { if !$0 { m.pendingInstall = nil } })) {
            Button("Open Terminal") { if let id = m.pendingInstall { state.install(id) }; m.pendingInstall = nil }
            Button("Cancel", role: .cancel) { m.pendingInstall = nil }
        } message: {
            Text((m.pendingInstall?.installNote ?? "") + "\n\nTerminal shows the commands and asks again before running them.")
        }
        .alert("Use ⌘ Space?", isPresented: Binding(get: { m.pendingHotKey != nil }, set: { if !$0 { m.pendingHotKey = nil } })) {
            Button("Use ⌘ Space") { state.hotKey = .commandSpace; m.pendingHotKey = nil }
            Button("Open Keyboard Shortcuts") {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension")!)
            }
            Button("Cancel", role: .cancel) { m.pendingHotKey = nil }
        } message: {
            Text("⌘ Space belongs to Spotlight. First turn it off in System Settings > Keyboard > Keyboard Shortcuts > Spotlight (“Show Spotlight search”), otherwise Spotlight keeps getting the shortcut.")
        }
    }

    @ViewBuilder private func pluginRow(_ id: PluginID) -> some View {
        let st = state.pluginStatus(id)
        VStack(alignment: .leading, spacing: 4) {
            if id == .translate {
                // Always on (the controller uses it whenever it can); the packs decide whether it works offline.
                HStack(spacing: 6) { Image(systemName: id.symbol); Text(id.name).font(.headline) }
            } else {
                Toggle(isOn: Binding(get: { state.pluginEnabled(id) }, set: { state.setPlugin(id, enabled: $0) })) {
                    HStack(spacing: 6) { Image(systemName: id.symbol); Text(id.name).font(.headline) }
                }
                // Web search works without SearXNG (DuckDuckGo fallback); the others need their software.
                .disabled(!st.installed && !state.pluginEnabled(id) && id != .web)
            }
            Text(id.summary).font(.callout).foregroundStyle(.secondary)
            if id == .translate {
                TranslationSection(m: m.translation) { Task { await state.probe() } }
            } else {
                HStack {
                    Label(st.detail, systemImage: st.ready ? "checkmark.circle.fill" : st.installed ? "exclamationmark.circle" : "plus.circle")
                        .font(.callout).foregroundStyle(st.ready ? .green : st.installed ? .orange : .secondary)
                    Spacer()
                    if !st.installed { Button("Install…") { m.pendingInstall = id }.controlSize(.small) }
                }
            }
            if id == .decima && st.ready { routerModels }
        }
        .padding(.vertical, 2)
    }

    /** The router plugin's installed models (Ollaya /api/tags) and which one advises. */
    @ViewBuilder private var routerModels: some View {
        if state.routerModels.isEmpty {
            Text("No model installed in Ollaya (scripts/decima-setup.sh pull).").font(.callout).foregroundStyle(.orange)
        } else {
            Picker("Router model", selection: Binding(get: { state.activeRouter?.name ?? "" }, set: { state.routerModel = $0 })) {
                ForEach(state.routerModels) { r in Text(r.name + (r.summary.isEmpty ? "" : "  ·  " + r.summary)).tag(r.name) }
            }
            if let pin = RouterPin.load(paths: state.paths), let active = state.activeRouter, pin.matches(active) == false {
                Label("Decima version not pinned (shadow): \(active.name) is \(active.digest.prefix(12)), the routing was calibrated on \(pin.digestPrefix). It only logs advice until you run scripts/decima-setup.sh pull.",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }
            Text("Installed: " + state.routerModels.map(\.name).joined(separator: ", ")
                 + (state.activeRouter?.name == "decima:agent" ? "" : ". The routing thresholds were tuned on decima:agent; another model is logged in shadow and does not change routes."))
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var linkSection: some View {
        Text("Adds OpenAFM's provider, agent and MCP entries to the global OpenCode config, so OpenCode has the codex agent and the AFM agent. Existing keys are never changed; the file is backed up first.")
            .font(.callout).foregroundStyle(.secondary)
        switch m.linkState {
        case .none: EmptyView()
        case .symlinkedToRepo(let dest)?: Label("Already linked: the config is a symlink to \(dest).", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .alreadyLinked?: Label("Already linked: the config has every entry.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .sourceMissing?: Text("No ~/OpenAFM checkout to take the entries from.").foregroundStyle(.orange)
        case .unreadable(let why)?: Text("The OpenCode config does not parse, so it is left alone (\(why)).").foregroundStyle(.orange)
        case .needsMerge(let plan)?:
            Text("Will add \(plan.added.count) entries to \(plan.target.path): \(plan.added.joined(separator: ", "))").font(.callout)
            if let diff = m.diff {
                ScrollView { Text(diff).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(height: 200)
            }
            HStack {
                Button("Show diff") { m.diff = OpenCodeLink.diff(plan) }
                Button("Back up and merge") {
                    do {
                        let backup = try OpenCodeLink().apply(plan)
                        m.linkMessage = "Merged." + (backup.map { " Backup: \($0.path)" } ?? "")
                    } catch { m.linkMessage = error.localizedDescription }
                    m.linkState = OpenCodeLink().inspect(); m.diff = nil
                    Task { await state.probe() }
                }
                .disabled(m.diff == nil)
                .help("Review the diff first")
            }
        }
        if let msg = m.linkMessage { Text(msg).font(.callout).textSelection(.enabled) }
        Button(m.linkState == nil ? "Check OpenCode config" : "Check again") { m.linkState = OpenCodeLink().inspect(); m.diff = nil }
    }
}

/** The Backend window: every local service the launcher uses, where it runs, and how to start it. */
struct BackendView: View {
    @ObservedObject var state: AppState
    var body: some View {
        Form {
            Section("AFM Agent (core)") {
                row("AFM on-device model (apfel)", "127.0.0.1:11434 · LaunchAgent dev.openafm.apfel", state.status.apfel)
                row("OpenAFM controller", "127.0.0.1:11435 · LaunchAgent dev.openafm.agent", state.status.controller)
                row("Controller token", "~/OpenAFM/config/apfel.token" + (state.status.tokenPrivate ? " · owner-only (600)" : " · readable by other users — run chmod 600"), state.status.token && state.status.tokenPrivate)
                row("LaunchAgents installed", "~/Library/LaunchAgents/dev.openafm.{agent,apfel}.plist", state.status.agentLaunchAgent && state.status.apfelLaunchAgent)
                row("OpenAFM checkout", "~/OpenAFM/adaptive-coding-agent", state.status.checkout)
                HStack {
                    row("pdftext (PDF text + Vision OCR, bundled)", state.pdftextInstalled ? state.installedPdftext.path : "not installed in ~/OpenAFM/runtime/bin", state.pdftextInstalled)
                    Spacer()
                    if state.bundledPdftext != nil {
                        Button(state.pdftextInstalled ? "Reinstall" : "Install") { state.installPdftext() }.controlSize(.small)
                    }
                }
                HStack {
                    Text(state.backendOutdated ? "This app has a newer controller than the installed one." : "Install or repair apfel, Node.js and the LaunchAgents:")
                        .font(.callout).foregroundStyle(state.backendOutdated ? .orange : .secondary)
                    Spacer()
                    Button(state.backendOutdated ? "Update…" : "Run setup…") { state.runSetup() }.controlSize(.small)
                }
                Text("Start or restart (Terminal):").font(.callout).foregroundStyle(.secondary)
                Text("launchctl kickstart -k gui/\(getuid())/dev.openafm.agent\nlaunchctl kickstart -k gui/\(getuid())/dev.openafm.apfel")
                    .font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                Text("Logs: ~/OpenAFM/runtime/logs/afm-agent-server.log, apfel-serve.log").font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Section("Local tools the AFM Agent uses") {
                ForEach(LocalTool.all, id: \.name) { t in
                    let path = t.find()
                    row(t.name, (path ?? "not found") + " · " + t.use, path != nil, optional: t.optional)
                }
            }
            Section("Router model plugin") {
                row("Ollaya", "127.0.0.1:11436 · scripts/decima-setup.sh start|status", state.status.decima, optional: true)
                ForEach(state.routerModels) { r in
                    row(r.name + (r.name == state.activeRouter?.name ? "  (in use)" : ""), r.summary, true, optional: true)
                }
            }
            Section("Web search plugin") {
                row("SearXNG", "127.0.0.1:8888 · scripts/searxng-setup.sh start|status (else DuckDuckGo Lite)", state.status.searxng, optional: true)
            }
            Section("Codex via OpenCode plugin") {
                row("OpenCode desktop app", OpenCodeInstall.desktopApp?.path ?? "not installed", OpenCodeInstall.desktopApp != nil, optional: true)
                row("OpenCode CLI", OpenCodeInstall.cli?.path ?? "not installed", OpenCodeInstall.cli != nil, optional: true)
                row("OpenCode local service", OpenCodeService.load()?.url.absoluteString ?? "not running (starts with the desktop app)", OpenCodeService.load() != nil, optional: true)
            }
            Button("Check again") { Task { await state.probe() } }
        }
        .formStyle(.grouped)
        .frame(width: 560)
        .frame(minHeight: 560)
        .task { await state.probe() }
    }

    private func row(_ name: String, _ detail: String, _ ok: Bool, optional: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: ok ? "checkmark.circle.fill" : (optional ? "minus.circle" : "xmark.circle.fill"))
                .foregroundStyle(ok ? .green : (optional ? .secondary : .red))
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                Text(detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
    }
}

/** Command-line tools behind the AFM Agent's features (looked up, never installed). */
struct LocalTool {
    let name: String, use: String, candidates: [String], optional: Bool
    func find() -> String? { candidates.map { ($0 as NSString).expandingTildeInPath }.first { FileManager.default.isExecutableFile(atPath: $0) } }
    static let all: [LocalTool] = [
        LocalTool(name: "Node.js", use: "runs the controller", candidates: ["/opt/homebrew/bin/node", "/usr/local/bin/node", "~/.volta/bin/node"], optional: false),
        LocalTool(name: "Spotlight (mdfind)", use: "file search, built into macOS", candidates: ["/usr/bin/mdfind"], optional: false),
        LocalTool(name: "ripgrep", use: "fast code search (else git grep)", candidates: ["/opt/homebrew/bin/rg", "/usr/local/bin/rg"], optional: true),
        LocalTool(name: "tmux", use: "long-running commands in background sessions", candidates: ["/opt/homebrew/bin/tmux", "/usr/bin/tmux", "/usr/local/bin/tmux"], optional: true),
    ]
}
