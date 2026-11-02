// Panel content: the question field, attachments, folder/model/attach/history menus, quick actions for the
// folder, streamed answers with live progress, approve/deny buttons for what the controller waits for,
// and a setup screen when no OpenAFM backend is installed or running.
import AppKit
import SpotlightCore
import SwiftUI
import UniformTypeIdentifiers

struct SpotlightView: View {
    @ObservedObject var state: AppState
    var pickFolder: () -> Void
    var pickFiles: () -> Void
    var openSettings: () -> Void
    var openActivity: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            inputRow
            if !state.attachments.isEmpty { attachmentRow }
            Divider().opacity(0.5)
            optionsRow
            if state.probed && !state.status.usable {
                Divider().opacity(0.5)
                SetupView(state: state, openSettings: openSettings)
            } else if !state.turns.isEmpty || state.notice != nil {
                Divider().opacity(0.5)
                if state.collapsed { collapsedBar } else { results }
            } else if state.query.isEmpty {
                quickActions
            }
        }
        .frame(width: 720)
        .background(Color.panelBackground)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(.black.opacity(0.08)))
        .ignoresSafeArea()
        // Drop files (Finder, Mail attachments…) onto the panel to ask about them.
        .onDrop(of: [UTType.fileURL], isTargeted: nil) { providers in
            for p in providers {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url { DispatchQueue.main.async { state.attach([.file(url)]) } }
                }
            }
            return true
        }
        .onAppear { focused = true }
        .onReceive(NotificationCenter.default.publisher(for: .spotlightShown)) { _ in focused = true }
    }

    /** Top: OpenAFM logo + the question field. */
    private var inputRow: some View {
        HStack(spacing: 12) {
            Group {
                if let logo = Bundle.main.image(forResource: "PanelIcon") { Image(nsImage: logo).resizable().interpolation(.high) }
                else { Image(systemName: "sparkle.magnifyingglass").resizable() }
            }
            .frame(width: 28, height: 28)
            .opacity(state.running ? 0.45 : 1)
            TextField(state.needsApproval ? "Reply, or use the buttons below" : state.attachments.isEmpty ? "Ask OpenAFM" : "Ask about the attached items", text: $state.query)
                .textFieldStyle(.plain)
                .font(.system(size: 22))
                .focused($focused)
                .onSubmit { state.submit() }
                .disabled(state.running)
            if state.running { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 18)
        .frame(height: 60)
    }

    private var attachmentRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(state.attachments) { a in
                    HStack(spacing: 4) {
                        Image(systemName: { if case .file = a { return "doc" } else { return "text.quote" } }())
                        Text(a.label).lineLimit(1)
                        Button { state.detach(a) } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(.secondary)
                    }
                    .font(.system(size: 12))
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Color.accentColor.opacity(0.12), in: Capsule())
                }
            }
            .padding(.horizontal, 18)
        }
        .frame(height: 30)
        .padding(.bottom, 6)
    }

    /** Bottom: project folder, model, attach, history. */
    private var optionsRow: some View {
        HStack(spacing: 6) {
            Menu {
                ForEach(state.recentFolders, id: \.self) { f in
                    Button(f.replacingOccurrences(of: NSHomeDirectory(), with: "~")) { state.setProjectFolder(f) }
                }
                if !state.recentFolders.isEmpty { Divider() }
                Button("Choose folder…", action: pickFolder)
            } label: { Label(folderName, systemImage: "folder") }
            .menuStyle(.button).buttonStyle(Chip()).fixedSize()
            .help(state.projectRoot ?? "Pick the project folder OpenAFM may read")

            Menu {
                Picker("Model", selection: $state.useDecima) {
                    Text(Setting.s2.label).tag(false)
                    if state.pluginEnabled(.decima) {
                        Text(state.routerLabel + (state.decimaAvailable ? "" : " — router not running")).tag(true)
                            .disabled(!state.decimaAvailable)
                    }
                }
                .pickerStyle(.inline)
                if !state.pluginEnabled(.decima) { Text("AFM + a router model needs the Router model plugin (Settings > Plugins)") }
                if state.pluginEnabled(.decima) && state.routerModels.count > 1 {
                    Picker("Router model", selection: Binding(get: { state.activeRouter?.name ?? "" }, set: { state.routerModel = $0 })) {
                        ForEach(state.routerModels) { m in Text(m.name).tag(m.name) }
                    }
                }
                Divider()
                Toggle("Web search (approve each query)", isOn: Binding(get: { state.pluginEnabled(.web) }, set: { state.setPlugin(.web, enabled: $0) }))
                Divider()
                Button("Settings…", action: openSettings)
            } label: { Label(state.modelLabel, systemImage: "cpu") }
            .menuStyle(.button).buttonStyle(Chip()).fixedSize()
            .help(state.setting == .s3 ? "AFM Agent, advised by \(state.activeRouter?.name ?? "the router model")" : state.setting.detail)

            Menu {
                Button("Paste from clipboard") { state.attachClipboard() }
                Button("Choose files…", action: pickFiles)
                Text("Or drop files on the panel, or use Services > Ask OpenAFM in any app")
            } label: { Image(systemName: "paperclip") }
            .menuStyle(.button).buttonStyle(Chip()).fixedSize()
            .help("Attach files or the clipboard")

            Menu {
                if state.history.isEmpty { Text(state.keepHistory ? "No saved chats yet" : "Chat history is off (Settings)") }
                ForEach(state.history.prefix(12)) { chat in
                    Button(String(chat.title.prefix(60)) + " — " + chat.date.formatted(.relative(presentation: .named))) { state.open(chat) }
                }
                Divider()
                Button("Activity (jobs, background sessions)…", action: openActivity)
                if !state.history.isEmpty { Button("Clear history", role: .destructive) { state.clearHistory() } }
            } label: { Image(systemName: "clock") }
            .menuStyle(.button).buttonStyle(Chip()).fixedSize()
            .help("Recent chats and activity")

            Spacer()
            Text(state.needsApproval ? "⌘↩ yes · ⌘⌫ no" : "↩ ask · esc close")
                .font(.caption).foregroundStyle(.tertiary)
            if !state.turns.isEmpty {
                Button { state.collapsed.toggle() } label: {
                    Image(systemName: state.collapsed ? "chevron.down" : "chevron.up")
                }
                .buttonStyle(Chip())
                .keyboardShortcut("l", modifiers: .command)
                .help(state.collapsed ? "Show the answers (⌘L)" : "Fold the answers away (⌘L); the chat stays")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
    }

    /** Folded answers: one line, click to unfold. */
    private var collapsedBar: some View {
        Button { state.collapsed = false } label: {
            HStack(spacing: 6) {
                Image(systemName: "text.bubble")
                Text(state.turns.last.map { "“\($0.prompt.prefix(50))”" } ?? "")
                    .lineLimit(1)
                Text("· \(state.turns.count) answer\(state.turns.count == 1 ? "" : "s") folded")
                    .foregroundStyle(.tertiary)
                Spacer()
                if state.needsApproval || state.offersHandoff { Text("waiting for you").foregroundStyle(.orange) }
                else if state.running { ProgressView().controlSize(.small) }
            }
            .font(.callout).foregroundStyle(.secondary)
            .padding(.horizontal, 18).frame(height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /** One-click requests that fit the folder (shown while the panel is empty). */
    private var quickActions: some View {
        let actions = QuickActions.suggest(root: state.projectRoot, latex: state.pluginEnabled(.latex) && state.pluginStatus(.latex).installed)
        return VStack(spacing: 0) {
            Divider().opacity(0.5)
            // Up to eight chips in a git repo with papers and documents: scroll sideways rather than clip.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(actions) { a in
                        Button { state.send(a.prompt) } label: { Label(a.title, systemImage: a.symbol) }
                            .buttonStyle(Chip()).fixedSize()
                    }
                }
                .padding(.horizontal, 14)
            }
            .frame(height: 40)
        }
    }

    private var results: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(state.turns) { t in TurnView(turn: t, state: state).id(t.id) }
                    }
                    .padding(.horizontal, 18).padding(.top, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 420)
                .onChange(of: state.turns) { _, t in if let last = t.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            if let notice = state.notice {
                Text(notice).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 18)
            }
            actions
                .padding(.horizontal, 18).padding(.bottom, 14)
        }
    }

    @ViewBuilder private var actions: some View {
        HStack(spacing: 8) {
            if state.needsApproval && !state.running {
                Button("Yes, \(approveVerb)") { state.send("yes") }
                    .keyboardShortcut(.return, modifiers: .command)
                    .buttonStyle(.borderedProminent)
                Button("No") { state.send("no") }
                    .keyboardShortcut(.delete, modifiers: .command)
            } else if state.offersHandoff && !state.running {
                if state.codexAvailable {
                    Button("Send to Codex (OpenCode)") { state.sendToCodex() }
                        .keyboardShortcut(.return, modifiers: .command)
                        .buttonStyle(.borderedProminent)
                }
                Button("Try locally on a branch") { state.send("local") }
                Button("No") { state.send("no") }
            }
            Spacer()
            if !state.turns.isEmpty {
                // Ends this chat: the controller forgets its history and pending approvals (folding keeps both).
                Button("New chat") { state.resetConversation() }
                    .keyboardShortcut("n", modifiers: .command)
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .help("Start over: forget this chat's context and pending approvals (⌘N)")
            }
        }
        .controlSize(.regular)
    }

    /** Folder chip text; long names are shortened so the chip stays compact. */
    private var folderName: String {
        guard let root = state.projectRoot else { return "Choose folder" }
        let name = URL(fileURLWithPath: root).lastPathComponent
        return name.count > 28 ? name.prefix(26) + "…" : name
    }

    private var approveVerb: String {
        switch state.awaiting {
        case "command": return "run it"
        case "edit": return "try the edit"
        case "apply": return "apply"
        case "web": return "search"
        case "job": return "go ahead"
        default: return "go ahead"
        }
    }
}

