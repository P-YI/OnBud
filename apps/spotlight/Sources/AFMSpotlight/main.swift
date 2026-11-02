// OpenAFM launcher: menu-bar agent (LSUIElement) with a global hotkey that opens the launcher panel,
// an "Ask OpenAFM" service for text and files from any app, and openafm:// URLs that fill the panel.
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
        // `open OpenAFM.app --args --show` (make run) opens the panel right away.
        if CommandLine.arguments.contains("--show") { show() }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { state.handle(url: url) }
    }

    func registerHotKey(_ choice: HotKeyChoice) {
        let err = hotKey.register(choice)
        state.hotKeyWarning = err == noErr ? (choice == .commandSpace ? "If Spotlight still opens, turn off its shortcut in System Settings > Keyboard > Keyboard Shortcuts > Spotlight." : nil)
            : "\(choice.label) is taken by another app (error \(err)). Pick another shortcut."
        statusItem?.menu?.item(withTag: 1)?.title = "Open OpenAFM  (\(choice.label.components(separatedBy: " (").first!))"
    }

    func toggle() { panel.isVisible ? panel.close() : show() }

    func show() {
        Task { await state.probe() }
        panel.present()
        NotificationCenter.default.post(name: .spotlightShown, object: nil)
    }

    // MARK: Services menu: "Ask OpenAFM" (NSServices in Info.plist) — attaches the selection, opens the panel

    @objc func askOpenAFM(_ pboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
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
            statusItem.button?.image = NSImage(systemSymbolName: "sparkle.magnifyingglass", accessibilityDescription: "OpenAFM")
        }
        let menu = NSMenu()
        let open = NSMenuItem(title: "Open OpenAFM", action: #selector(menuOpen), keyEquivalent: "")
        open.tag = 1
        menu.addItem(open)
        menu.addItem(NSMenuItem(title: "Activity…", action: #selector(menuActivity), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Settings…", action: #selector(menuSettings), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "Backend…", action: #selector(menuBackend), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit OpenAFM", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        for item in menu.items where item.action != #selector(NSApplication.terminate(_:)) { item.target = self }
        statusItem.menu = menu
    }

    @objc func menuOpen() { show() }
    @objc func menuSettings() { openSettings() }
    @objc func menuBackend() { openBackend() }
    @objc func menuActivity() { openActivity() }

    // MARK: windows

    func window<V: View>(_ key: String, _ title: String, _ view: @autoclosure () -> V) {
        panel.close()
        if windows[key] == nil {
            let w = NSWindow(contentViewController: NSHostingController(rootView: view()))
            w.title = title
            w.styleMask = [.titled, .closable]
            w.isReleasedWhenClosed = false
            w.center()
            windows[key] = w
        }
        NSApp.activate()
        windows[key]?.makeKeyAndOrderFront(nil)
    }

    func openBackend() { window("backend", "OpenAFM Backend", BackendView(state: state)) }
    func openSettings() { window("settings", "OpenAFM Settings", SettingsView(state: state, m: SettingsModel(), openBackend: { [weak self] in self?.openBackend() })) }
    func openActivity() {
        window("activity", "OpenAFM Activity", ActivityView(state: state, run: { [weak self] prompt, root in
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
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
