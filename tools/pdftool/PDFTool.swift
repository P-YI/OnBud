// PDF helper for the convert skill (PDFKit, on-device). Never overwrites: the caller passes a new output path.
//   pdftool pages <in.pdf>                     → page count
//   pdftool merge <out.pdf> <in.pdf>...        → one PDF, pages in the given order
//   pdftool images <out.pdf> <image>...        → one page per image
import Foundation
import PDFKit
import AppKit

@main struct PDFTool {
  static func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(1) }
  static func main() {
    let a = CommandLine.arguments
    guard a.count >= 3 else { fail("usage: pdftool pages|merge|images …") }
    switch a[1] {
    case "pages":
      guard let d = PDFDocument(url: URL(fileURLWithPath: a[2])) else { fail("not a PDF: \(a[2])") }
      print(d.pageCount)
    case "merge", "images":
      guard a.count >= 4 else { fail("need an output and at least one input") }
      let out = URL(fileURLWithPath: a[2])
      if FileManager.default.fileExists(atPath: out.path) { fail("output exists: \(out.path)") }
      let doc = PDFDocument()
      for p in a[3...] {
        let u = URL(fileURLWithPath: p)
        if a[1] == "merge" {
          guard let d = PDFDocument(url: u) else { fail("not a PDF: \(p)") }
          for i in 0..<d.pageCount { if let pg = d.page(at: i) { doc.insert(pg, at: doc.pageCount) } }
        } else {
          guard let img = NSImage(contentsOf: u), let pg = PDFPage(image: img) else { fail("not an image: \(p)") }
          doc.insert(pg, at: doc.pageCount)
        }
      }
      guard doc.write(to: out) else { fail("could not write \(out.path)") }
      print(doc.pageCount)
    default: fail("unknown command \(a[1])")
    }
  }
}
