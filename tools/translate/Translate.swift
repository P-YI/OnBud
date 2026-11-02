// On-device translation with Apple's Translation framework (translationd; no AFM, no network once the language
// pair is installed). Usage: afm-translate <source> <target> <text>  → the translation on stdout, exit 1 if the
// pair is not installed. Built by services/context-builder/translate.ts on first use.
import Foundation
import Translation

@main struct AfmTranslate {
  static func main() async {
    let a = CommandLine.arguments
    guard a.count >= 4 else { FileHandle.standardError.write("usage: afm-translate <from> <to> <text>\n".data(using: .utf8)!); exit(2) }
    let from = Locale.Language(identifier: a[1]), to = Locale.Language(identifier: a[2])
    guard await LanguageAvailability().status(from: from, to: to) == .installed else { exit(1) }
    do {
      let r = try await TranslationSession(installedSource: from, target: to).translate(a[3...].joined(separator: " "))
      print(r.targetText)
    } catch { exit(3) }
  }
}
