// OnBud launcher: menu-bar agent (LSUIElement) with a global hotkey that opens the launcher panel,
// an "Ask OnBud" service for text and files from any app, and onbud:// URLs that fill the panel.
import AppKit
import Carbon.HIToolbox
import Combine
import SpotlightCore
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let state = AppState.shared
    var panel: SpotlightPanel!
    var statusItem: NSStatusItem!
    var windows: [String: NSWindow] = [:]
    private var resizeObservers: [NSObjectProtocol] = []
    var activity: MenuBarActivity!
    var watchRunning: AnyCancellable?
    lazy var hotKey = HotKey { [weak self] in self?.toggle() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        panel = SpotlightPanel(content: SpotlightView(state: state,
                                                      pickFolder: { [weak self] in self?.pickFolder() },
                                                      pickFiles: { [weak self] in self?.pickFiles() },
                                                      openSettings: { [weak self] in self?.openSettings() },
                                                      openActivity: { [weak self] in self?.openActivity() }))
        setUpMenuBar()
        setUpMainMenu()
        // Menu-bar logo in color while AFM works (this panel's requests or any other client's).
        activity = MenuBarActivity(button: statusItem.button, template: statusItem.button?.image)
        activity.localBusy = { [weak self] in self?.state.running ?? false }
        activity.startPolling()
        watchRunning = state.$running.sink { [weak self] on in
            if on { self?.activity.setBusy(true) } else { Task { await self?.activity.refresh() } }
        }
        state.onHotKeyChange = { [weak self] in self?.registerHotKey($0) }
        state.isPanelVisible = { [weak self] in self?.panel.isVisible ?? false }
        state.showPanel = { [weak self] in self?.show() }
        state.holdPanel = { [weak self] hold in self?.panel.keepOpen = hold }
        registerHotKey(state.hotKey)
        NSApp.servicesProvider = self
        NSUpdateDynamicServices()
        if state.notifyWhenDone { state.requestNotificationPermission() }
        Task { await state.probe() }
        offerToRemoveOldApp()
        // `open OnBud.app --args --show` (make run) opens the panel right away.
        if CommandLine.arguments.contains("--show") { show() }
        // Development: `--skills`, or `--open skills|backend|settings|activity`, opens that window at launch;
        // `--snapshot <png>` then writes it to a PNG (no screen-recording permission) and logs its frame.
        let args = CommandLine.arguments
        var opened = args.contains("--skills") ? "skills" : nil
        if let i = args.firstIndex(of: "--open"), i + 1 < args.count { opened = args[i + 1] }
        switch opened {
        case "skills": openSkills()
        case "backend": openBackend()
        case "settings": openSettings()
        case "activity": openActivity()
        default: break
        }
        if let key = opened, let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
            let out = URL(fileURLWithPath: args[i + 1])
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                guard let w = self?.windows[key] else { return }
                try? "window \(NSStringFromRect(w.frame)) visible \(NSStringFromRect(w.screen?.visibleFrame ?? .zero))\n"
                    .write(to: out.appendingPathExtension("txt"), atomically: true, encoding: .utf8)
                guard let v = w.contentView?.superview, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
                v.cacheDisplay(in: v.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: out)
            }
        }
    }

    /** v0.1.0 was installed as OpenAFM.app: both would claim the hot key and the URL scheme. Asks once. */
    func offerToRemoveOldApp() {
        guard let old = LegacyMigration.oldApp(), !UserDefaults.standard.bool(forKey: "oldAppOfferShown") else { return }
        UserDefaults.standard.set(true, forKey: "oldAppOfferShown")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            let a = NSAlert()
            a.messageText = "Move the old app to the Trash?"
            a.informativeText = "OnBud was called \(LegacyMigration.oldName) in v0.1.0, and \(old.lastPathComponent) is still in Applications. Both would answer the same hot key. Your settings and history were carried over."
            a.addButton(withTitle: "Move to Trash"); a.addButton(withTitle: "Keep")
            NSApp.activate()
            guard a.runModal() == .alertFirstButtonReturn else { return }
            for r in NSRunningApplication.runningApplications(withBundleIdentifier: LegacyMigration.oldBundleID) { r.terminate() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { NSWorkspace.shared.recycle([old]) { _, _ in } }
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { state.handle(url: url) }
    }

    func registerHotKey(_ choice: HotKeyChoice) {
        let err = hotKey.register(choice)
        state.hotKeyWarning = err == noErr ? (choice == .commandSpace ? "If Spotlight still opens, turn off its shortcut in System Settings > Keyboard > Keyboard Shortcuts > Spotlight." : nil)
            : "\(choice.label) is taken by another app (error \(err)). Pick another shortcut."
        statusItem?.menu?.item(withTag: 1)?.title = "Open OnBud  (\(choice.label.components(separatedBy: " (").first!))"
    }

    func toggle() { panel.isVisible ? panel.close() : show() }

    func show() {
        Task { await state.probe() }
        panel.present()
        NotificationCenter.default.post(name: .spotlightShown, object: nil)
    }

    // MARK: Services menu: "Ask OnBud" (NSServices in Info.plist) — attaches the selection, opens the panel

    @objc func askOnBud(_ pboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
        if let urls = pboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            state.attach(urls.map { .file($0) })
        } else if let text = pboard.string(forType: .string), !text.isEmpty {
            state.attach([.text(text, source: "selection")])
        }
        show()
    }

    // MARK: menu bar

    func setUpMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let img = Bundle.main.image(forResource: "MenuBar") {
            img.size = NSSize(width: 18, height: 18)
            img.isTemplate = true   // black on a light menu bar; macOS turns it white on a dark one
            statusItem.button?.image = img
        } else {
            statusItem.button?.image = NSImage(systemSymbolName: "sparkle.magnifyingglass", accessibilityDescription: "OnBud")
        }
        let menu = NSMenu()
        let open = NSMenuItem(title: "Open OnBud", action: #selector(menuOpen), keyEquivalent: "")
        open.tag = 1
        menu.addItem(open)
        menu.addItem(NSMenuItem(title: "Activity…", action: #selector(menuActivity), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Settings…", action: #selector(menuSettings), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "Skills…", action: #selector(menuSkills), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Backend…", action: #selector(menuBackend), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit OnBud", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        for item in menu.items where item.action != #selector(NSApplication.terminate(_:)) { item.target = self }
        statusItem.menu = menu
    }

    /** The (hidden) main menu: an accessory app shows no menu bar, but its Edit items carry ⌘X/C/V/A/Z for the
     *  Settings, Backend and Activity windows' text fields. */
    func setUpMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Quit OnBud", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        edit.addItem(.separator())
        edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = edit
        NSApp.mainMenu = main
    }

    @objc func menuOpen() { show() }
    @objc func menuSettings() { openSettings() }
    @objc func menuBackend() { openBackend() }
    @objc func menuSkills() { openSkills() }
    @objc func menuActivity() { openActivity() }

    // MARK: windows

    func window<V: View>(_ key: String, _ title: String, _ view: @autoclosure () -> V) {
        panel.close()
        if windows[key] == nil {
            let host = NSHostingController(rootView: view())
            let w = NSWindow(contentViewController: host)
            w.title = title
            w.styleMask = [.titled, .closable]
            w.isReleasedWhenClosed = false
            // The hosting controller would size the window to the content's ideal size, which for a grouped Form is
            // its full height and grows after the first probes: the window then ran past the screen. Size it once,
            // capped to the visible screen (the Form scrolls), and let the user resize it.
            host.view.layoutSubtreeIfNeeded()
            let fit = host.view.fittingSize
            host.sizingOptions = []
            w.styleMask.insert(.resizable)
            let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            w.setContentSize(NSSize(width: min(max(fit.width, 480), vis.width - 40), height: min(max(fit.height, 360), vis.height - 60)))
            w.center()
            AppDelegate.keepOnScreen(w)
            resizeObservers.append(NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: w, queue: .main) { n in
                guard let w = n.object as? NSWindow else { return }
                MainActor.assumeIsolated { AppDelegate.keepOnScreen(w) }
            })
            windows[key] = w
        }
        NSApp.activate()
        windows[key]?.makeKeyAndOrderFront(nil)
    }

    /** Moves (and if needed shrinks) a window so it lies inside its screen's visible area. */
    static func keepOnScreen(_ w: NSWindow) {
        guard let vis = (w.screen ?? NSScreen.main)?.visibleFrame else { return }
        var f = w.frame
        f.size.width = min(f.width, vis.width); f.size.height = min(f.height, vis.height)
        f.origin.x = min(max(f.minX, vis.minX), vis.maxX - f.width)
        f.origin.y = min(max(f.minY, vis.minY), vis.maxY - f.height)
        if f != w.frame { w.setFrame(f, display: true) }
    }

    func openBackend() { window("backend", "OnBud Backend", BackendView(state: state)) }
    func openSettings() {
        window("settings", "OnBud Settings", SettingsView(state: state, m: SettingsModel(), openBackend: { [weak self] in self?.openBackend() },
                                                            openSkills: { [weak self] in self?.openSkills() }))
    }
    func openSkills() {
        window("skills", "OnBud Skills", SkillsView(state: state, m: SkillsModel(), openSettings: { [weak self] in self?.openSettings() },
                                                      openBackend: { [weak self] in self?.openBackend() }))
    }
    func openActivity() {
        window("activity", "OnBud Activity", ActivityView(state: state, run: { [weak self] prompt, root in
            guard let self else { return }
            self.windows["activity"]?.close()
            // Job commands work in the job's project folder.
            if root != self.state.projectRoot { self.state.setProjectFolder(root) } else { self.state.resetConversation() }
            self.show()
            self.state.send(prompt)
        }))
    }

    // MARK: pickers (the panel stays open while they are up)

    func pickFolder() {
        if let url = runOpenPanel(folders: true, message: "AFM may read files in this folder (inside your home folder, not the home folder itself).").first {
            state.setProjectFolder(url.path)
        }
    }

    func pickFiles() {
        let urls = runOpenPanel(folders: false, message: "Attach files to ask about (PDF, Word, slides, images, code…).")
        if !urls.isEmpty { state.attach(urls.map { .file($0) }) }
    }

    private func runOpenPanel(folders: Bool, message: String) -> [URL] {
        panel.keepOpen = true
        let op = NSOpenPanel()
        op.canChooseDirectories = folders
        op.canChooseFiles = !folders
        op.allowsMultipleSelection = !folders
        op.prompt = folders ? "Use Folder" : "Attach"
        op.message = message
        if let r = state.projectRoot { op.directoryURL = URL(fileURLWithPath: r) }
        op.level = .modalPanel
        NSApp.activate()
        let result = op.runModal()
        panel.keepOpen = false
        panel.present()
        return result == .OK ? op.urls : []
    }
}

MainActor.assumeIsolated {
    // Before AppState reads paths and settings: carry over a v0.1.0 (OpenAFM) installation.
    for line in LegacyMigration.run() { NSLog("OnBud upgrade: %@", line) }
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
