// Shared state for the panel, Settings, Backend and Activity windows: preferences, backend and plugin
// status, the current conversation (with attachments and live progress), history and recent folders.
import AppKit
import ServiceManagement
import SpotlightCore
import SwiftUI
import UserNotifications
import WidgetKit

struct Turn: Identifiable, Equatable {
    let id = UUID()
    var prompt: String           // as typed (attachments are listed separately)
    var attachments: [String] = []
    var reply = ""
    var meta: String?
    var error: String?
    var progress: String?        // latest controller step while running
    var running = true
}

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()
    let paths = OpenAFMPaths()
    private let defaults = UserDefaults.standard
    private let historyStore = HistoryStore()

    @Published var status = BackendStatus()
    @Published var probed = false
    @Published var query = ""
    @Published var turns: [Turn] = []
    @Published var awaiting: String?
    @Published var running = false
    @Published var notice: String?
    @Published var attachments: [Attachment] = []
    @Published var history: [SavedChat] = []
    @Published var collapsed = false     // answers folded away (the chat stays)

    @Published var hotKey: HotKeyChoice { didSet { defaults.set(hotKey.rawValue, forKey: "hotKey"); onHotKeyChange?(hotKey) } }
    @Published var useDecima: Bool { didSet { defaults.set(useDecima, forKey: "useDecima") } }
    @Published var projectRoot: String? {
        didSet {
            defaults.set(projectRoot, forKey: "projectFolder")
            if let p = projectRoot { recentFolders = RecentFolders.updated(recentFolders, adding: p) }
            if !restoring { resetConversation() }
        }
    }
    @Published var recentFolders: [String] { didSet { defaults.set(recentFolders, forKey: "recentFolders") } }
    @Published var keepHistory: Bool { didSet { defaults.set(keepHistory, forKey: "keepHistory"); if !keepHistory { clearHistory() } } }
    @Published var notifyWhenDone: Bool { didSet { defaults.set(notifyWhenDone, forKey: "notifyWhenDone") } }
    @Published var hotKeyWarning: String?
    @Published var plugins: [PluginID: PluginStatus] = [:]
    @Published var routerModels: [RouterModel] = []
    @Published var routerModel: String { didSet { defaults.set(routerModel, forKey: "routerModel") } }
    @Published var widgetShowsChat: Bool { didSet { defaults.set(widgetShowsChat, forKey: "widgetShowsChat"); updateWidget() } }

    var onHotKeyChange: ((HotKeyChoice) -> Void)?
    var isPanelVisible: () -> Bool = { true }
    var showPanel: () -> Void = {}
    var holdPanel: (Bool) -> Void = { _ in }
    private var conversation: Conversation
    private var chatID = UUID()
    private var task: Task<Void, Never>?
    private var lastSent: Date?
    private var restoring = false

    init() {
        hotKey = HotKeyChoice(rawValue: defaults.string(forKey: "hotKey") ?? "") ?? .optionSpace
        useDecima = defaults.bool(forKey: "useDecima")
        keepHistory = defaults.object(forKey: "keepHistory") as? Bool ?? true
        notifyWhenDone = defaults.object(forKey: "notifyWhenDone") as? Bool ?? true
        routerModel = defaults.string(forKey: "routerModel") ?? "decima:agent"
        widgetShowsChat = defaults.object(forKey: "widgetShowsChat") as? Bool ?? true
        recentFolders = (defaults.stringArray(forKey: "recentFolders") ?? []).filter { ProjectFolder.problem($0) == nil }
        // Default project folder: ~/Desktop (the user can pick another one in the panel).
        let saved = defaults.string(forKey: "projectFolder")
        let desktop = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop").path
        let root = (saved.flatMap { ProjectFolder.problem($0) == nil ? $0 : nil }) ?? (FileManager.default.fileExists(atPath: desktop) ? desktop : nil)
        projectRoot = root
        conversation = Conversation(root: root)
        history = keepHistory ? historyStore.load() : []
    }

    /** AFM + router (S3) only when picked and the router plugin is on and running; otherwise AFM Agent (S2). */
    var setting: Setting { useDecima && decimaAvailable ? .s3 : .s2 }

    /** The installed router model in use: the saved choice if Ollaya still has it, else decima:agent or the first. */
    var activeRouter: RouterModel? {
        routerModels.first { $0.name == routerModel } ?? routerModels.first { $0.name == "decima:agent" } ?? routerModels.first
    }
    /** "AFM + Decima" for decima:agent, "AFM + <Name>" for another router model. */
    var routerLabel: String { "AFM + " + (activeRouter?.shortName ?? "Router") }
    var modelLabel: String { setting == .s3 ? routerLabel : Setting.s2.label }

    func probe() async {
        status = await Backend.probe(paths: paths)
        routerModels = status.decima ? await Backend.routerModels() : []
        for id in PluginID.allCases { plugins[id] = Plugins.detect(id, backend: status, paths: paths) }
        probed = true
    }

    // MARK: conversation

    func resetConversation() {
        task?.cancel()
        conversation = Conversation(root: projectRoot)
        chatID = UUID()
        turns = []; awaiting = nil; running = false; notice = nil; lastSent = nil; attachments = []; collapsed = false
        updateWidget()
    }

    func submit() {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty, !running else { return }
        query = ""
        send(text.isEmpty ? "Summarize this." : text)
    }

    /** Sends a user turn (a request, or "yes"/"no"/"local" for what the controller waits for). */
    func send(_ text: String) {
        guard let token = paths.readToken() else { notice = ClientError.noToken.errorDescription; return }
        // Follow-ups stay in one chat (the controller uses the last turns as history); after 30 idle minutes,
        // when its pending approvals have expired anyway, start over.
        if let last = lastSent, Date().timeIntervalSince(last) > 30 * 60 { resetConversation() }
        lastSent = Date()
        // Files outside the project folder: the chat reads from their folder instead.
        let files = attachments.compactMap { if case .file(let u) = $0 { return u } else { return nil } }
        if let r = Attachments.root(for: files, current: conversation.root), r != conversation.root {
            if let problem = ProjectFolder.problem(r) { notice = problem; return }
            if conversation.messages.isEmpty { conversation.root = r; notice = "Reading from \(URL(fileURLWithPath: r).lastPathComponent) for this chat." }
            else { notice = "Those files are outside this chat's folder; start a New chat to use them."; return }
        }
        let content = Attachments.compose(text, attachments, root: conversation.root)
        conversation.messages.append(ChatMessage(role: "user", content: content))
        turns.append(Turn(prompt: text, attachments: attachments.map(\.label)))
        attachments = []
        awaiting = nil; running = true; collapsed = false
        let client = ControllerClient(token: token, setting: setting, web: pluginEnabled(.web), routerModel: activeRouter?.name)
        let messages = conversation.messages, root = conversation.root
        let chat = chatID
        updateWidget(running: true)
        task = Task { [weak self] in
            var reply = ""
            do {
                for try await ev in client.stream(messages: messages, root: root) {
                    guard let self, self.chatID == chat else { return }
                    switch ev {
                    case .text(let t):
                        reply += t
                        let (body, meta) = splitMeta(reply)
                        try await self.reveal(body)
                        self.updateLast { $0.meta = meta }
                    case .step(let kind, let detail):
                        self.updateLast { $0.progress = StepLabel.text(kind, detail) }
                    case .done(let a):
                        self.awaiting = a
                    }
                }
            } catch is CancellationError {
                return   // New chat / another chat opened: this turn is gone
            } catch {
                guard let self, self.chatID == chat else { return }
                self.updateLast { $0.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
            }
            // A cancelled request must not write into the chat that replaced it.
            guard let self, self.chatID == chat, !Task.isCancelled else { return }
            self.conversation.messages.append(ChatMessage(role: "assistant", content: reply))
            self.conversation.awaiting = self.awaiting
            self.updateLast { $0.running = false; $0.progress = nil }
            self.running = false
            self.saveChat()
            self.updateWidget()
            self.notifyIfHidden(text: splitMeta(reply).body)
        }
    }

    private func updateLast(_ f: (inout Turn) -> Void) {
        guard !turns.isEmpty else { return }
        f(&turns[turns.count - 1])
    }

    /** The controller sends a finished answer in one piece (one structured AFM generation), so the panel
     *  writes it out word by word — at most ~0.8 s, however long — instead of dropping it in at once. */
    private func reveal(_ body: String) async throws {
        let shown = turns.last?.reply ?? ""
        guard body.hasPrefix(shown), body.count > shown.count else { updateLast { $0.reply = body }; return }
        let chars = Array(body)
        var i = shown.count
        let step = max(8, (chars.count - i) / 50)
        while i < chars.count {
            var j = min(chars.count, i + step)
            while j < chars.count, !chars[j].isWhitespace { j += 1 }   // end on a word boundary
            i = j
            updateLast { $0.reply = String(chars[..<i]) }
            if i < chars.count { try await Task.sleep(for: .milliseconds(16)) }
        }
    }

    /** The folder this chat reads from (attachments can move it away from the project folder). */
    var chatRoot: String? { conversation.root }

    var needsApproval: Bool { awaiting.map { Conversation.approvable.contains($0) } ?? false }
    var offersHandoff: Bool { awaiting == "handoff" }

    // MARK: attachments

    func attach(_ items: [Attachment]) {
        for a in items where !attachments.contains(a) { attachments.append(a) }
    }
    func detach(_ a: Attachment) { attachments.removeAll { $0 == a } }

    /** Clipboard: files copied in Finder become file attachments, otherwise the copied text. */
    func attachClipboard() {
        let pb = NSPasteboard.general
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            attach(urls.map { .file($0) })
        } else if let text = pb.string(forType: .string), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            attach([.text(text, source: "clipboard")])
        } else {
            notice = "The clipboard has no text or files."
        }
    }

    // MARK: answers

    func copy(_ turn: Turn) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(turn.reply, forType: .string)
        notice = "Answer copied."
    }

    func save(_ turn: Turn) {
        let sp = NSSavePanel()
        sp.nameFieldStringValue = String(turn.prompt.prefix(40)).replacingOccurrences(of: "/", with: "-") + ".md"
        sp.allowedContentTypes = [.init(filenameExtension: "md")!]
        if let r = projectRoot { sp.directoryURL = URL(fileURLWithPath: r) }
        sp.level = .modalPanel
        holdPanel(true)
        NSApp.activate()
        let result = sp.runModal()
        holdPanel(false)
        showPanel()
        guard result == .OK, let url = sp.url else { return }
        let md = "# \(turn.prompt)\n\n\(turn.reply)\n" + (turn.meta.map { "\n---\n\($0)\n" } ?? "")
        do { try md.write(to: url, atomically: true, encoding: .utf8); notice = "Saved \(url.lastPathComponent)." }
        catch { notice = "Could not save: \(error.localizedDescription)" }
    }

    // MARK: history

    private func saveChat() {
        guard keepHistory, !conversation.messages.isEmpty else { return }
        history = historyStore.save(SavedChat(id: chatID, root: conversation.root, messages: conversation.messages))
    }

    /** Re-opens a saved chat; follow-ups continue it (the controller keys approvals to its first message). */
    func open(_ chat: SavedChat) {
        task?.cancel()
        chatID = chat.id
        conversation = Conversation(root: chat.root)
        conversation.messages = chat.messages
        if let r = chat.root, r != projectRoot, ProjectFolder.problem(r) == nil { restoring = true; projectRoot = r; restoring = false }
        turns = stride(from: 0, to: chat.messages.count, by: 1).compactMap { i -> Turn? in
            guard chat.messages[i].role == "user" else { return nil }
            var t = Turn(prompt: chat.messages[i].content.components(separatedBy: "\n\nFiles: ").first?.components(separatedBy: "\n\nText (").first ?? "")
            if i + 1 < chat.messages.count, chat.messages[i + 1].role == "assistant" {
                let (body, meta) = splitMeta(chat.messages[i + 1].content); t.reply = body; t.meta = meta
            }
            t.running = false
            return t
        }
        awaiting = nil; running = false; attachments = []; collapsed = false
        lastSent = chat.date
        updateWidget()
        notice = chat.root.map { "Chat in \(URL(fileURLWithPath: $0).lastPathComponent) · \(chat.date.formatted(date: .abbreviated, time: .shortened))" }
    }

    func clearHistory() {
        historyStore.clear(); history = []
        WidgetSnapshot.clear(); WidgetCenter.shared.reloadTimelines(ofKind: WidgetSnapshot.kind)
    }

    // MARK: chat widget (Widget/ChatWidget.swift reads the snapshot)

    func updateWidget(running: Bool = false) {
        let last = turns.last
        if widgetShowsChat, let last {
            WidgetSnapshot(question: last.prompt, answer: WidgetSnapshot.plain(last.reply), folder: conversation.root.map { URL(fileURLWithPath: $0).lastPathComponent },
                           running: running).save()
        } else {
            WidgetSnapshot.clear()
        }
        WidgetCenter.shared.reloadTimelines(ofKind: WidgetSnapshot.kind)
    }

    // MARK: links in answers

    /** Opens a link from an answer: web pages in the browser; files and folders inside the home folder in
     *  their app or Finder; anything that could run (apps, scripts, installers) is only shown in Finder. */
    func openLink(_ url: URL) -> OpenURLAction.Result {
        let ws = NSWorkspace.shared
        switch url.scheme?.lowercased() {
        case "http", "https", "mailto":
            ws.open(url); return .handled
        case "file":
            let path = url.standardizedFileURL.resolvingSymlinksInPath().path
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            guard path.hasPrefix(home + "/") else { notice = "Not opened: \(path) is outside your home folder."; return .handled }
            var dir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &dir) else { notice = "\(path) does not exist."; return .handled }
            let runnable: Set<String> = ["app", "command", "sh", "zsh", "bash", "tool", "pkg", "mpkg", "terminal", "workflow", "scpt",
                                         "applescript", "jar", "webloc", "inetloc", "fileloc", "dmg", "prefpane", "action", "py", "rb", "pl"]
            let ext = (path as NSString).pathExtension.lowercased()
            if dir.boolValue && ext != "app" { ws.open(URL(fileURLWithPath: path)) }
            else if runnable.contains(ext) || FileManager.default.isExecutableFile(atPath: path) {
                ws.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                notice = "Shown in Finder (not opened: it could run code)."
            } else { ws.open(URL(fileURLWithPath: path)) }
            return .handled
        default:
            notice = "Not opened: \(url.scheme ?? "this") links are not followed."
            return .handled
        }
    }

    // MARK: notifications

    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    private func notifyIfHidden(text: String) {
        guard notifyWhenDone, !isPanelVisible() else { return }
        let content = UNMutableNotificationContent()
        content.title = "OpenAFM answered"
        content.body = String(text.prefix(160))
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    // MARK: plugins

    func pluginStatus(_ id: PluginID) -> PluginStatus { plugins[id] ?? PluginStatus() }
    func pluginEnabled(_ id: PluginID) -> Bool { Plugins.isEnabled(id, installed: pluginStatus(id).installed) }
    func setPlugin(_ id: PluginID, enabled: Bool) {
        Plugins.setEnabled(id, enabled)
        objectWillChange.send()
    }
    /** The model menu offers AFM + router only with the router plugin enabled, Ollaya running and a model installed. */
    var decimaAvailable: Bool { pluginEnabled(.decima) && status.decima && activeRouter != nil }
    var codexAvailable: Bool { pluginEnabled(.codex) && pluginStatus(.codex).installed }

    /** Opens Terminal with the plugin's install commands; the script asks before running anything. */
    func install(_ id: PluginID) {
        runInTerminal(Plugins.installCommandFile(id, repo: paths.repo), prefix: "openafm-install-")
        notice = "Installing \(id.name) in Terminal. Press Check again when it is done."
    }

    /** Writes a one-off .command script (owner-only) and opens it in Terminal; earlier ones are removed. */
    func runInTerminal(_ script: String, prefix: String) {
        let tmp = FileManager.default.temporaryDirectory
        for old in (try? FileManager.default.contentsOfDirectory(at: tmp, includingPropertiesForKeys: nil)) ?? [] where old.lastPathComponent.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: old)
        }
        let file = tmp.appendingPathComponent("\(prefix)\(UUID().uuidString.prefix(8)).command")
        do {
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
            NSWorkspace.shared.open(file)
        } catch { notice = "Could not open Terminal: \(error.localizedDescription)" }
    }

    // MARK: setup (the app bundles the controller; scripts/setup.sh installs apfel, Node and the LaunchAgents)

    /** The controller copy inside the app (make app puts it in Resources/backend), if this build has one. */
    var bundledBackend: URL? {
        Bundle.main.resourceURL.map { $0.appendingPathComponent("backend") }
            .flatMap { FileManager.default.fileExists(atPath: $0.appendingPathComponent("scripts/setup.sh").path) ? $0 : nil }
    }

    /** Opens Terminal with the setup: copies the bundled controller to ~/OpenAFM/adaptive-coding-agent (never
     *  over a git checkout or a folder that is not an OpenAFM copy), then runs its scripts/setup.sh, which
     *  asks before installing anything. */
    func runSetup() {
        let dest = paths.repo.path
        var script = "#!/bin/zsh\nDEST=\(shellQuote(dest))\n"
        if let src = bundledBackend {
            script += """
            SRC=\(shellQuote(src.path))
            if [ -d "$DEST/.git" ]; then
              echo "Using your OpenAFM checkout in $DEST."
            elif [ ! -e "$DEST" ] || [ -f "$DEST/.openafm-bundled" ]; then
              echo "Copying the OpenAFM controller ($(cat "$SRC/.openafm-bundled")) to $DEST"
              mkdir -p "$DEST" && rsync -a --delete "$SRC/" "$DEST/" || exit 1
            else
              echo "$DEST exists but is not an OpenAFM copy; leaving it alone. Move it away and run setup again."; exit 1
            fi

            """
        }
        // The PDF text + OCR helper ships signed inside the app: install it where the controller runs it, so
        // a new user needs neither swiftc nor the Backend window's Install button.
        if let pdf = bundledPdftext {
            script += """
            PDFTEXT=\(shellQuote(installedPdftext.path))
            # cp -X and xattr: the downloaded app's quarantine flag must not follow the helper (macOS would block it).
            if ! cmp -s \(shellQuote(pdf.path)) "$PDFTEXT"; then
              mkdir -p "$(dirname "$PDFTEXT")" && cp -X \(shellQuote(pdf.path)) "$PDFTEXT" && chmod 755 "$PDFTEXT" && { xattr -d com.apple.quarantine "$PDFTEXT" 2>/dev/null; true; } && echo "Installed pdftext (PDF text + OCR) to $PDFTEXT"
            fi

            """
        }
        script += "[ -x \"$DEST/scripts/setup.sh\" ] || { echo \"No OpenAFM controller in $DEST.\"; exit 1; }\n/bin/bash \"$DEST/scripts/setup.sh\"\n"
        runInTerminal(script, prefix: "openafm-setup-")
        notice = "Setting up OpenAFM in Terminal. Press Check again when it is done."
    }

    /** The installed controller copy is older than the one in this app (a git checkout is never "older"). */
    var backendOutdated: Bool {
        guard let src = bundledBackend,
              let mine = try? String(contentsOf: src.appendingPathComponent(".openafm-bundled"), encoding: .utf8),
              let theirs = try? String(contentsOf: paths.repo.appendingPathComponent(".openafm-bundled"), encoding: .utf8) else { return false }
        return mine.trimmingCharacters(in: .whitespacesAndNewlines) != theirs.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: bundled pdftext (PDF text + Vision OCR helper the controller runs from ~/OpenAFM/runtime/bin)

    var bundledPdftext: URL? { Bundle.main.url(forAuxiliaryExecutable: "pdftext") }
    var installedPdftext: URL { paths.home.appendingPathComponent("runtime/bin/pdftext") }
    var pdftextInstalled: Bool { FileManager.default.isExecutableFile(atPath: installedPdftext.path) }

    func installPdftext() {
        guard let src = bundledPdftext else { notice = "This build has no bundled pdftext."; return }
        do {
            try FileManager.default.createDirectory(at: installedPdftext.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: installedPdftext.path) { try FileManager.default.removeItem(at: installedPdftext) }
            try FileManager.default.copyItem(at: src, to: installedPdftext)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: installedPdftext.path)
            removexattr(installedPdftext.path, "com.apple.quarantine", 0)   // a downloaded app's flag must not follow the helper
            notice = "Installed pdftext to \(installedPdftext.path)."
        } catch { notice = "Could not install pdftext: \(error.localizedDescription)" }
        objectWillChange.send()
    }

    // MARK: Codex hand-off (codex plugin)

    /** Sends the last request to Codex in OpenCode: the desktop app if installed (new session with the
     *  request), else the CLI in Terminal. The controller's own hand-off (read-only Codex) is not used. */
    func sendToCodex() {
        guard codexAvailable else { notice = "Turn on the Codex via OpenCode plugin in Settings to hand tasks to Codex."; return }
        let prompt = turns.last?.prompt ?? query
        let dir = conversation.root ?? projectRoot ?? FileManager.default.homeDirectoryForCurrentUser.path
        let text = OpenCodeHandoff.task(prompt: prompt, root: conversation.root ?? projectRoot)
        if let app = OpenCodeInstall.desktopApp {
            notice = "Opening a Codex session in OpenCode…"
            Task {
                do {
                    let ws = NSWorkspace.shared
                    // The app's background service writes service.json when it starts; wait for it after a launch.
                    var service = OpenCodeService.load()
                    if service == nil {
                        _ = try? await ws.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration())
                        for _ in 0..<30 where service == nil { try await Task.sleep(for: .milliseconds(500)); service = OpenCodeService.load() }
                    }
                    guard let service else { throw HandoffError("OpenCode's service did not start; open OpenCode once and try again.") }
                    _ = try await service.startSession(dir: dir, agent: "codex", title: "OpenAFM · \(prompt.prefix(40))", text: text)
                    let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = true
                    _ = try? await ws.openApplication(at: app, configuration: cfg)
                    notice = "Sent to Codex in OpenCode — the new session “OpenAFM · …” is at the top of the session list."
                } catch {
                    notice = "Could not hand off: \((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)"
                }
            }
        } else if let cli = OpenCodeInstall.cli {
            runInTerminal(OpenCodeHandoff.cliScript(cli: cli.path, dir: dir, prompt: text), prefix: "openafm-codex-")
            notice = "Opened OpenCode (CLI) in Terminal on the codex agent with this request."
        } else {
            notice = "OpenCode is not installed."
        }
    }

    // MARK: project folder

    func setProjectFolder(_ path: String) {
        if let problem = ProjectFolder.problem(path) { notice = problem; return }
        projectRoot = path
    }

    // MARK: openafm:// URLs (Shortcuts, Raycast, scripts) — they only fill the panel, never send

    /** openafm://ask?q=<text>[&folder=<path>] opens the panel with the question typed in. */
    func handle(url: URL) {
        guard url.scheme == "openafm", let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        let item = { (name: String) in c.queryItems?.first { $0.name == name }?.value }
        if let folder = item("folder") { setProjectFolder((folder as NSString).expandingTildeInPath) }
        if c.host == "ask", let q = item("q") { query = String(q.prefix(2000)) }
        showPanel()
    }

    // MARK: launch at login (SMAppService; the user flips it in Settings)

    var launchAtLogin: Bool { SMAppService.mainApp.status == .enabled }
    func setLaunchAtLogin(_ on: Bool) -> String? {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            objectWillChange.send()
            return SMAppService.mainApp.status == .requiresApproval ? "Approve OpenAFM in System Settings > General > Login Items." : nil
        } catch { return error.localizedDescription }
    }
}
