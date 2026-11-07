// The Skills window (menu bar › Skills…): every OnBud skill with what it does, what it may do (capabilities,
// lane, what leaves this Mac), the plugins and macOS permissions it uses, and its switch. Switches are saved in
// ~/OnBud/config/skills.json, which the controller reads on every request (no restart).
import AppKit
import SpotlightCore
import SwiftUI

@MainActor
final class SkillsModel: ObservableObject {
    @Published var infos: [SkillInfo] = []
    @Published var settings = SkillSettings()
    @Published var maxMB = ""
    @Published var message: String?
    @Published var pendingPersonal = false
    let paths = OnBudPaths()

    func load() {
        infos = Skills.manifests(paths)
        settings = SkillSettings.load(from: Skills.file(paths))
        maxMB = String(settings.convertMaxMB)
    }

    var switchable: [SkillInfo] { infos.filter { !Skills.alwaysOn.contains($0.id) } }
    var onCount: Int { switchable.filter { settings.isOn($0.id) }.count }

    /** personal (Calendar/Reminders) asks first; the others switch at once. */
    func request(_ id: String, _ on: Bool) {
        if id == "personal" && on { pendingPersonal = true } else { set(id, on) }
    }

    func set(_ id: String, _ on: Bool) {
        var s = SkillSettings.load(from: Skills.file(paths))   // re-read: keep edits made elsewhere
        s.set(id, on: on)
        save(s, done: "\(SkillCatalog.title(id)) is \(on ? "on" : "off")." + (id == "personal" && on ? " macOS asks once for Calendar and Reminders access the first time you ask." : ""))
    }

    func commitMaxMB() {
        guard let n = Int(maxMB.trimmingCharacters(in: .whitespaces)), n > 0, n <= 100_000 else {
            message = "Enter a whole number of MB (1 to 100000)."; maxMB = String(settings.convertMaxMB); return
        }
        guard n != settings.convertMaxMB else { return }
        var s = SkillSettings.load(from: Skills.file(paths))
        s.convertMaxMB = n
        save(s, done: "Conversions accept files up to \(n) MB.")
    }

    private func save(_ s: SkillSettings, done: String) {
        do { try s.save(to: Skills.file(paths)); settings = s; maxMB = String(s.convertMaxMB); message = done }
        catch { message = "Could not save skills.json: \(error.localizedDescription)" }
    }
}

