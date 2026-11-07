// Icon assets (run by `make icon`):
//   AppIcon-1024.png   app logo (OnBud_Icon3), specks removed, in its own colors on a light-blue rounded square
//                      (macOS icon grid), filling most of it
//   PanelIcon.png      the same logo without background, cropped to its content, for the panel's input row
//   MenuBar.png/@2x    black silhouette of the menu-bar logo (OnBud_Icon) with its dark outlines and prompt
//                      cut out, so the bud and the >_ still read at 18 pt; cropped to its content
//   MenuBarColor.png/@2x  the same logo in its own colors, same crop (shown while AFM works)
// usage: swift scripts/make-icons.swift <app-logo.png> <menubar-logo.png> <out-dir>
import AppKit
import CoreImage

let args = CommandLine.arguments
guard args.count == 4, let appSrc = CIImage(contentsOf: URL(fileURLWithPath: args[1])),
      let barSrc = CIImage(contentsOf: URL(fileURLWithPath: args[2])) else {
    FileHandle.standardError.write("usage: make-icons.swift <app-logo.png> <menubar-logo.png> <out-dir>\n".data(using: .utf8)!); exit(1)
}
let out = URL(fileURLWithPath: args[3])
let ctx = CIContext()
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

func render(_ image: CIImage, _ w: Int, _ h: Int) -> CGImage {
    let s = min(CGFloat(w) / image.extent.width, CGFloat(h) / image.extent.height)
    let scaled = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY)
        .concatenating(CGAffineTransform(scaleX: s, y: s)))
    let dx = (CGFloat(w) - scaled.extent.width) / 2, dy = (CGFloat(h) - scaled.extent.height) / 2
    let placed = scaled.transformed(by: CGAffineTransform(translationX: dx, y: dy))
    return ctx.createCGImage(placed, from: CGRect(x: 0, y: 0, width: w, height: h), format: .RGBA8, colorSpace: srgb)!
}

func write(_ image: CGImage, _ name: String) {
    try! NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(name))
}

/** Removes stray pixels: faint alpha (< ~0.5) becomes 0, then a 3 px morphological opening drops small blobs. */
func clean(_ src: CIImage) -> CIImage {
    let e = src.extent
    // Alpha → opaque grayscale mask, thresholded around 0.5.
    let mask = CIFilter(name: "CIColorMatrix", parameters: [
        kCIInputImageKey: src.unpremultiplyingAlpha(),
        "inputRVector": CIVector(x: 0, y: 0, z: 0, w: 4), "inputGVector": CIVector(x: 0, y: 0, z: 0, w: 4),
        "inputBVector": CIVector(x: 0, y: 0, z: 0, w: 4), "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
        "inputBiasVector": CIVector(x: -2, y: -2, z: -2, w: 1),
    ])!.outputImage!.applyingFilter("CIColorClamp").cropped(to: e)   // clamp: the blend below must not brighten
    let eroded = CIFilter(name: "CIMorphologyMinimum", parameters: [kCIInputImageKey: mask, kCIInputRadiusKey: 3])!.outputImage!
    let opened = CIFilter(name: "CIMorphologyMaximum", parameters: [kCIInputImageKey: eroded, kCIInputRadiusKey: 3])!.outputImage!.cropped(to: e)
    return CIFilter(name: "CIBlendWithMask", parameters: [
        kCIInputImageKey: src, kCIInputBackgroundImageKey: CIImage(color: .clear).cropped(to: e), kCIInputMaskImageKey: opened,
    ])!.outputImage!.cropped(to: e)
}

/** Bounding box of pixels with alpha > 0.5 (in Core Image coordinates). */
func contentBounds(_ image: CIImage) -> CGRect {
    let cg = ctx.createCGImage(image, from: image.extent, format: .RGBA8, colorSpace: srgb)!
    let w = cg.width, h = cg.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let c = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: srgb,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    var minX = w, minY = h, maxX = 0, maxY = 0
    for y in 0..<h { for x in 0..<w where px[(y * w + x) * 4 + 3] > 128 {
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    } }
    // Bitmap rows run top-down; Core Image's y axis runs bottom-up.
    return CGRect(x: image.extent.minX + CGFloat(minX), y: image.extent.minY + CGFloat(h - 1 - maxY),
                  width: CGFloat(maxX - minX + 1), height: CGFloat(maxY - minY + 1))
}

