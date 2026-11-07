// Backend > Routing: the controller and the three model tiers it routes between, each with its setting.
//   Local LLM        Apple's on-device model through apfel (fixed; shows what the Mac reports)
//   Decision model   the router plugin's model on Ollaya (on/off, which installed model, version pin)
//   Code LLM         GitHub Copilot's inline completion for the code of local jobs (S5; copilot_mode)
//   Frontier LLM     two tiers of OpenCode agents: strong (codex, codex-handoff, codex-solve: hand-offs and "Send to
//                    Codex"; default GPT-6.1 Sol) and cheap (codex-solve-cheap: the code skill's checked first
//                    escalation; default GPT-6.1 Terra). Each tier's model is changed in the global OpenCode config
//                    (diff + backup first), so OpenCode follows too.
//                    Provider keys (Claude, Copilot, …) are added with `opencode auth login` in Terminal and stay
//                    in OpenCode; OnBud only lists which providers are signed in.
import AppKit
import SpotlightCore
import SwiftUI

@MainActor
final class RoutingModel: ObservableObject {
    @Published var apfel: [String: Any] = [:]
    @Published var configText: String?
    @Published var configError: String?
    @Published var current = FrontierAgents.Current(model: nil, variant: nil, present: [])
    @Published var models: [String: [String]] = [:]
    @Published var auth: [String] = []
    @Published var loadingModels = false
    @Published var pickedModel = ""
    @Published var pickedVariant = ""        // "" = the model's default
    @Published var diff: String?
    @Published var message: String?
    @Published var tier: FrontierAgents.Tier = .strong { didSet { if tier != oldValue { readConfig() } } }

    let link = OpenCodeLink()
    static let variants = ["", "low", "medium", "high"]

    var target: URL { link.target }
    var changed: Bool { !pickedModel.isEmpty && (pickedModel != current.model || (pickedVariant.isEmpty ? nil : pickedVariant) != current.variant) }

    func load() async {
        // apfel's /health: model, context window, availability.
        if let (data, _) = try? await URLSession.shared.data(for: URLRequest(url: Backend.url(Port.apfel, "/health"), timeoutInterval: 1.5)),
           let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { apfel = o }
        readConfig()
        guard let cli = OpenCodeInstall.cli else { return }
        loadingModels = true
        let path = cli.path
        let (m, a) = await Task.detached { (Self.run(path, ["models"]), Self.run(path, ["auth", "list"])) }.value
        models = FrontierAgents.parseModels(m)
        auth = FrontierAgents.parseAuth(a)
        loadingModels = false
    }

    func readConfig() {
        configError = nil
        guard let text = try? String(contentsOf: target.resolvingSymlinksInPath(), encoding: .utf8) else {
            configText = nil; configError = "No global OpenCode config at \(target.path)."; return
        }
        configText = text
        current = FrontierAgents.current(text, tier: tier)
        if current.present.isEmpty {
            configError = tier == .strong ? "The OpenCode config has no codex agents yet: link it first (Settings > OpenCode config)."
                                          : "The OpenCode config has no codex-solve-cheap agent: re-link it (Settings > OpenCode config) to get the current agents."
        }
        pickedModel = current.model ?? ""
        pickedVariant = current.variant ?? ""
        diff = nil
    }

    func showDiff() {
        guard let text = configText else { return }
        do {
            let new = try FrontierAgents.apply(text, model: pickedModel, variant: pickedVariant.isEmpty ? nil : pickedVariant, tier: tier)
            diff = Self.unifiedDiff(text, new, name: target.lastPathComponent)
        } catch { message = "\(error)" }
    }

    func apply() {
        guard let text = configText else { return }
        do {
            let new = try FrontierAgents.apply(text, model: pickedModel, variant: pickedVariant.isEmpty ? nil : pickedVariant, tier: tier)
            let backup = try FrontierAgents.write(new, to: target, expected: text)
            message = "\(tier.label) tier model is now \(pickedModel)\(pickedVariant.isEmpty ? "" : " (\(pickedVariant))") for OpenCode's \(current.present.joined(separator: ", ")) agents: the controller's next hand-off and OpenCode both use it (restart the OpenCode app if it is open). Backup: \(backup.lastPathComponent)"
            readConfig()
        } catch { message = "Not changed: \(error)" }
    }

