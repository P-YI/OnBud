// pdftext: on-device text extraction for the controller (no network; PDFKit + Vision only).
//   pdftext <file.pdf> [maxPages=3] [maxChars=6000] [pageList]   text of the first pages, or of pageList ("4,9,12", 1-based)
//   pdftext --find <file.pdf> <term|term|...>                      pages ranked by how often the terms occur
//   pdftext --image <file>                                         OCR of one image (png/jpg/heic/tiff…)
// Output is one JSON object. Pages without a text layer (scans) fall back to Vision OCR (ko/en).
import Foundation
import PDFKit
import Vision
import AppKit

func recognize(_ cg: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["ko-KR", "en-US"]
    request.usesLanguageCorrection = true
    try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

func ocr(_ page: PDFPage) -> String {
    let bounds = page.bounds(for: .mediaBox)
    let size = NSSize(width: bounds.width * 2, height: bounds.height * 2)
    let image = page.thumbnail(of: size, for: .mediaBox)
    guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return "" }
    return recognize(cg)
}

func emit(_ obj: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
    FileHandle.standardOutput.write(data)
    print("")
    exit(0)
}

func open(_ path: String) -> PDFDocument {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { emit(["error": "cannot_open"]) }
    if doc.isLocked { emit(["error": "encrypted", "pages": doc.pageCount]) }
    return doc
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: pdftext <file.pdf> [maxPages] [maxChars] [pageList] | --find <file.pdf> <terms> | --image <file>\n".data(using: .utf8)!)
    exit(2)
}

if args[1] == "--image", args.count >= 3 {
    guard let img = NSImage(contentsOf: URL(fileURLWithPath: args[2])),
          var cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { emit(["error": "cannot_open"]) }
    // Small images (screenshots, thumbnails) OCR noticeably better at 2x.
    if max(cg.width, cg.height) < 1600,
       let ctx = CGContext(data: nil, width: cg.width * 2, height: cg.height * 2, bitsPerComponent: 8, bytesPerRow: 0,
                           space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) {
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: cg.width * 2, height: cg.height * 2))
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width * 2, height: cg.height * 2))
        if let up = ctx.makeImage() { cg = up }
    }
    emit(["text": recognize(cg), "ocr_pages": 1, "width": cg.width, "height": cg.height])
}

if args[1] == "--find", args.count >= 4 {
    // Text-layer search only (no OCR here, it would be too slow across a whole document).
    let doc = open(args[2])
    let terms = args[3].lowercased().split(separator: "|").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { $0.count >= 2 }
    var hits: [[String: Any]] = []
    for i in 0..<doc.pageCount {
        guard let s = doc.page(at: i)?.string?.lowercased() else { continue }
        var n = 0
        var matched = 0
        for t in terms {
            let c = s.components(separatedBy: t).count - 1
            n += c
            if c > 0 { matched += 1 }
        }
        if n > 0 { hits.append(["page": i + 1, "count": n, "terms": matched]) }
    }
    hits.sort { (($0["terms"] as! Int), ($0["count"] as! Int)) > (($1["terms"] as! Int), ($1["count"] as! Int)) }
    emit(["pages": doc.pageCount, "hits": Array(hits.prefix(10))])
}

let maxPages = args.count > 2 ? Int(args[2]) ?? 3 : 3
let maxChars = args.count > 3 ? Int(args[3]) ?? 6000 : 6000
let doc = open(args[1])
var pageIdx: [Int] = Array(0..<min(doc.pageCount, maxPages))
if args.count > 4, !args[4].isEmpty {
    pageIdx = args[4].split(separator: ",").compactMap { Int($0) }.map { $0 - 1 }.filter { $0 >= 0 && $0 < doc.pageCount }
}
var text = ""
var truncated = false
var ocrPages = 0
for i in pageIdx {
    guard let page = doc.page(at: i) else { continue }
    var s = page.string ?? ""
    if s.trimmingCharacters(in: .whitespacesAndNewlines).count < 20 { s = ocr(page); ocrPages += 1 }
    if args.count > 4 { text += "[page \(i + 1)]\n" }
    text += s + "\n"
    if text.count >= maxChars { truncated = true; break }
}
if args.count <= 4 && doc.pageCount > maxPages { truncated = true }
if text.count > maxChars { text = String(text.prefix(maxChars)) }
let attrs = doc.documentAttributes ?? [:]
emit([
    "pages": doc.pageCount,
    "title": (attrs[PDFDocumentAttribute.titleAttribute] as? String) ?? "",
    "author": (attrs[PDFDocumentAttribute.authorAttribute] as? String) ?? "",
    "text": text,
    "truncated": truncated,
    "ocr_pages": ocrPages,
])