struct SkillsView: View {
    @ObservedObject var state: AppState
    @ObservedObject var m: SkillsModel
    var openSettings: () -> Void
    var openBackend: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if m.infos.isEmpty {
                        Text("No skill manifests found in ~/OnBud/adaptive-coding-agent/skills.").foregroundStyle(.orange)
                    }
                    ForEach(m.infos) { info in card(info) }
                    legend
                }
                .padding(16)
            }
        }
        .frame(width: 760, height: 720)
        .task { m.load(); await state.probe() }
        .alert("Turn on Calendar & Reminders?", isPresented: $m.pendingPersonal) {
            Button("Turn on") { m.set("personal", true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The AFM Agent may then read your calendar events and reminders when you ask about them (read-only). Nothing is stored, logged or sent anywhere, and it is never handed to Codex or Copilot.\n\nThe first time, macOS asks you to allow Calendars and Reminders for the helper afm-pim; you can withdraw it in System Settings › Privacy & Security.")
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Skills").font(.title2.weight(.semibold))
                Text("\(m.infos.count) skills · \(m.onCount) of the \(m.switchable.count) with a switch are on (core is always on) · changes apply to the next question")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            if let msg = m.message { Text(msg).font(.callout).lineLimit(2).frame(maxWidth: 280, alignment: .trailing) }
            Button { m.load(); Task { await state.probe() } } label: { Image(systemName: "arrow.clockwise") }
                .help("Reload the manifests and skills.json")
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    @ViewBuilder private func card(_ info: SkillInfo) -> some View {
        let on = m.settings.isOn(info.id)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: SkillCatalog.symbol(info.id)).font(.title3).frame(width: 26)
                    .foregroundStyle(on ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(SkillCatalog.title(info.id)).font(.headline)
                        Text(info.id + (info.version.isEmpty ? "" : " " + info.version)).font(.caption.monospaced()).foregroundStyle(.secondary)
                        if info.isPrivate { badge("Private", "hand.raised.fill", .purple) }
                    }
                }
                Spacer()
                if Skills.alwaysOn.contains(info.id) {
                    Text("Always on").font(.callout).foregroundStyle(.secondary)
                } else {
                    Toggle("", isOn: Binding(get: { on }, set: { m.request(info.id, $0) }))
                        .toggleStyle(.switch).labelsHidden()
                        .help(on ? "Turn \(SkillCatalog.title(info.id)) off" : "Turn \(SkillCatalog.title(info.id)) on")
                }
            }
            Text(info.description).font(.callout).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)

            // Permissions at a glance
            FlowChips(items: permissionChips(info))

            let links = SkillCatalog.links(info.id)
            if !links.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Uses").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(Array(links.enumerated()), id: \.offset) { _, link in linkRow(link) }
                }
            }
            if info.id == "personal" {
                Label("Reads Calendar and Reminders on this Mac when you ask. Nothing is stored, logged or sent anywhere. macOS asks once for access.",
                      systemImage: "lock.shield")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if info.id == "convert" {
                HStack {
                    Text("Max file size for conversions (MB)").font(.callout)
                    TextField("", text: $m.maxMB).frame(width: 80).multilineTextAlignment(.trailing).onSubmit { m.commitMaxMB() }
                    Button("Set") { m.commitMaxMB() }.controlSize(.small)
                }
                .disabled(!on)
            }
            if !info.examples.isEmpty {
                Text("Try: " + info.examples.prefix(2).map { "“\($0)”" }.joined(separator: "  "))
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.2)))
        .opacity(on ? 1 : 0.65)
    }

    private func permissionChips(_ info: SkillInfo) -> [SkillChip] {
        var out: [SkillChip] = info.capabilities.map { c in
            let d = SkillCatalog.capability(c)
            let risky = ["job", "run_approved", "network", "frontier", "write_new"].contains(c)
            return SkillChip(text: d.label, symbol: d.symbol, color: risky ? .orange : .secondary, help: d.detail)
        }
        let lane = SkillCatalog.lane(info.lane)
        out.append(SkillChip(text: "Lane: " + lane.label, symbol: "square.dashed", color: info.lane == "contained" ? .secondary : .orange, help: lane.detail))
        let eg = SkillCatalog.egress(info.egress)
        out.append(SkillChip(text: eg.label, symbol: eg.leaves ? "arrow.up.right.circle" : "desktopcomputer", color: eg.leaves ? .orange : .green, help: eg.detail))
        return out
    }

    @ViewBuilder private func linkRow(_ link: SkillLink) -> some View {
        HStack(spacing: 6) {
            let (icon, color, status) = linkStatus(link)
            Image(systemName: icon).foregroundStyle(color).frame(width: 16)
            Text(link.label).font(.callout)
            Text("— " + link.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
            if !status.isEmpty { Text(status).font(.caption).foregroundStyle(color) }
            switch link.kind {
            case .plugin, .setting: Button("Settings…", action: openSettings).controlSize(.mini)
            case .copilot: Button("Backend…", action: openBackend).controlSize(.mini)
            case .macPermission:
                Button("Privacy…") {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")!)
                }.controlSize(.mini)
            case .tool: EmptyView()
            }
        }
    }

    private func linkStatus(_ link: SkillLink) -> (String, Color, String) {
        switch link.kind {
        case .plugin(let id):
            let st = state.pluginStatus(id)
            if id == .translate { return st.ready ? ("checkmark.circle.fill", .green, "ready") : ("exclamationmark.circle", .orange, "needs language packs") }
            if !st.installed { return ("plus.circle", .secondary, "not installed") }
            if !state.pluginEnabled(id) { return ("pause.circle", .secondary, "plugin off") }
            return st.ready ? ("checkmark.circle.fill", .green, "ready") : ("exclamationmark.circle", .orange, "not running")
        case .copilot:
            return Copilot.installed() ? ("checkmark.circle", .green, "installed") : ("plus.circle", .secondary, "not installed")
        case .macPermission: return ("hand.raised", .purple, "")
        case .setting: return ("gearshape", .secondary, "")
        case .tool: return ("wrench.and.screwdriver", .secondary, "")
        }
    }

    private var legend: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("How to read this").font(.caption.weight(.semibold))
            Text("Orange chips are the powers that reach outside the answer: local jobs, runs, network, cloud models, new files. Every one of them still waits for your approval in the chat. “Stays on this Mac” means the skill makes no network call (its evals check that). Saved in ~/OnBud/config/skills.json.")
        }
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }

    private func badge(_ text: String, _ symbol: String, _ color: Color) -> some View {
        Label(text, systemImage: symbol).font(.caption2.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.12)))
    }
}

struct SkillChip: Hashable {
    let text: String, symbol: String, color: Color, help: String
}

/** Chips that wrap onto as many lines as they need. */
struct FlowChips: View {
    let items: [SkillChip]
    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(items, id: \.self) { c in
                Label(c.text, systemImage: c.symbol)
                    .font(.caption).foregroundStyle(c.color == .secondary ? Color.primary.opacity(0.75) : c.color)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Capsule().fill((c.color == .secondary ? Color.secondary : c.color).opacity(0.12)))
                    .help(c.help)
            }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 600
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0, x + sz.width > width { x = 0; y += line + spacing; line = 0 }
            x += sz.width + spacing; line = max(line, sz.height); maxX = max(maxX, x - spacing)
        }
        return CGSize(width: proposal.width ?? maxX, height: y + line)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > bounds.minX, x + sz.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing; line = max(line, sz.height)
        }
    }
}