    /** Runs a CLI and returns its stdout; stopped after `timeout` seconds so a hung CLI cannot hold the app. */
    /** `capture: false` for commands that start a daemon: it could inherit the pipe and keep it open forever. */
    nonisolated static func run(_ cli: String, _ args: [String], timeout: TimeInterval = 15, capture: Bool = true) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cli)
        p.arguments = args
        p.standardError = FileHandle.nullDevice
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { if p.isRunning { p.terminate() } }
        guard capture else {
            p.standardOutput = FileHandle.nullDevice
            do { try p.run() } catch { return "" }
            p.waitUntilExit()
            return ""
        }
        let out = Pipe(); p.standardOutput = out
        do { try p.run() } catch { return "" }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    static func unifiedDiff(_ a: String, _ b: String, name: String) -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("onbud-diff-\(UUID().uuidString.prefix(6))")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fa = dir.appendingPathComponent("a"), fb = dir.appendingPathComponent("b")
        try? a.write(to: fa, atomically: true, encoding: .utf8); try? b.write(to: fb, atomically: true, encoding: .utf8)
        let out = run("/usr/bin/diff", ["-u", "--label", name, "--label", name + " (new)", fa.path, fb.path])
        return out.isEmpty ? "(no change)" : out
    }
}

struct RoutingView: View {
    @ObservedObject var state: AppState
    @ObservedObject var m: RoutingModel
    @ObservedObject var copilot: CopilotModel

    var body: some View {
        VStack(spacing: 10) {
            controllerBox
            VStack(spacing: 2) {
                Image(systemName: "arrow.down").foregroundStyle(.secondary)
                Text("Rules first, then an optional decision model").font(.caption).foregroundStyle(.secondary)
            }
            HStack(alignment: .top, spacing: 10) {
                card("Local LLM", "Apple FM", symbol: "cpu", tint: .green, ok: state.status.apfel) { local }
                card("Decision model", state.activeRouter?.shortName ?? "Decima", symbol: "arrow.triangle.branch", tint: .orange,
                     ok: state.pluginEnabled(.decima) && state.status.decima) { decision }
                card("Code LLM", "GitHub Copilot", symbol: "chevron.left.forwardslash.chevron.right", tint: .purple,
                     ok: copilot.signedIn && copilot.enabled) { code }
                card("Frontier LLM", frontierName, symbol: "cloud", tint: .blue, ok: !m.current.present.isEmpty && OpenCodeInstall.cli != nil) { frontier }
            }
            if let msg = m.message { Text(msg).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
        }
        .task { await m.load(); await copilot.load() }
    }

    private var frontierName: String {
        guard let model = m.current.model else { return "Codex" }
        return model.components(separatedBy: "/").last ?? model
    }

    private var controllerBox: some View {
        VStack(spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(state.status.controller ? Color.green : Color.red).frame(width: 8, height: 8)
                Text("OnBud Controller (Node.js)").font(.headline)
            }
            Text("Context · Routing · Security · Tool execution · Memory").font(.callout).foregroundStyle(.secondary)
            Text("127.0.0.1:11435").font(.caption.monospaced()).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity).padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(.background.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }

    private func card<C: View>(_ title: String, _ model: String, symbol: String, tint: Color, ok: Bool, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.title3).foregroundStyle(tint)
                Text(title).font(.headline)
                HStack(spacing: 4) {
                    Circle().fill(ok ? Color.green : Color.secondary.opacity(0.5)).frame(width: 7, height: 7)
                    Text(model).font(.callout).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)
            Divider()
            content().font(.caption)
        }
        .padding(10)
        .frame(maxWidth: .infinity, minHeight: 230, alignment: .top)
        .background(RoundedRectangle(cornerRadius: 12).fill(tint.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(tint.opacity(0.25)))
    }

    // MARK: tiers

    @ViewBuilder private var local: some View {
        Text("apfel · 127.0.0.1:11434").foregroundStyle(.secondary)
        Text("Reading, summaries, small schemas, simple reasoning").foregroundStyle(.secondary)
        if let ctx = m.apfel["context_window"] as? Int { Text("Context window: \(ctx) tokens") }
        if let avail = m.apfel["model_available"] as? Bool {
            Text(avail ? "Model available" : "Model not available (Apple Intelligence off or downloading)").foregroundStyle(avail ? .green : .orange)
        }
        Text("Always on; Apple's on-device model is the only local model apfel serves.").foregroundStyle(.tertiary)
    }

