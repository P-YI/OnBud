// Backend > GitHub Copilot: sign-in status, GitHub's device-flow sign-in (the user logs in on github.com
// themselves; the app only shows the code and opens the page on a click), the read-only quota line, the
// "Use Copilot for code" switch (ONBUD_COPILOT=off in the controller's LaunchAgent), and copilot_mode.
import AppKit
import SpotlightCore
import SwiftUI

@MainActor
final class CopilotModel: ObservableObject {
    @Published var status: String?            // "OK", "NotSignedIn", …; nil = not checked yet
    @Published var user: String?
    @Published var checking = false
    @Published var quota: Copilot.Quota?
    @Published var device: (url: URL, code: String)?
    @Published var signingIn = false
    @Published var message: String?
    @Published var mode: CopilotMode?
    @Published var enabled = true             // not switched off in the LaunchAgent
    @Published var pendingSwitch: Bool?       // the value the user is asked to confirm
    private var signin: Process?

    let paths = OnBudPaths()
    var installed: Bool { Copilot.installed(paths) }
    var signedIn: Bool { status.map(Copilot.signedIn) ?? false }
    var agentPlist: URL { OnBudPaths.launchAgent("dev.onbud.agent") }
    var nodeRun: URL { paths.repo.appendingPathComponent("scripts/node-run.sh") }

    func load() async {
        mode = (try? String(contentsOf: CopilotMode.policy(paths), encoding: .utf8)).flatMap(CopilotMode.read)
        enabled = Self.launchAgentValue(agentPlist) != "off"
        guard installed else { status = nil; return }
        checking = true
        let args = [nodeRun.path, Copilot.script(paths).path, "status"]
        let out = await Task.detached { RoutingModel.run("/bin/bash", args, timeout: 30) }.value
        if let s = Copilot.parseStatus(out) { status = s.status; user = s.user } else { status = "unknown" }
        checking = false
        if signedIn, let gh = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            let json = await Task.detached { RoutingModel.run(gh, ["api", "/copilot_internal/user"], timeout: 15) }.value
            quota = Copilot.parseQuota(Data(json.utf8))
        }
    }

    /** GitHub device flow through the language server: shows the code, waits (up to 10 min) for the login. */
    func signIn() {
        guard !signingIn else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [nodeRun.path, Copilot.script(paths).path, "signin"]
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = String(decoding: h.availableData, as: UTF8.self)
            guard !chunk.isEmpty else { return }
            Task { @MainActor in
                for line in chunk.components(separatedBy: "\n") {
                    if let d = Copilot.parseDeviceCode(line) { self?.device = d; self?.message = "Enter the code on GitHub, then come back here." }
                    if let s = Copilot.parseStatus(line), Copilot.signedIn(s.status) { self?.status = s.status }
                }
            }
        }
        p.terminationHandler = { [weak self] _ in
            pipe.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor in
                self?.signingIn = false; self?.device = nil; self?.signin = nil
                await self?.load()
                self?.message = (self?.signedIn ?? false) ? "Signed in to GitHub Copilot." : "Not signed in (the code expired or the sign-in was cancelled)."
            }
        }
        do { try p.run(); signin = p; signingIn = true; message = "Asking GitHub for a sign-in code…" }
        catch { message = "Could not start the sign-in: \(error.localizedDescription)" }
    }

    func cancelSignIn() { signin?.terminate() }

    func copyCode() {
        guard let d = device else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(d.code, forType: .string)
        message = "Code \(d.code) copied."
    }

    func setMode(_ m: CopilotMode) {
        let url = CopilotMode.policy(paths)
        guard let yaml = try? String(contentsOf: url, encoding: .utf8), let new = CopilotMode.write(yaml, m) else {
            message = "policies/routing.yaml has no copilot_mode line; update the controller first."; return
        }
        do { try new.write(to: url, atomically: true, encoding: .utf8); mode = m; message = "Copilot mode: \(m.rawValue). The controller reloads its policies by itself." }
        catch { message = "Could not write routing.yaml: \(error.localizedDescription)" }
    }

    /** Switches ONBUD_COPILOT in the controller's LaunchAgent and restarts it (after the user confirmed). */
    func applySwitch(_ on: Bool) {
        let plist = agentPlist.path
        guard FileManager.default.fileExists(atPath: plist) else { message = "No controller LaunchAgent (run setup first)."; return }
        let edit = on ? ["-remove", "EnvironmentVariables.ONBUD_COPILOT", plist] : ["-replace", "EnvironmentVariables.ONBUD_COPILOT", "-string", "off", plist]
        _ = RoutingModel.run("/usr/bin/plutil", edit, timeout: 5, capture: false)
        let domain = "gui/\(getuid())"
        _ = RoutingModel.run("/bin/launchctl", ["bootout", "\(domain)/dev.onbud.agent"], timeout: 10, capture: false)
        Thread.sleep(forTimeInterval: 1.5)   // bootout is asynchronous
        _ = RoutingModel.run("/bin/launchctl", ["bootstrap", domain, plist], timeout: 10, capture: false)
        enabled = Self.launchAgentValue(agentPlist) != "off"
        message = enabled == on ? "Copilot for code is \(on ? "on" : "off"); the controller restarted." : "The LaunchAgent did not change."
    }

    static func launchAgentValue(_ plist: URL) -> String? {
        guard let data = try? Data(contentsOf: plist),
              let o = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return nil }
        return (o["EnvironmentVariables"] as? [String: Any])?["ONBUD_COPILOT"] as? String
    }
}

