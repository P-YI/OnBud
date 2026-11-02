// Menu-bar logo while the on-device AFM works: the apple fills with its own colors from left to right, then
// the color leaves from left to right, over and over; idle, it is the plain template silhouette again.
// "Works" = the panel's own request, or the controller reporting busy on /health (OpenCode and other
// clients), polled every 2 s on 127.0.0.1 only.
import AppKit
import SpotlightCore

@MainActor
final class MenuBarActivity {
    private weak var button: NSStatusBarButton?
    private let template: NSImage?
    private let color: NSImage?
    private var timer: Timer?
    private var poll: Timer?
    private var start = Date()
    private(set) var busy = false
    var localBusy: () -> Bool = { false }

    static let period: TimeInterval = 1.8
    static let size = NSSize(width: 18, height: 18)

    init(button: NSStatusBarButton?, template: NSImage?) {
        self.button = button
        self.template = template
        color = Bundle.main.image(forResource: "MenuBarColor")
        color?.size = Self.size
    }

    func startPolling() {
        poll = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    /** Re-checks right away (the panel calls this when it starts or finishes a request). */
    func refresh() async {
        let remote = await Self.controllerBusy()
        setBusy(localBusy() || remote)
    }

    func setBusy(_ on: Bool) {
        guard on != busy, color != nil else { return }
        busy = on
        if on {
            start = Date()
            // The timer fires on the main run loop: draw there directly. (A Task per frame could run after
            // setBusy(false) and leave a colored frame behind.)
            timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.draw() }
            }
            draw()
        } else {
            timer?.invalidate(); timer = nil
            button?.image = template
        }
    }

    private func draw() {
        guard busy, let color, let button else { return }
        let phase = Date().timeIntervalSince(start).truncatingRemainder(dividingBy: Self.period) / Self.period
        // 0…0.5: color enters from the left; 0.5…1: it leaves to the right.
        let lead = phase < 0.5 ? phase * 2 : 1.0, trail = phase < 0.5 ? 0.0 : (phase - 0.5) * 2
        let dark = button.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        button.image = Self.frame(color: color, template: template, from: trail, to: lead, dark: dark)
    }

    /** One frame: the silhouette (black, or white on a dark menu bar) with color between `from` and `to` (0…1 of the width). */
    static func frame(color: NSImage, template: NSImage?, from: Double, to: Double, dark: Bool) -> NSImage {
        let img = NSImage(size: size, flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            if let template {
                ctx.saveGState()
                template.draw(in: rect)
                ctx.setBlendMode(.sourceIn)
                ctx.setFillColor((dark ? NSColor.white : NSColor.black).cgColor)
                ctx.fill(rect)
                ctx.restoreGState()
            }
            // Color only between `from` and `to`, with soft edges: a per-column alpha mask.
            let soft = 0.18, cols = 64
            var alpha = [UInt8](repeating: 0, count: cols)
            for i in 0..<cols {
                let u = (Double(i) + 0.5) / Double(cols)
                let enter = to >= 1 ? 1 : min(1, max(0, (to - u) / soft + 1))      // fades out just past the leading edge
                let leave = from <= 0 ? 1 : min(1, max(0, (u - from) / soft))      // fades in just past the trailing edge
                alpha[i] = UInt8(255 * enter * leave)
            }
            guard alpha.contains(where: { $0 > 0 }),
                  let provider = CGDataProvider(data: Data(alpha) as CFData),
                  let mask = CGImage(width: cols, height: 1, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: cols,
                                     space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0),
                                     provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { return true }
            ctx.saveGState()
            ctx.clip(to: rect, mask: mask)
            color.draw(in: rect)
            ctx.restoreGState()
            return true
        }
        img.isTemplate = false
        return img
    }

    static func controllerBusy() async -> Bool {
        var req = URLRequest(url: Backend.url(Port.controller, "/health"), timeoutInterval: 1)
        req.httpMethod = "GET"
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return o["busy"] as? Bool ?? false
    }
}
