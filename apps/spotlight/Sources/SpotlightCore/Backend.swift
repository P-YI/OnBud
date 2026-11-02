// Finds what is already installed: apfel (AFM, 11434), the OpenAFM controller (11435), Decima on
// Ollaya (11436), the ~/OpenAFM checkout and its LaunchAgents. Probes loopback only and installs nothing.
import Foundation

public struct OpenAFMPaths: Sendable {
    public let home: URL            // ~/OpenAFM (or $OPENAFM_HOME)
    public init(home: URL? = nil) {
        if let home { self.home = home }
        else if let env = ProcessInfo.processInfo.environment["OPENAFM_HOME"], !env.isEmpty { self.home = URL(fileURLWithPath: env) }
        else { self.home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("OpenAFM") }
    }
    public var repo: URL { home.appendingPathComponent("adaptive-coding-agent") }
    public var token: URL { home.appendingPathComponent("config/apfel.token") }
    public var globalOpenCodeSource: URL { repo.appendingPathComponent("opencode/opencode.global.jsonc") }
    public static func launchAgent(_ label: String) -> URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }
    public func readToken() -> String? {
        (try? String(contentsOf: token, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }
}

public enum Port {
    public static let apfel = 11434, controller = 11435, decima = 11436, searxng = 8888
}

public struct BackendStatus: Sendable, Equatable {
    public var apfel = false             // AFM answers /health
    public var controller = false        // OpenAFM controller answers /health
    public var decima = false            // Ollaya answers
    public var searxng = false           // local SearXNG answers (web search plugin)
    public var checkout = false          // ~/OpenAFM/adaptive-coding-agent exists
    public var token = false             // ~/OpenAFM/config/apfel.token readable
    public var tokenPrivate = false      // …and not readable by other users (mode 600)
    public var agentLaunchAgent = false  // dev.openafm.agent
    public var apfelLaunchAgent = false  // dev.openafm.apfel
    public init() {}

    /** The launcher can work: the controller is up and we can authenticate to it. */
    public var usable: Bool { controller && token }
    /** Nothing of OpenAFM on this Mac → setup screen. */
    public var nothingInstalled: Bool { !checkout && !controller && !apfel && !agentLaunchAgent }
}

public enum Backend {
    /** Only 127.0.0.1 is ever contacted. */
    public static func url(_ port: Int, _ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)\(path)")! }

    static func reachable(_ port: Int, _ path: String, timeout: TimeInterval = 1.5) async -> Bool {
        var req = URLRequest(url: url(port, path), timeoutInterval: timeout)
        req.httpMethod = "GET"
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return ((resp as? HTTPURLResponse)?.statusCode ?? 0) == 200
        } catch { return false }
    }

    public static func probe(paths: OpenAFMPaths = OpenAFMPaths()) async -> BackendStatus {
        async let a = reachable(Port.apfel, "/health")
        async let c = reachable(Port.controller, "/health")
        async let d = reachable(Port.decima, "/api/tags")
        async let w = reachable(Port.searxng, "/healthz")
        var s = BackendStatus()
        let fm = FileManager.default
        s.checkout = fm.fileExists(atPath: paths.repo.appendingPathComponent("bin/afm-agent-server.ts").path)
        s.token = paths.readToken() != nil
        let mode = ((try? FileManager.default.attributesOfItem(atPath: paths.token.path))?[.posixPermissions] as? NSNumber)?.intValue ?? 0o777
        s.tokenPrivate = s.token && mode & 0o077 == 0
        s.agentLaunchAgent = fm.fileExists(atPath: OpenAFMPaths.launchAgent("dev.openafm.agent").path)
        s.apfelLaunchAgent = fm.fileExists(atPath: OpenAFMPaths.launchAgent("dev.openafm.apfel").path)
        s.apfel = await a; s.controller = await c; s.decima = await d; s.searxng = await w
        return s
    }
}

/** A model installed in Ollaya (127.0.0.1:11436): the router plugin's choices. */
public struct RouterModel: Sendable, Equatable, Identifiable {
    public let name: String, family: String, parameters: String, bytes: Int64
    public let digest: String         // hex, without "sha256:"
    public var id: String { name }
    public init(name: String, family: String = "", parameters: String = "", bytes: Int64 = 0, digest: String = "") {
        self.name = name; self.family = family; self.parameters = parameters; self.bytes = bytes; self.digest = digest
    }
    /** "decima:agent" → "Decima" (for "AFM + Decima"). */
    public var shortName: String {
        let base = name.split(separator: ":").first.map(String.init) ?? name
        return base.prefix(1).uppercased() + base.dropFirst()
    }
    public var summary: String {
        [parameters, family, bytes > 0 ? ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file) : ""]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

extension Backend {
    /** Models Ollaya serves (/api/tags); empty when it is not running. */
    public static func routerModels() async -> [RouterModel] {
        guard let (data, resp) = try? await URLSession.shared.data(for: URLRequest(url: url(Port.decima, "/api/tags"), timeoutInterval: 1.5)),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return [] }
        return parseRouterModels(data)
    }
    public static func parseRouterModels(_ data: Data) -> [RouterModel] {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let ms = o["models"] as? [[String: Any]] else { return [] }
        return ms.compactMap { m in
            guard let name = m["name"] as? String ?? m["model"] as? String else { return nil }
            let d = m["details"] as? [String: Any]
            return RouterModel(name: name, family: d?["family"] as? String ?? "", parameters: d?["parameter_size"] as? String ?? "",
                               bytes: (m["size"] as? NSNumber)?.int64Value ?? 0,
                               digest: (m["digest"] as? String ?? "").replacingOccurrences(of: "sha256:", with: ""))
        }
    }
}

/** The router model version the routing thresholds were calibrated on (policies/routing.yaml). */
public struct RouterPin: Sendable, Equatable {
    public let model: String, digestPrefix: String
    public init(model: String, digestPrefix: String) { self.model = model; self.digestPrefix = digestPrefix }

    public static func load(paths: OpenAFMPaths = OpenAFMPaths()) -> RouterPin? {
        guard let y = try? String(contentsOf: paths.repo.appendingPathComponent("policies/routing.yaml"), encoding: .utf8) else { return nil }
        return parse(y)
    }
    public static func parse(_ yaml: String) -> RouterPin? {
        func value(_ key: String) -> String? {
            guard let r = yaml.range(of: #"(?m)^\s*"# + key + #":\s*([^\s#]+)"#, options: .regularExpression) else { return nil }
            return String(yaml[r]).components(separatedBy: ":").dropFirst().joined(separator: ":").trimmingCharacters(in: .whitespaces)
        }
        guard let digest = value("decima_model_digest"), !digest.isEmpty else { return nil }
        return RouterPin(model: value("decima_model") ?? "decima:agent", digestPrefix: digest)
    }
    /** nil = not the pinned model (or no digest reported); false = the pinned model in another version (shadow). */
    public func matches(_ m: RouterModel) -> Bool? {
        guard m.name == model, !m.digest.isEmpty else { return nil }
        return m.digest.hasPrefix(digestPrefix)
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