    @ViewBuilder private var decision: some View {
        Text("Ollaya · 127.0.0.1:11436").foregroundStyle(.secondary)
        Text("Advises on generic routes; rules decide the rest").foregroundStyle(.secondary)
        Toggle("Router plugin on", isOn: Binding(get: { state.pluginEnabled(.decima) }, set: { state.setPlugin(.decima, enabled: $0) }))
            .disabled(!state.pluginStatus(.decima).installed)
        if !state.routerModels.isEmpty {
            Picker("Model", selection: Binding(get: { state.activeRouter?.name ?? "" }, set: { state.routerModel = $0 })) {
                ForEach(state.routerModels) { r in Text(r.name).tag(r.name) }
            }
            .labelsHidden()
            Toggle("Use in the panel (\(state.routerLabel))", isOn: $state.useDecima).disabled(!state.decimaAvailable)
            if let pin = RouterPin.load(paths: state.paths), let a = state.activeRouter, pin.matches(a) == false {
                Text("Not the calibrated version: advises in shadow only.").foregroundStyle(.orange)
            }
        } else {
            if state.pluginStatus(.decima).installed {
                HStack {
                    Text("Ollaya is not running").foregroundStyle(.orange)
                    if state.serviceBusy.contains(.decima) { ProgressView().controlSize(.mini) }
                    else { Button("Start") { state.startService(.decima) }.controlSize(.small) }
                }
            } else {
                Text("Not installed: Settings > Plugins > Router model").foregroundStyle(.orange)
            }
        }
    }

    @ViewBuilder private var code: some View {
        Text("Language server · inline completion").foregroundStyle(.secondary)
        Text("Writes the code of local jobs; AFM plans and tests, Codex takes what fails").foregroundStyle(.secondary)
        if !copilot.installed {
            Text("Not installed (see GitHub Copilot below)").foregroundStyle(.orange)
        } else if !copilot.signedIn {
            Text(copilot.status == nil ? "Checking…" : "Not signed in: GitHub Copilot below").foregroundStyle(.orange)
        } else if !copilot.enabled {
            Text("Switched off for the controller").foregroundStyle(.orange)
        }
        if let mode = copilot.mode {
            Picker("Copilot mode", selection: Binding(get: { mode }, set: { copilot.setMode($0) })) {
                ForEach(CopilotMode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden()
            Text(mode.detail).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var frontier: some View {
        Picker("Tier", selection: $m.tier) {
            ForEach(FrontierAgents.Tier.allCases) { Text($0.label).tag($0) }
        }
        .pickerStyle(.segmented).labelsHidden()
        Text(m.tier.detail).foregroundStyle(.secondary)
        Text("OpenCode agents: \(m.current.present.isEmpty ? "–" : m.current.present.joined(separator: ", ")) · default \(m.tier.defaultModel)").foregroundStyle(.secondary)
        if OpenCodeInstall.cli == nil {
            Text("OpenCode is not installed: Settings > Plugins > Codex via OpenCode").foregroundStyle(.orange)
        } else if let err = m.configError {
            Text(err).foregroundStyle(.orange)
        } else {
            if m.loadingModels { HStack(spacing: 4) { ProgressView().controlSize(.mini); Text("Asking OpenCode for models…") } }
            Picker("Model", selection: $m.pickedModel) {
                if let cur = m.current.model, !m.models.values.joined().contains(cur) { Text(cur).tag(cur) }
                ForEach(m.models.keys.sorted(), id: \.self) { provider in
                    Section(provider) { ForEach(m.models[provider] ?? [], id: \.self) { Text($0).tag($0) } }
                }
            }
            .labelsHidden()
            Picker("Effort", selection: $m.pickedVariant) {
                ForEach(RoutingModel.variants, id: \.self) { Text($0.isEmpty ? "model default" : $0).tag($0) }
            }
            HStack {
                Button("Show diff") { m.showDiff() }.disabled(!m.changed)
                Button("Apply") { m.apply() }.disabled(!m.changed || m.diff == nil).help("Review the diff first")
            }
            .controlSize(.small)
            Text("Signed in: " + (m.auth.isEmpty ? "–" : m.auth.joined(separator: ", "))).foregroundStyle(.secondary)
            Button("Add a provider key (Claude, Copilot, …)…") { addProvider() }.controlSize(.small)
        }
    }

    private func addProvider() {
        guard let cli = OpenCodeInstall.cli else { return }
        state.runInTerminal("""
        #!/bin/zsh
        echo "OpenCode sign-in: pick a provider (Anthropic for Claude, GitHub Copilot, OpenAI, …)."
        echo "The key or login is stored by OpenCode in ~/.local/share/opencode/auth.json; OnBud never sees it."
        echo
        \(shellQuote(cli.path)) auth login
        echo
        echo "Done. In OnBud: Backend > Check again, then pick the new model under Frontier LLM."

        """, prefix: "onbud-auth-")
        m.message = "Sign in in Terminal, then press Check again to see the provider's models."
    }
}