struct CopilotSection: View {
    @ObservedObject var m: CopilotModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: m.signedIn ? "checkmark.circle.fill" : m.installed ? "exclamationmark.circle" : "minus.circle")
                    .foregroundStyle(m.signedIn ? .green : m.installed ? .orange : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("GitHub Copilot (code writer for local jobs)")
                    Text(statusText).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Spacer()
                if m.checking { ProgressView().controlSize(.small) }
                if m.installed && !m.signedIn && !m.signingIn { Button("Sign in…") { m.signIn() }.controlSize(.small) }
                if m.signingIn { Button("Cancel") { m.cancelSignIn() }.controlSize(.small) }
            }
            if let d = m.device {
                HStack(spacing: 8) {
                    Text(d.code).font(.system(.title3, design: .monospaced).weight(.semibold)).textSelection(.enabled)
                    Button("Copy code") { m.copyCode() }.controlSize(.small)
                    Button("Open GitHub") { NSWorkspace.shared.open(d.url) }.controlSize(.small).buttonStyle(.borderedProminent)
                    Text(d.url.absoluteString).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let q = m.quota { Text(q.summary).font(.caption).foregroundStyle(.secondary) }
            if m.installed {
                Toggle("Use Copilot for code", isOn: Binding(get: { m.enabled }, set: { m.pendingSwitch = $0 }))
                Text("Only inline completion (unlimited, no premium requests); no Copilot chat, CLI or agents. Off sets ONBUD_COPILOT=off for the controller.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Install the language server (MIT): cd ~/OnBud/runtime/copilot-ls && npm install @github/copilot-language-server")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if let msg = m.message { Text(msg).font(.callout) }
        }
        .alert(m.pendingSwitch == true ? "Turn Copilot for code on?" : "Turn Copilot for code off?",
               isPresented: Binding(get: { m.pendingSwitch != nil }, set: { if !$0 { m.pendingSwitch = nil } })) {
            Button("Change and restart") { if let v = m.pendingSwitch { m.applySwitch(v) }; m.pendingSwitch = nil }
            Button("Cancel", role: .cancel) { m.pendingSwitch = nil }
        } message: {
            Text("This edits ~/Library/LaunchAgents/dev.onbud.agent.plist (ONBUD_COPILOT) and restarts the controller. A request that is running now is cut off. Re-running setup resets it to on.")
        }
    }

    private var statusText: String {
        if !m.installed { return "Not installed (~/OnBud/runtime/copilot-ls)" }
        guard let s = m.status else { return "Checking…" }
        if Copilot.signedIn(s) { return "Signed in as \(m.user ?? "?")" + (m.enabled ? "" : " · switched off for the controller") }
        return s == "NotSignedIn" ? "Not signed in" : "Status: \(s)"
    }
}
