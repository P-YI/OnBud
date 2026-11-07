// Upgrade from v0.1.0, when the project was called OpenAFM. Runs once at launch, before anything reads paths
// or settings; every step is skipped when its target already exists, so it is safe to run on every launch.
//   1. Data folder: ~/OnBud missing but ~/OpenAFM present → ~/OnBud becomes a symlink to it (nothing is moved,
//      so LaunchAgents, OpenCode configs and checkouts that name the old path keep working). A ~/OnBud that holds
//      only logs written before this ran is folded into ~/OpenAFM first.
//   2. Chat history and widget snapshot: ~/Library/Application Support/OpenAFM → …/OnBud (moved).
//   3. Settings: the old app's preferences domain is copied into this one (keys this app already has win).
// The old LaunchAgents are replaced by scripts/afm-launchagent.sh install; the old app is offered to the Trash;
// setup updates a controller copy that still carries the old marker file.
import Foundation

public enum LegacyMigration {
    public static let oldName = "OpenAFM"
    public static let oldBundleID = "dev.openafm.spotlight"
    /** The marker a v0.1.0 controller copy carries (now .onbud-bundled); setup still treats it as its own copy. */
    public static let oldMarker = ".openafm-bundled"
    /** The MCP server's v0.1.0 name in OpenCode configs; the config link replaces it with "onbud". */
    public static let oldMCPName = "openafm"
    static let doneKey = "legacyMigrationDone"

    /** Runs the three steps; returns one line per step taken (for the log). */
    @discardableResult
    public static func run(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                           environment: [String: String] = ProcessInfo.processInfo.environment,
                           defaults: UserDefaults? = .standard) -> [String] {
        let fm = FileManager.default
        var done: [String] = []
        // 1. Data folder (only when ONBUD_HOME does not point elsewhere).
        if (environment["ONBUD_HOME"] ?? "").isEmpty {
            let new = home.appendingPathComponent("OnBud"), old = home.appendingPathComponent(oldName)
            var isDir: ObjCBool = false
            let isLink = (try? fm.destinationOfSymbolicLink(atPath: new.path)) != nil
            let oldIsDir = fm.fileExists(atPath: old.path, isDirectory: &isDir) && isDir.boolValue
            // A real ~/OnBud without config/ was made by a process that ran the new code first (logs only):
            // fold its files into the old folder, then link.
            if !isLink, oldIsDir, fm.fileExists(atPath: new.path),
               !fm.fileExists(atPath: new.appendingPathComponent("config").path),
               fm.fileExists(atPath: old.appendingPathComponent("config").path) {
                fold(new, into: old)
                if (try? fm.contentsOfDirectory(atPath: new.path))?.isEmpty == true { try? fm.removeItem(at: new) }
            }
            if !isLink, !fm.fileExists(atPath: new.path), oldIsDir,
               (try? fm.createSymbolicLink(atPath: new.path, withDestinationPath: old.path)) != nil {
                done.append("linked ~/OnBud → ~/\(oldName)")
            }
        }
        // 2. Application Support folder.
        let support = home.appendingPathComponent("Library/Application Support")
        let oldSupport = support.appendingPathComponent(oldName), newSupport = support.appendingPathComponent("OnBud")
        if fm.fileExists(atPath: oldSupport.path), !fm.fileExists(atPath: newSupport.path),
           (try? fm.moveItem(at: oldSupport, to: newSupport)) != nil {
            done.append("moved Application Support/\(oldName) → OnBud")
        }
        // 3. Preferences.
        if let defaults, !defaults.bool(forKey: doneKey) {
            if let old = defaults.persistentDomain(forName: oldBundleID), !old.isEmpty {
                for (k, v) in old where defaults.object(forKey: k) == nil { defaults.set(v, forKey: k) }
                done.append("copied \(old.count) settings from \(oldBundleID)")
            }
            defaults.set(true, forKey: doneKey)
        }
        return done
    }

    /** Moves every file under `src` into the same place under `dst` (a file that exists there gets the moved
     *  file's bytes appended: these are logs), removing the emptied folders of `src`. */
    static func fold(_ src: URL, into dst: URL) {
        let fm = FileManager.default
        for name in (try? fm.contentsOfDirectory(atPath: src.path)) ?? [] {
            let s = src.appendingPathComponent(name), d = dst.appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: s.path, isDirectory: &isDir) else { continue }
            if isDir.boolValue {
                try? fm.createDirectory(at: d, withIntermediateDirectories: true)
                fold(s, into: d)
                if (try? fm.contentsOfDirectory(atPath: s.path))?.isEmpty == true { try? fm.removeItem(at: s) }
            } else if fm.fileExists(atPath: d.path) {
                if let data = try? Data(contentsOf: s), let h = try? FileHandle(forWritingTo: d) {
                    h.seekToEndOfFile(); h.write(data); try? h.close(); try? fm.removeItem(at: s)
                }
            } else {
                try? fm.moveItem(at: s, to: d)
            }
        }
    }

    /** The v0.1.0 app, if it is still installed next to this one. */
    public static func oldApp(applications: URL = URL(fileURLWithPath: "/Applications")) -> URL? {
        let u = applications.appendingPathComponent("\(oldName).app")
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }
}
