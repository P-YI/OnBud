// PDF helper for the convert skill (PDFKit, on-device). Never overwrites: the caller passes a new output path.
//   pdftool pages <in.pdf>                              → page count
//   pdftool merge <out.pdf> <in.pdf>...                 → one PDF, pages in the given order
//   pdftool images <out.pdf> <image>...                 → one page per image
//   pdftool assemble <out.pdf> <pages> <in> [<pages> <in>]...
//                                                       → the listed pages, in the listed order; <pages> is "all" or
//                                                         1-based numbers "1,2,5"; an image input is one page
//   pdftool sig <in.pdf>                                → one line per page: a hash of its text, size and rotation
//                                                         (the convert skill checks the new PDF against its sources)
import Foundation
import PDFKit
import AppKit

@main struct PDFTool {
  static func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }
  static func open(_ p: String) -> PDFDocument {
    guard let d = PDFDocument(url: URL(fileURLWithPath: p)) else { fail("not a PDF: \(p)") }
    if d.isLocked { fail("locked with a password: \(p)") }
    return d
  }
  static func isPDF(_ p: String) -> Bool { (p as NSString).pathExtension.lowercased() == "pdf" }
  static func imagePage(_ p: String) -> PDFPage {
    guard let img = NSImage(contentsOf: URL(fileURLWithPath: p)), let pg = PDFPage(image: img) else { fail("not an image: \(p)") }
    return pg
  }
  static func sig(_ pg: PDFPage) -> String {
    let b = pg.bounds(for: .mediaBox)
    let s = "\(pg.string ?? "")|\(Int(b.width.rounded()))x\(Int(b.height.rounded()))|\(pg.rotation)"
    var h: UInt64 = 0xcbf29ce484222325
    for c in s.utf8 { h ^= UInt64(c); h = h &* 0x100000001b3 }
    return String(format: "%016llx", h)
  }
  static func write(_ doc: PDFDocument, _ out: URL) {
    guard doc.write(to: out) else { fail("could not write \(out.path)") }
    print(doc.pageCount)
  }
  static func main() {
    let a = CommandLine.arguments
    guard a.count >= 3 else { fail("usage: pdftool pages|merge|images|assemble|sig …") }
    switch a[1] {
    case "pages":
      print(open(a[2]).pageCount)
    case "sig":
      let d = open(a[2])
      for i in 0..<d.pageCount { if let pg = d.page(at: i) { print(sig(pg)) } }
    case "merge", "images", "assemble":
      guard a.count >= 4 else { fail("need an output and at least one input") }
      let out = URL(fileURLWithPath: a[2])
      if FileManager.default.fileExists(atPath: out.path) { fail("output exists: \(out.path)") }
      let doc = PDFDocument()
      if a[1] == "assemble" {
        guard (a.count - 3) % 2 == 0 else { fail("assemble takes <pages> <input> pairs") }
        var cache: [String: PDFDocument] = [:]
        var i = 3
        while i < a.count {
          let spec = a[i], p = a[i + 1]; i += 2
          if !isPDF(p) { doc.insert(imagePage(p), at: doc.pageCount); continue }
          let d = cache[p] ?? open(p); cache[p] = d
          let nums = spec == "all" ? Array(stride(from: 1, through: d.pageCount, by: 1)) : spec.split(separator: ",").map { Int($0) ?? 0 }
          for n in nums {
            guard n >= 1, n <= d.pageCount, let pg = d.page(at: n - 1)?.copy() as? PDFPage else { fail("page \(n) is not in \(p) (\(d.pageCount) pages)") }
            doc.insert(pg, at: doc.pageCount)
          }
        }
        if doc.pageCount == 0 { fail("no pages selected") }
        write(doc, out)
        return
      }
      for p in a[3...] {
        if a[1] == "merge" {
          let d = open(p)
          for i in 0..<d.pageCount { if let pg = d.page(at: i)?.copy() as? PDFPage { doc.insert(pg, at: doc.pageCount) } }
        } else {
          doc.insert(imagePage(p), at: doc.pageCount)
        }
      }
      write(doc, out)
    default: fail("unknown command \(a[1])")
    }
  }
}