struct TurnView: View {
    let turn: Turn
    @ObservedObject var state: AppState
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(turn.prompt).font(.headline).foregroundStyle(.secondary).lineLimit(3)
                Spacer()
                if !turn.running && !turn.reply.isEmpty {
                    Button { state.copy(turn) } label: { Image(systemName: "doc.on.doc") }.help("Copy the answer")
                    Button { state.save(turn) } label: { Image(systemName: "square.and.arrow.down") }.help("Save the answer as Markdown")
                }
            }
            .buttonStyle(.borderless)
            if !turn.attachments.isEmpty {
                Text(turn.attachments.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
            }
            if !turn.reply.isEmpty {
                MarkdownText(text: turn.reply, root: state.chatRoot)
                    .environment(\.openURL, OpenURLAction { state.openLink($0) })
            } else if turn.running && turn.error == nil {
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text(turn.progress ?? "Working on it…").foregroundStyle(.secondary) }
            }
            if let error = turn.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            if let meta = turn.meta { Text(meta).font(.caption).foregroundStyle(.tertiary) }
        }
        .textSelection(.enabled)
    }
}

/** Renders the controller's Markdown as blocks: headings, tables (as a grid), lists, quotes, code blocks. */
struct MarkdownText: View {
    let text: String
    var root: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(MarkdownBlocks.parse(text).enumerated()), id: \.offset) { _, b in block(b) }
        }
    }

    @ViewBuilder private func block(_ b: MDBlock) -> some View {
        switch b {
        case .heading(let level, let t):
            Text(Self.inline(t, root: root))
                .font(level <= 2 ? .title3.weight(.semibold) : .headline)
                .padding(.top, 4)
        case .paragraph(let t):
            Text(Self.inline(t, root: root)).font(.body).fixedSize(horizontal: false, vertical: true)
        case .bullet(let indent, let marker, let t):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker).foregroundStyle(.secondary).frame(minWidth: 14, alignment: .trailing)
                Text(Self.inline(t, root: root)).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, CGFloat(indent) * 16)
        case .quote(let t):
            Text(Self.inline(t, root: root)).foregroundStyle(.secondary)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(.tertiary).frame(width: 3) }
        case .code(_, let t):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(t).font(.system(.callout, design: .monospaced)).textSelection(.enabled).padding(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.codeBackground, in: RoundedRectangle(cornerRadius: 8))
        case .table(let header, let rows):
            TableBlock(header: header, rows: rows, root: root)
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }

    /** Inline Markdown. `code` gets a tinted monospaced look. Links are clickable (AppState.openLink decides
     *  what opens): web links, and file paths resolved against the project folder — Markdown links, bare
     *  https:// URLs and `path/to/file` spans that name an existing file. Other schemes stay plain text. A link
     *  whose text differs from its target shows the target after it, so a quoted document cannot disguise one. */
    static func inline(_ s: String, root: String? = nil) -> AttributedString {
        guard var a = try? AttributedString(markdown: MarkdownLinks.autolinked(s), options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) else { return AttributedString(s) }
        for run in a.runs.reversed() {   // back to front: inserts shift later ranges
            let text = String(a[run.range].characters)
            if run.inlinePresentationIntent?.contains(.code) == true {
                a[run.range].font = .system(.callout, design: .monospaced)
                a[run.range].backgroundColor = Color.codeBackground
                if run.link == nil, let file = MarkdownLinks.fileURL(text, root: root, mustExist: true) {
                    a[run.range].link = file
                    a[run.range].underlineStyle = .single
                }
            }
            guard let link = run.link else { continue }
            let target: URL? = ["http", "https", "mailto"].contains(link.scheme?.lowercased() ?? "") ? link
                : link.scheme == nil || link.scheme == "file" ? MarkdownLinks.fileURL(link.scheme == "file" ? link.path : link.relativeString.removingPercentEncoding ?? link.relativeString, root: root, mustExist: false)
                : nil
            a[run.range].link = target
            a[run.range].underlineStyle = .single
            if target != nil, run.inlinePresentationIntent?.contains(.code) != true { a[run.range].foregroundColor = .accentColor }
            let shown = target.map { $0.isFileURL ? $0.path.replacingOccurrences(of: NSHomeDirectory(), with: "~") : $0.absoluteString } ?? link.absoluteString
            if text != shown && text != link.absoluteString && run.inlinePresentationIntent?.contains(.code) != true {
                a.insert(AttributedString(" (\(shown))"), at: run.range.upperBound)
            }
        }
        return a
    }
}

