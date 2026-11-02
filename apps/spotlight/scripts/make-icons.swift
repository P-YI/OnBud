// Icon assets (run by `make icon`):
//   AppIcon-1024.png   app logo (OpenAFM_Icon2.2), 20% less saturated and 7% darker, specks removed,
//                      on a white rounded square (macOS icon grid), filling most of it
//   PanelIcon.png      the same logo without background, for the panel's input row
//   MenuBar.png/@2x    black silhouette of the menu-bar logo (OpenAFM_Icon3), cropped to its content
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

// App logo: cleaned, 20% less saturated, 7% darker.
let logo = CIFilter(name: "CIColorControls", parameters: [
    kCIInputImageKey: clean(appSrc), kCIInputSaturationKey: 0.8, kCIInputBrightnessKey: -0.07, kCIInputContrastKey: 1.0,
])!.outputImage!.cropped(to: appSrc.extent)

let canvas = 1024
let icon = CGContext(data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: 0, space: srgb,
                     bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
icon.setShadow(offset: CGSize(width: 0, height: -6), blur: 18, color: CGColor(gray: 0, alpha: 0.22))
icon.addPath(CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil))
icon.setFillColor(CGColor(gray: 1, alpha: 1))
icon.fillPath()
icon.setShadow(offset: .zero, blur: 0, color: nil)
// The logo fills ~89% of the tile (was 80%), cropped to its content so transparent margins don't shrink it.
let side = 730
icon.draw(render(logo.cropped(to: contentBounds(logo)), side, side), in: CGRect(x: (canvas - side) / 2, y: (canvas - side) / 2, width: side, height: side))
write(icon.makeImage()!, "AppIcon-1024.png")
write(render(logo, 128, 128), "PanelIcon.png")

// Menu bar: black silhouette of the second logo, cropped to its content.
let bar = clean(barSrc)
let black = CIFilter(name: "CIColorMatrix", parameters: [
    kCIInputImageKey: bar,
    "inputRVector": CIVector(x: 0, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: 0, z: 0, w: 0),
    "inputBVector": CIVector(x: 0, y: 0, z: 0, w: 0),
])!.outputImage!.cropped(to: contentBounds(bar))
write(render(black, 18, 18), "MenuBar.png")
write(render(black, 36, 36), "MenuBar@2x.png")
let color = bar.cropped(to: contentBounds(bar))
write(render(color, 18, 18), "MenuBarColor.png")
write(render(color, 36, 36), "MenuBarColor@2x.png")
print("icons written to \(out.path)")