// App logo: cleaned, colors unchanged.
let logo = clean(appSrc)

let canvas = 1024
let icon = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: 0, space: srgb,
                     bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
icon.setShadow(offset: CGSize(width: 0, height: -6), blur: 18, color: CGColor(gray: 0, alpha: 0.22))
// Tile color: ICON_BG="#RRGGBB" (flat) or "#RRGGBB,#RRGGBB" (top to bottom gradient). Default: light blue, so the
// logo's dark outline stays crisp and the tile still stands apart from white windows.
func hex(_ h: String) -> CGColor {
    let v = Int(h.trimmingCharacters(in: CharacterSet(charactersIn: "# ")), radix: 16) ?? 0xFFFFFF
    return CGColor(srgbRed: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
}
let bg = (ProcessInfo.processInfo.environment["ICON_BG"] ?? "#EAF4FD,#D4E8F8").split(separator: ",").map { hex(String($0)) }
icon.addPath(CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil))
icon.setFillColor(bg[0])
icon.fillPath()
icon.setShadow(offset: .zero, blur: 0, color: nil)
if bg.count > 1, let g = CGGradient(colorsSpace: srgb, colors: [bg[0], bg[1]] as CFArray, locations: [0, 1]) {
    icon.saveGState()
    icon.addPath(CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)); icon.clip()
    icon.drawLinearGradient(g, start: CGPoint(x: 0, y: tile.maxY), end: CGPoint(x: 0, y: tile.minY), options: [])
    icon.restoreGState()
}
// The logo fills ~84% of the tile, cropped to its content so transparent margins don't shrink it.
let side = 690
icon.draw(render(logo.cropped(to: contentBounds(logo)), side, side), in: CGRect(x: (canvas - side) / 2, y: (canvas - side) / 2, width: side, height: side))
write(icon.makeImage()!, "AppIcon-1024.png")
write(render(logo.cropped(to: contentBounds(logo)), 128, 128), "PanelIcon.png")   // cropped: no transparent margin

// Menu bar: black silhouette of the second logo minus its dark strokes (luminance < ~0.3), cropped to its content.
let bar = clean(barSrc)
let lightMask = CIFilter(name: "CIColorMatrix", parameters: [
    kCIInputImageKey: bar.unpremultiplyingAlpha(),
    "inputRVector": CIVector(x: 1.5, y: 2.9, z: 0.6, w: 0), "inputGVector": CIVector(x: 1.5, y: 2.9, z: 0.6, w: 0),
    "inputBVector": CIVector(x: 1.5, y: 2.9, z: 0.6, w: 0), "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
    "inputBiasVector": CIVector(x: -1.5, y: -1.5, z: -1.5, w: 1),
])!.outputImage!.applyingFilter("CIColorClamp").cropped(to: bar.extent)
let cut = CIFilter(name: "CIBlendWithMask", parameters: [
    kCIInputImageKey: bar, kCIInputBackgroundImageKey: CIImage(color: .clear).cropped(to: bar.extent), kCIInputMaskImageKey: lightMask,
])!.outputImage!.cropped(to: bar.extent)
let black = CIFilter(name: "CIColorMatrix", parameters: [
    kCIInputImageKey: cut,
    "inputRVector": CIVector(x: 0, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: 0, z: 0, w: 0),
    "inputBVector": CIVector(x: 0, y: 0, z: 0, w: 0),
])!.outputImage!.cropped(to: contentBounds(bar))
write(render(black, 18, 18), "MenuBar.png")
write(render(black, 36, 36), "MenuBar@2x.png")
let color = bar.cropped(to: contentBounds(bar))
write(render(color, 18, 18), "MenuBarColor.png")
write(render(color, 36, 36), "MenuBarColor@2x.png")
print("icons written to \(out.path)")
