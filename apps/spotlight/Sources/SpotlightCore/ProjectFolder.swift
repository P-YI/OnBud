// Which folders the launcher may hand to the controller as the project folder. The controller itself only
// refuses $HOME and paths outside it; the launcher also keeps credentials, app data and hidden folders out.
import Foundation

public enum ProjectFolder {
    /** Folders the launcher will not hand to the controller: credentials, app data and hidden folders. */
    public static func problem(_ path: String) -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.path
        let p = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
        if p == home { return "Pick a folder inside your home folder, not the home folder itself." }
        if !p.hasPrefix(home + "/") { return "Pick a folder inside your home folder." }
        let rel = String(p.dropFirst(home.count + 1))
        if rel == "Library" || rel.hasPrefix("Library/") && !rel.hasPrefix("Library/Mobile Documents") {
            return "~/Library holds app data, keychains and mail; pick a project folder instead."
        }
        if rel.split(separator: "/").contains(where: { $0.hasPrefix(".") }) {
            return "Hidden folders (like ~/.ssh or ~/.config) can hold keys and tokens; pick a project folder instead."
        }
        return nil
    }
}
