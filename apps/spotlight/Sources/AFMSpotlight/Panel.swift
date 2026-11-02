// The Spotlight-style window: a floating, non-activating panel that takes keystrokes without bringing
// the app forward, and closes on Esc or when it loses key status.
import AppKit
import SwiftUI

final class SpotlightPanel: NSPanel {
    /** Set while a sheet or the folder picker is up, so losing key status does not close the panel. */
    var keepOpen = false

    init<V: View>(content: V) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 720, height: 104),
                   styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView],   // fixed size: no .resizable
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true
        isMovableByWindowBackground = true
        hidesOnDeactivate = false
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        animationBehavior = .utilityWindow

        // Background (light gray) and rounded corners are drawn by the SwiftUI content.
        // As the window's content view controller, the hosting controller's preferred size (the SwiftUI
        // content's height: input row, quick actions, results) resizes the window; a bare hosting view
        // only reports it and the window kept its first height, clipping the content.
        let host = NSHostingController(rootView: content)
        host.safeAreaRegions = []   // the hidden title bar would otherwise push the content down (empty top band)
        host.sizingOptions = [.preferredContentSize]
        contentViewController = host
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) { close() }   // Esc

    override func resignKey() {
        super.resignKey()
        if !keepOpen && attachedSheet == nil { close() }
    }

    /** Shows centered in the upper third of the screen with the mouse, like Spotlight. */
    func present() {
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
        if let f = screen?.visibleFrame {
            let size = frame.size
            setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: f.minY + f.height * 0.72 - size.height))
        }
        makeKeyAndOrderFront(nil)
    }

    /** Keep the top edge fixed while the content grows or shrinks. The hosting controller resizes the window
     *  through setFrame (not only setContentSize) and keeps the bottom edge, so without this the input row
     *  first moved with the bottom (folding: it dropped, then jumped back up). Moves without a size change
     *  (dragging, present()) pass through. */
    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        super.setFrame(topAnchored(frameRect), display: flag)
    }
    override func setFrame(_ frameRect: NSRect, display displayFlag: Bool, animate animateFlag: Bool) {
        super.setFrame(topAnchored(frameRect), display: displayFlag, animate: false)
    }
    private func topAnchored(_ r: NSRect) -> NSRect {
        guard r.size.height != frame.size.height, frame.height > 0 else { return r }
        var r = r
        r.origin.y = frame.maxY - r.height
        return r
    }
}
