// Translation languages plugin: which of Apple's on-device translation languages are downloaded (Translation
// framework), a Download button per language (macOS shows its own download sheet), and the controller's
// translator binary (tools/translate/Translate.swift → ~/OnBud/runtime/bin/afm-translate, built on first use).
import AppKit
import SpotlightCore
import SwiftUI
import Translation

struct LanguagePack: Identifiable, Equatable {
    let code: String          // "ko", "ja", "zh-Hans"…
    let name: String
    var installed: Bool
    var id: String { code }
}

@MainActor
final class TranslationModel: ObservableObject {
    @Published var packs: [LanguagePack] = []
    @Published var scanned = false
    @Published var building = false
    @Published var message: String?
    @Published var download: TranslationSession.Configuration?

    let paths = OnBudPaths()
    var binary: URL { paths.home.appendingPathComponent("runtime/bin/afm-translate") }
    var source: URL { paths.repo.appendingPathComponent("tools/translate/Translate.swift") }
    var built: Bool { FileManager.default.isExecutableFile(atPath: binary.path) }

    /** Every language Apple translates, with "downloaded" = the pair with English works offline. */
    func scan() async {
        let availability = LanguageAvailability()
        let en = Locale.Language(identifier: "en")
        var out: [LanguagePack] = []
        for lang in await availability.supportedLanguages where lang.languageCode?.identifier != "en" {
            let code = lang.minimalIdentifier
            let status = await availability.status(from: lang, to: en)
            out.append(LanguagePack(code: code, name: Locale.current.localizedString(forIdentifier: code) ?? code, installed: status == .installed))
        }
        // The controller's pair (Korean → English) first, then downloaded ones, then the rest by name.
        packs = out.sorted { a, b in
            if (a.code == "ko") != (b.code == "ko") { return a.code == "ko" }
            if a.installed != b.installed { return a.installed }
            return a.name < b.name
        }
        scanned = true
    }

    /** Starts the system download for <language> ↔ English (TranslationSession.prepareTranslation). */
    func requestDownload(_ p: LanguagePack) {
        download = .init(source: Locale.Language(identifier: p.code), target: Locale.Language(identifier: "en"))
    }

    /** Builds the translator now (the controller would otherwise build it on its first Korean document question). */
    func build() {
        guard FileManager.default.fileExists(atPath: source.path) else { message = "No translator source in the checkout (\(source.path))."; return }
        building = true; message = "Building the translator (swiftc, about a minute)…"
        let src = source.path, out = binary.path
        Task.detached {
            try? FileManager.default.createDirectory(atPath: (out as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/swiftc")
            p.arguments = ["-O", "-parse-as-library", "-o", out, src]
            let err = Pipe(); p.standardError = err; p.standardOutput = FileHandle.nullDevice
            var ok = false, why = ""
            do { try p.run(); p.waitUntilExit(); ok = p.terminationStatus == 0 }
            catch { why = error.localizedDescription }
            if !ok && why.isEmpty { why = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).prefix(300).description }
            let result = ok ? "Translator built: \(out)" : "Build failed: \(why)"
            await MainActor.run {
                self.building = false
                self.message = result
                self.objectWillChange.send()
            }
        }
    }
}

struct TranslationSection: View {
    @ObservedObject var m: TranslationModel
    var onChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(m.built ? "Translator built" : "Translator not built yet (built on first use)",
                      systemImage: m.built ? "checkmark.circle.fill" : "hammer")
                    .font(.callout).foregroundStyle(m.built ? .green : .secondary)
                Spacer()
                Button(m.built ? "Rebuild" : "Build now") { m.build() }.controlSize(.small).disabled(m.building)
            }
            if !m.scanned {
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Checking the language packs…").font(.callout).foregroundStyle(.secondary) }
            } else {
                let installed = m.packs.filter(\.installed)
                Text(installed.isEmpty ? "No language packs downloaded yet. Korean ↔ English is the one the AFM Agent uses."
                     : "Downloaded (with English): " + installed.map(\.name).joined(separator: ", "))
                    .font(.callout).foregroundStyle(.secondary)
                DisclosureGroup("Languages") {
                    ForEach(m.packs) { p in
                        HStack {
                            Text(p.name + (p.code == "ko" ? "  (used by the AFM Agent)" : ""))
                            Spacer()
                            if p.installed { Label("Downloaded", systemImage: "checkmark.circle.fill").foregroundStyle(.green).font(.callout) }
                            else { Button("Download…") { m.requestDownload(p) }.controlSize(.small) }
                        }
                    }
                    Button("Open Language & Region > Translation Languages…") {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Localization-Settings.extension")!)
                    }
                    .controlSize(.small)
                }
            }
            if let msg = m.message { Text(msg).font(.callout).textSelection(.enabled) }
        }
        .task { if !m.scanned { await m.scan() } }
        // macOS shows its download sheet here; afterwards the list is checked again.
        .translationTask(m.download) { session in
            do { try await session.prepareTranslation(); await MainActor.run { m.message = "Language pack downloaded." } }
            catch { await MainActor.run { m.message = "Not downloaded: \(error.localizedDescription)" } }
            await m.scan()
            await MainActor.run { m.download = nil; onChange() }
        }
    }
}