/** A Markdown table as a grid: bold header, zebra rows, rounded border. */
struct TableBlock: View {
    let header: [String]
    let rows: [[String]]
    var root: String?
    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(header.enumerated()), id: \.offset) { _, h in
                    cell(h).font(.callout.weight(.semibold))
                }
            }
            .background(Color.codeBackground)
            ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                Divider().opacity(0.4)
                GridRow {
                    ForEach(Array(r.enumerated()), id: \.offset) { _, c in cell(c).font(.callout) }
                }
                .background(i % 2 == 1 ? Color.codeBackground.opacity(0.45) : .clear)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
    }

    private func cell(_ s: String) -> some View {
        Text(MarkdownText.inline(s, root: root))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SetupView: View {
    @ObservedObject var state: AppState
    var openSettings: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if state.status.nothingInstalled {
                Text("Set up OpenAFM").font(.headline)
                Text("OpenAFM answers with Apple's on-device model through apfel and its own controller. Setup opens Terminal, checks what is missing (Homebrew, apfel, Node.js) and asks before installing each one from its own project, then starts both services on this Mac only.")
                    .foregroundStyle(.secondary)
                Text("Requires an Apple silicon Mac with macOS 26 or later and Apple Intelligence turned on.").font(.callout).foregroundStyle(.secondary)
            } else {
                Text("The AFM controller is not reachable").font(.headline)
                StatusList(status: state.status)
                Text("The LaunchAgents start it at login. To start it now:").foregroundStyle(.secondary)
                Text("launchctl kickstart -k gui/\(getuid())/dev.openafm.agent")
                    .font(.system(.callout, design: .monospaced)).textSelection(.enabled)
            }
            if let notice = state.notice { Text(notice).font(.callout).foregroundStyle(.secondary) }
            HStack {
                if state.status.nothingInstalled || !state.status.checkout {
                    Button("Set up OpenAFM…") { state.runSetup() }.buttonStyle(.borderedProminent)
                    Button("Check again") { Task { await state.probe() } }
                } else {
                    Button("Check again") { Task { await state.probe() } }.buttonStyle(.borderedProminent)
                    Button("Run setup again…") { state.runSetup() }
                }
                Button("Settings…", action: openSettings)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct StatusList: View {
    let status: BackendStatus
    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 4) {
            row("AFM (apfel) · 127.0.0.1:11434", status.apfel)
            row("OpenAFM controller · 127.0.0.1:11435", status.controller)
            row("Router model (Ollaya) · 127.0.0.1:11436", status.decima, optional: true)
            row("~/OpenAFM checkout", status.checkout)
            row("Controller token", status.token)
            row("LaunchAgents dev.openafm.agent / .apfel", status.agentLaunchAgent && status.apfelLaunchAgent)
        }
    }
    private func row(_ name: String, _ ok: Bool, optional: Bool = false) -> some View {
        GridRow {
            Image(systemName: ok ? "checkmark.circle.fill" : (optional ? "minus.circle" : "xmark.circle.fill"))
                .foregroundStyle(ok ? .green : (optional ? .secondary : .red))
            Text(name)
        }
    }
}

struct Chip: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(.quaternary.opacity(configuration.isPressed ? 1 : 0.6), in: Capsule())
    }
}

extension Color {
    /** Tint behind code and table headers. */
    static let codeBackground = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 1, alpha: 0.07) : NSColor(white: 0, alpha: 0.05)
    })
    /** Light gray panel background (dark gray in Dark Mode). */
    static let panelBackground = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 0.17, alpha: 1) : NSColor(white: 0.965, alpha: 1)
    })
}

extension Notification.Name {
    static let spotlightShown = Notification.Name("AFMSpotlightShown")
}
