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
    let paths = OnBudPaths()
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
    @Published var showEarlier = false   // earlier answers of this chat unfolded (folded again on every send)
    @Published var olderInHistory = 0    // answers dropped from the panel (more than `maxEarlier`); the saved chat has them
    static let maxEarlier = 5

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
        showEarlier = false; olderInHistory = 0
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
        trimTurns()
        attachments = []
        awaiting = nil; running = true; collapsed = false; showEarlier = false
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

    /** The panel keeps the current answer and at most `maxEarlier` earlier ones (folded by default); the
     *  controller still gets the whole chat as history, and the saved chat (History) keeps every turn. */
    private func trimTurns() {
        let extra = turns.count - (Self.maxEarlier + 1)
        if extra > 0 { turns.removeFirst(extra); olderInHistory += extra }
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

    enum CopyPart { case answer, question, both }
    func copy(_ turn: Turn, _ part: CopyPart = .answer) {
        let text: String
        switch part {
        case .answer: text = turn.reply
        case .question: text = turn.prompt
        case .both: text = "Q: \(turn.prompt)\n\n\(turn.reply)"
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        notice = part == .answer ? "Answer copied." : part == .question ? "Question copied." : "Question and answer copied."
    }

    /** Puts an earlier question back into the field to edit and ask again. */
    func reuse(_ turn: Turn) {
        query = turn.prompt
        notice = "Question copied into the field: edit it and press ↩."
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
        awaiting = nil; running = false; attachments = []; collapsed = false; showEarlier = false; olderInHistory = 0
        trimTurns()
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
        content.title = "OnBud answered"
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
        runInTerminal(Plugins.installCommandFile(id, repo: paths.repo), prefix: "onbud-install-")
        notice = "Installing \(id.name) in Terminal. Press Check again when it is done."
    }

    /** Writes a one-off .command script (owner-only) and opens it in Terminal; earlier ones are removed. */
    /** Opens a Ghostty window in the home folder that runs `file`; nil on success, else the error text. */
    static func runInGhostty(_ file: URL) -> String? {
        func asString(_ v: String) -> String { "\"" + v.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\"" }
        let source = """
        tell application "Ghostty"
          set cfg to new surface configuration
          set initial working directory of cfg to \(asString(NSHomeDirectory()))
          set initial input of cfg to \(asString(shellQuote(file.path))) & linefeed
          new window with configuration cfg
          activate
        end tell
        """
        var error: NSDictionary?
        _ = NSAppleScript(source: source)?.executeAndReturnError(&error)
        return error.map { ($0[NSAppleScript.errorMessage] as? String) ?? "AppleScript error \($0[NSAppleScript.errorNumber] ?? "?")" }
    }

    func runInTerminal(_ script: String, prefix: String) {
        let tmp = FileManager.default.temporaryDirectory
        for old in (try? FileManager.default.contentsOfDirectory(at: tmp, includingPropertiesForKeys: nil)) ?? [] where old.lastPathComponent.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: old)
        }
        let file = tmp.appendingPathComponent("\(prefix)\(UUID().uuidString.prefix(8)).command")
        do {
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
            // The terminal chosen in Settings > Apps (apps.json, shared with the controller), else the macOS default.
            if let t = AppChoices.load().terminal, let app = AppChoices.appURL(t) {
                if t.lowercased() == "ghostty" {
                    // Ghostty does not run .command files (it opens an empty window): ask it through its AppleScript
                    // dictionary (Ghostty ≥ 1.3) for a window that types the script's path. macOS asks once for
                    // Automation access; if that is denied or fails, Terminal runs the script instead.
                    if let err = Self.runInGhostty(file) {
                        notice = "Ghostty did not take the script (\(err)); opened it in Terminal instead. Allow OnBud to control Ghostty in System Settings > Privacy & Security > Automation."
                        NSWorkspace.shared.open([file], withApplicationAt: URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app"), configuration: NSWorkspace.OpenConfiguration())
                    }
                } else {
                    NSWorkspace.shared.open([file], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
                }
            } else {
                NSWorkspace.shared.open(file)
            }
        } catch { notice = "Could not open Terminal: \(error.localizedDescription)" }
    }

    // MARK: setup (the app bundles the controller; scripts/setup.sh installs apfel, Node and the LaunchAgents)

    /** The controller copy inside the app (make app puts it in Resources/backend), if this build has one. */
    var bundledBackend: URL? {
        Bundle.main.resourceURL.map { $0.appendingPathComponent("backend") }
            .flatMap { FileManager.default.fileExists(atPath: $0.appendingPathComponent("scripts/setup.sh").path) ? $0 : nil }
    }

    /** Opens Terminal with the setup: copies the bundled controller to ~/OnBud/adaptive-coding-agent (never
     *  over a git checkout or a folder that is not an OnBud copy), then runs its scripts/setup.sh, which
     *  asks before installing anything. */
    func runSetup() {
        let dest = paths.repo.path
        var script = "#!/bin/zsh\nDEST=\(shellQuote(dest))\n"
        if let src = bundledBackend {
            script += """
            SRC=\(shellQuote(src.path))
            if [ -d "$DEST/.git" ]; then
              echo "Using your OnBud checkout in $DEST."
            elif [ ! -e "$DEST" ] || [ -f "$DEST/.onbud-bundled" ] || [ -f "$DEST/\(LegacyMigration.oldMarker)" ]; then
              echo "Copying the OnBud controller ($(cat "$SRC/.onbud-bundled")) to $DEST"
              mkdir -p "$DEST" && rsync -a --delete "$SRC/" "$DEST/" || exit 1
            else
              echo "$DEST exists but is not an OnBud copy; leaving it alone. Move it away and run setup again."; exit 1
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
        script += "[ -x \"$DEST/scripts/setup.sh\" ] || { echo \"No OnBud controller in $DEST.\"; exit 1; }\n/bin/bash \"$DEST/scripts/setup.sh\"\n"
        runInTerminal(script, prefix: "onbud-setup-")
        notice = "Setting up OnBud in Terminal. Press Check again when it is done."
    }

    /** The installed controller copy is older than the one in this app (a git checkout is never "older"). */
    var backendOutdated: Bool {
        guard let src = bundledBackend,
              let mine = try? String(contentsOf: src.appendingPathComponent(".onbud-bundled"), encoding: .utf8),
              let theirs = [".onbud-bundled", LegacyMigration.oldMarker].lazy
                .compactMap({ try? String(contentsOf: self.paths.repo.appendingPathComponent($0), encoding: .utf8) }).first else { return false }
        return mine.trimmingCharacters(in: .whitespacesAndNewlines) != theirs.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: optional services (Ollaya for the router model, SearXNG for web search): started on demand

    @Published var serviceBusy: Set<OptionalService> = []

    /** Starts the service now: through its LaunchAgent if "Start at login" is on, else its setup script (tmux). */
    func startService(_ s: OptionalService) { runService(s, s.startsAtLogin
        ? [["/bin/launchctl", "bootstrap", "gui/\(getuid())", s.launchAgent.path], ["/bin/launchctl", "kickstart", "gui/\(getuid())/\(s.label)"]]
        : [["/bin/bash", paths.repo.appendingPathComponent(s.setupScript).path, "start"]], done: "started") }

    /** Stops it until the next start (a login LaunchAgent stays installed and starts it again at the next login). */
    func stopService(_ s: OptionalService) { runService(s, (s.startsAtLogin ? [["/bin/launchctl", "bootout", "gui/\(getuid())/\(s.label)"]] : [])
        + [["/bin/bash", paths.repo.appendingPathComponent(s.setupScript).path, "stop"]], done: "stopped") }

    /** "Start at login": installs or removes its LaunchAgent (scripts/afm-launchagent.sh). Off by default. */
    func setLoginStart(_ s: OptionalService, _ on: Bool) {
        runService(s, [["/bin/bash", paths.repo.appendingPathComponent("scripts/afm-launchagent.sh").path, on ? "install" : "uninstall", s.rawValue]],
                   done: on ? "set to start at login" : "no longer starts at login")
    }

    private func runService(_ s: OptionalService, _ commands: [[String]], done: String) {
        guard !serviceBusy.contains(s) else { return }
        serviceBusy.insert(s)
        notice = nil
        Task {
            // Apps opened from Finder lack Homebrew on PATH; the scripts need tmux and curl from there.
            let env = ["PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "HOME": NSHomeDirectory(), "ONBUD_HOME": paths.home.path]
            let ok = await Task.detached { () -> Bool in
                var ok = true
                for c in commands {
                    let p = Process()
                    p.executableURL = URL(fileURLWithPath: c[0]); p.arguments = Array(c.dropFirst()); p.environment = env
                    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
                    do { try p.run(); p.waitUntilExit(); if p.terminationStatus != 0 && !c[0].hasSuffix("launchctl") { ok = false } } catch { ok = false }
                }
                return ok
            }.value
            await probe()
            serviceBusy.remove(s)
            notice = ok ? "\(s.name) \(done)." : "\(s.name): the command failed (see ~/OnBud/runtime/logs)."
            objectWillChange.send()
        }
    }

    // MARK: bundled pdftext (PDF text + Vision OCR helper the controller runs from ~/OnBud/runtime/bin)

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
                    _ = try await service.startSession(dir: dir, agent: "codex", title: "OnBud · \(prompt.prefix(40))", text: text)
                    let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = true
                    _ = try? await ws.openApplication(at: app, configuration: cfg)
                    notice = "Sent to Codex in OpenCode — the new session “OnBud · …” is at the top of the session list."
                } catch {
                    notice = "Could not hand off: \((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)"
                }
            }
        } else if let cli = OpenCodeInstall.cli {
            // OpenCode 2's TUI cannot pick an agent: start the session on codex through the CLI's background
            // service, then open the TUI on it. Without the service, a one-shot `opencode run --agent codex`.
            notice = "Starting a Codex session in OpenCode…"
            Task {
                var service = OpenCodeService.load()
                if service == nil {
                    let path = cli.path
                    _ = await Task.detached { RoutingModel.run(path, ["service", "start"], capture: false) }.value
                    for _ in 0..<20 where service == nil { try? await Task.sleep(for: .milliseconds(500)); service = OpenCodeService.load() }
                }
                if let service, let id = try? await service.startSession(dir: dir, agent: "codex", title: "OnBud · \(prompt.prefix(40))", text: text) {
                    runInTerminal(OpenCodeHandoff.sessionScript(cli: cli.path, dir: dir, session: id), prefix: "onbud-codex-")
                    notice = "Sent to Codex: OpenCode opens in Terminal on the new session."
                } else {
                    runInTerminal(OpenCodeHandoff.runScript(cli: cli.path, dir: dir, prompt: text), prefix: "onbud-codex-")
                    notice = "OpenCode's service was not reachable: Terminal runs the request once on the codex agent (`opencode run`)."
                }
            }
        } else {
            notice = "OpenCode is not installed."
        }
    }

    // MARK: project folder

    func setProjectFolder(_ path: String) {
        if let problem = ProjectFolder.problem(path) { notice = problem; return }
        projectRoot = path
    }

    // MARK: onbud:// URLs (Shortcuts, Raycast, scripts) — they only fill the panel, never send

    /** onbud://ask?q=<text>[&folder=<path>] opens the panel with the question typed in. */
    func handle(url: URL) {
        guard url.scheme == "onbud", let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
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
            return SMAppService.mainApp.status == .requiresApproval ? "Approve OnBud in System Settings > General > Login Items." : nil
        } catch { return error.localizedDescription }
    }
}
