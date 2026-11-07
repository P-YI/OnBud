// Smoke checks for the OnBud launcher (the Command Line Tools have no XCTest):
//   1. core: SSE parsing, meta split, JSONC, OpenCode merge/symlink detection/backup (temp dirs only)
//   2. live: the panel's own request path against the running controller, own-suite style —
//      document question, terminal command with approve and deny, small edit (trial → apply → tests).
// usage: spotlight-smoke [--offline] [--setting s2|s3] [--keep]
import Foundation
import SpotlightCore

let args = CommandLine.arguments
let offline = args.contains("--offline")
let keep = args.contains("--keep")
let setting = args.firstIndex(of: "--setting").flatMap { Setting(rawValue: args[$0 + 1]) } ?? .s2
var failures = 0

func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
    print("\(ok ? "PASS" : "FAIL")  \(name)\(ok || detail().isEmpty ? "" : "\n      " + detail().replacingOccurrences(of: "\n", with: "\n      "))")
    if !ok { failures += 1 }
}

// MARK: 1. core

check("SSE: content delta", parseSSELine(#"data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}"#) == .text("hi"))
check("SSE: keep-alive ignored", parseSSELine(": working") == nil)
check("SSE: [DONE] ignored", parseSSELine("data: [DONE]") == nil)
check("SSE: final chunk carries awaiting",
      parseSSELine(#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"onbud":{"setting":"s2","awaiting":"command"}}"#) == .done(awaiting: "command"))
check("SSE: final chunk without metadata", parseSSELine(#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#) == .done(awaiting: nil))
let sm = splitMeta("Answer.\n\n— AFM controller · LOCAL_AFM · ok · 1.0s")
check("meta split", sm.body == "Answer." && sm.meta == "AFM controller · LOCAL_AFM · ok · 1.0s")

do {
    let v = try JSONC.parse("{\n  // c\n  \"a\": [1, 2,], /* x */ \"b\": {\"c\": \"d\\u00e9\"},\n}")
    check("JSONC: comments + trailing commas", v["a"] == .array([.number("1"), .number("2")]) && v["b"]?["c"] == .string("dé") && v.keys == ["a", "b"])
    check("JSONC: round trip", try JSONC.parse(v.pretty()) == v)
} catch { check("JSONC parse", false, "\(error)") }

let home = FileManager.default.homeDirectoryForCurrentUser.path
check("folder guard: Desktop allowed", ProjectFolder.problem(home + "/Desktop") == nil)
check("folder guard: home, ~/.ssh, ~/Library, /tmp refused",
      [home, home + "/.ssh", home + "/Library/Keychains", "/tmp"].allSatisfy { ProjectFolder.problem($0) != nil })
let script = OpenCodeHandoff.runScript(cli: "/x/opencode", dir: "/a b", prompt: "it's $(rm -rf ~) `x`")
check("CLI hand-off (opencode run fallback) quotes the request, on the codex agent",
      script.contains(#"run --agent codex --title 'OnBud hand-off' 'it'\''s $(rm -rf ~) `x`'"#) && script.contains("cd '/a b'"))
let tui = OpenCodeHandoff.sessionScript(cli: "/x/opencode", dir: "/a b", session: "ses_abc123def456")
check("CLI hand-off opens the OpenCode 2 TUI on the session (no --agent)",
      tui.contains("'/x/opencode' '/a b' --session 'ses_abc123def456'") && !tui.contains("--agent"))

check("SSE: step event", parseSSELine(#"data: {"choices":[{"index":0,"delta":{},"finish_reason":null}],"onbud":{"step":"seed","detail":"1 blocks"}}"#) == .step("seed", "1 blocks"))
check("step label", StepLabel.text("seed", "") == "Searching the folder…")
check("attachments: files relative to root, text quoted",
      Attachments.compose("Q", [.file(URL(fileURLWithPath: "/r/a/b.pdf")), .text("hello", source: "clipboard")], root: "/r")
        == "Q\n\nFiles: a/b.pdf\n\nText (clipboard):\n\"\"\"\nhello\n\"\"\"")
check("attachments: outside files → their common folder",
      Attachments.root(for: [URL(fileURLWithPath: "/x/p/a.pdf"), URL(fileURLWithPath: "/x/q/b.pdf")], current: "/r") == "/x")
check("attachments: long text truncated", Attachments.compose("Q", [.text(String(repeating: "x", count: 9000), source: "s")], root: nil).count < 4200)
check("recent folders: dedupe, newest first, max 6", RecentFolders.updated(["a", "b", "c", "d", "e", "f"], adding: "c") == ["c", "a", "b", "d", "e", "f"])
let hs = HistoryStore(file: FileManager.default.temporaryDirectory.appendingPathComponent("onbud-smoke-\(UUID().uuidString)/history.json"))
let chat = SavedChat(root: "/r", messages: [ChatMessage(role: "user", content: "hi"), ChatMessage(role: "assistant", content: "yo")])
hs.save(chat); var chat2 = chat; chat2.messages.append(ChatMessage(role: "user", content: "more")); hs.save(chat2)
let mode = ((try? FileManager.default.attributesOfItem(atPath: hs.file.path))?[.posixPermissions] as? NSNumber)?.intValue ?? 0
check("history: replace by id, owner-only file", hs.load().count == 1 && hs.load()[0].messages.count == 3 && mode == 0o600)
hs.clear(); try? FileManager.default.removeItem(at: hs.file.deletingLastPathComponent())
let tmpProj = FileManager.default.temporaryDirectory.appendingPathComponent("onbud-qa-\(UUID().uuidString.prefix(6))")
try? FileManager.default.createDirectory(at: tmpProj.appendingPathComponent(".git"), withIntermediateDirectories: true)
try? "x".write(to: tmpProj.appendingPathComponent("main.tex"), atomically: true, encoding: .utf8)
let qa = QuickActions.suggest(root: tmpProj.path, latex: true).map(\.title)
check("quick actions fit the folder", qa.contains("Compile the paper") && qa.contains("Check citations") && qa.contains("Recent commits") && !qa.contains("Describe the documents"))
check("quick actions: git folder offers change summary and commit message", qa.contains("Summarize changes") && qa.contains("Commit message"))
try? "y".write(to: tmpProj.appendingPathComponent("src.ts"), atomically: true, encoding: .utf8)
check("links: bare URL autolinked, code spans left alone",
      MarkdownLinks.autolinked("see https://a.dev/x. and `https://b.dev` or [t](https://c.dev)") == "see <https://a.dev/x>. and `https://b.dev` or [t](https://c.dev)")
check("links: existing file path in code resolves against the folder, file:line too",
      MarkdownLinks.fileURL("src.ts:12", root: tmpProj.path, mustExist: true)?.path == tmpProj.appendingPathComponent("src.ts").standardizedFileURL.path
      && MarkdownLinks.fileURL("missing.ts", root: tmpProj.path, mustExist: true) == nil
      && MarkdownLinks.fileURL("npm test", root: tmpProj.path, mustExist: true) == nil)
try? FileManager.default.removeItem(at: tmpProj)
check("step labels: local skill named, unknown kinds in words",
      StepLabel.text("skill", "commit_message") == "Writing a commit message…" && StepLabel.text("skill_change_summary", "ok") == "Summarizing the changes…"
      && StepLabel.text("brand_new_step", "") == "Brand new step…")
let rm = Backend.parseRouterModels(#"{"models":[{"name":"decima:agent","size":1324002485,"details":{"family":"decima","parameter_size":"321M"}}]}"#.data(using: .utf8)!)
check("router models: parsed from /api/tags", rm.count == 1 && rm[0].shortName == "Decima" && rm[0].summary.hasPrefix("321M · decima"), "\(rm)")
let pin = RouterPin.parse("decision:\n  decima_model: decima:agent\n  decima_model_digest: e14e614ce4ab   # note\n")
check("router pin: parsed; matching and moved versions told apart",
      pin == RouterPin(model: "decima:agent", digestPrefix: "e14e614ce4ab")
      && pin?.matches(RouterModel(name: "decima:agent", digest: "e14e614ce4ab1ae2")) == true
      && pin?.matches(RouterModel(name: "decima:agent", digest: "ffff")) == false
      && pin?.matches(RouterModel(name: "other:x", digest: "ffff")) == nil)
// The setup script pulls the version the policy pins (both live in the repository).
let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../..").standardizedFileURL
if let setup = try? String(contentsOf: repoRoot.appendingPathComponent("scripts/decima-setup.sh"), encoding: .utf8),
   let policy = try? String(contentsOf: repoRoot.appendingPathComponent("policies/routing.yaml"), encoding: .utf8),
   let p = RouterPin.parse(policy) {
    check("decima-setup.sh pulls the pinned decima:agent digest", setup.contains("sha256:" + p.digestPrefix))
} else { check("decima-setup.sh pulls the pinned decima:agent digest", false, "files not found under \(repoRoot.path)") }
// JSONC in-place edits keep comments and touch only the edited values.
let jt = "{\n  // keep me\n  \"agent\": {\n    \"codex\": { \"model\": \"openai/a\", \"variant\": \"medium\" }, // trailing\n    \"codex-solve\": {\n      \"mode\": \"primary\"\n    }\n  }\n}\n"
if let e1 = try? FrontierAgents.apply(jt, model: "anthropic/claude-x", variant: nil) {
    check("jsonc edit: model set, variant removed, missing key inserted, comments kept",
          e1.contains("// keep me") && e1.contains("// trailing") && !e1.contains("variant")
          && FrontierAgents.current(e1).model == "anthropic/claude-x" && JSONCEdit.string(e1, ["agent", "codex-solve", "model"]) == "anthropic/claude-x"
          && JSONCEdit.string(e1, ["agent", "codex-solve", "mode"]) == "primary", e1)
} else { check("jsonc edit: model set, variant removed, missing key inserted, comments kept", false) }
let realCfg = repoRoot.appendingPathComponent("opencode/opencode.global.jsonc")
if let cfg = try? String(contentsOf: realCfg, encoding: .utf8), let e2 = try? FrontierAgents.apply(cfg, model: "openai/test-model", variant: "high") {
    let before = cfg.components(separatedBy: "\n"), after = e2.components(separatedBy: "\n")
    let changed = zip(before, after).filter { $0 != $1 }.map(\.1)
    check("jsonc edit on the repo's OpenCode config: only model/variant lines change",
          before.count == after.count && !changed.isEmpty && changed.allSatisfy { $0.contains("\"model\": \"openai/test-model\"") || $0.contains("\"variant\": \"high\"") }
          && FrontierAgents.current(e2).present == FrontierAgents.agents, changed.joined(separator: " | "))
} else { check("jsonc edit on the repo's OpenCode config: only model/variant lines change", false) }
if let cfg = try? String(contentsOf: realCfg, encoding: .utf8), let e3 = try? FrontierAgents.apply(cfg, model: "openai/test-cheap", variant: nil, tier: .cheap) {
    check("cheap tier: only codex-solve-cheap changes; defaults Terra (cheap) and Sol (strong)",
          FrontierAgents.current(cfg, tier: .cheap).model == FrontierAgents.Tier.cheap.defaultModel
          && FrontierAgents.current(cfg).model == FrontierAgents.Tier.strong.defaultModel
          && JSONCEdit.string(e3, ["agent", "codex-solve-cheap", "model"]) == "openai/test-cheap"
          && JSONCEdit.string(e3, ["agent", "codex-solve-cheap", "variant"]) == nil
          && FrontierAgents.current(e3).model == FrontierAgents.current(cfg).model)
} else { check("cheap tier: only codex-solve-cheap changes; defaults Terra (cheap) and Sol (strong)", false) }
check("cheap tier missing → a clear error, config untouched", (try? FrontierAgents.apply(jt, model: "x/y", variant: nil, tier: .cheap)) == nil)
check("opencode models / auth list parsed",
      FrontierAgents.parseModels("opencode/big-pickle\nafm/apple-foundationmodel\nopenai/gpt-6.1-sol\nanthropic/claude-x\n") == ["opencode": ["opencode/big-pickle"], "openai": ["openai/gpt-6.1-sol"], "anthropic": ["anthropic/claude-x"]]
      && FrontierAgents.parseAuth("\u{1B}[0m\n┌  Credentials\n│\n●  OpenAI \u{1B}[90moauth\n●  Anthropic \u{1B}[90mapi\n└  2 credentials") == ["OpenAI", "Anthropic"]
      && FrontierAgents.parseAuth("OpenAI  OAuth                       stored\nGitHub Copilot  OAuth  stored\n") == ["OpenAI", "GitHub Copilot"])
// GitHub Copilot tier: status/sign-in output, quota, and the one-line copilot_mode edit.
check("copilot: status and device code parsed (github.com only)",
      Copilot.parseStatus("x\nstatus: OK P-YI\n")! == ("OK", "P-YI") && Copilot.parseStatus("status: NotSignedIn ")!.status == "NotSignedIn"
      && Copilot.parseDeviceCode("Open https://github.com/login/device and enter the code: AB12-CD34")?.code == "AB12-CD34"
      && Copilot.parseDeviceCode("Open https://evil.example/login and enter the code: AB12-CD34") == nil)
let cq = Copilot.parseQuota(#"{"copilot_plan":"individual","quota_reset_date":"2026-12-01","quota_snapshots":{"completions":{"unlimited":true},"premium_interactions":{"unlimited":false,"quota_remaining":198.8,"percent_remaining":99.4}}}"#.data(using: .utf8)!)
check("copilot: quota line", cq?.completionsUnlimited == true && cq?.premiumRemaining == 198.8 && cq?.summary.contains("premium requests 199 left") == true, cq?.summary ?? "")
if let pol = try? String(contentsOf: repoRoot.appendingPathComponent("policies/routing.yaml"), encoding: .utf8), let saver = CopilotMode.write(pol, .saver) {
    let diffLines = zip(pol.components(separatedBy: "\n"), saver.components(separatedBy: "\n")).filter { $0 != $1 }
    check("copilot_mode: only that line changes in the repo's routing.yaml",
          CopilotMode.read(saver) == .saver && diffLines.count == 1 && diffLines[0].1.trimmingCharacters(in: .whitespaces) == "copilot_mode: saver"
          && CopilotMode.write(saver, .balanced) == pol || CopilotMode.read(pol) == .saver, diffLines.map(\.1).joined())
} else { check("copilot_mode: only that line changes in the repo's routing.yaml", false, "no copilot_mode line") }
check("client: router model header only with the router setting",
      (try? ControllerClient(token: "t", setting: .s3, routerModel: "decima:agent").request(messages: [], root: nil).value(forHTTPHeaderField: "x-onbud-router-model")) == "decima:agent"
      && (try? ControllerClient(token: "t", setting: .s2, routerModel: "decima:agent").request(messages: [], root: nil).value(forHTTPHeaderField: "x-onbud-router-model")) == .some(nil))
let wsFile = FileManager.default.temporaryDirectory.appendingPathComponent("onbud-widget-\(UUID().uuidString.prefix(6))/snapshot.json")
WidgetSnapshot(question: "Q", answer: String(repeating: "a", count: 900), folder: "Desktop").save(to: wsFile)
let wsMode = ((try? FileManager.default.attributesOfItem(atPath: wsFile.path))?[.posixPermissions] as? NSNumber)?.intValue ?? 0
check("widget snapshot: round trip, shortened, owner-only", WidgetSnapshot.load(from: wsFile)?.answer.count == WidgetSnapshot.maxAnswer + 1 && wsMode == 0o600)
try? FileManager.default.removeItem(at: wsFile.deletingLastPathComponent())
check("widget text: markdown markers dropped, tables as lines",
      WidgetSnapshot.plain("### Title\n| A | B |\n|---|---|\n| `x` | **y** |\n- item") == "Title\nA · B\nx · y\n• item")
let inst = Plugins.installCommandFile(.web, repo: URL(fileURLWithPath: "/repo dir"))
check("plugin install script asks first and quotes paths", inst.contains("read -q") && inst.contains("cd '/repo dir' && scripts/searxng-setup.sh install"))

let md = MarkdownBlocks.parse("### Things\n\n| Command | What |\n|---|---|\n| `job <id> apply \\| review` | Manage |\n| `x` |\n\n- one\n  - two\n1. first\n```sh\nls\n```\n> note\ntext")
check("markdown: heading, table (escaped pipe, short row padded), lists, code, quote, paragraph", md == [
    .heading(level: 3, text: "Things"),
    .table(header: ["Command", "What"], rows: [["`job <id> apply | review`", "Manage"], ["`x`", ""]]),
    .bullet(indent: 0, marker: "•", text: "one"), .bullet(indent: 1, marker: "•", text: "two"), .bullet(indent: 0, marker: "1.", text: "first"),
    .code(lang: "sh", text: "ls"), .quote("note"), .paragraph("text"),
], "\(md)")

let paths = OnBudPaths()
let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("afm-spotlight-smoke-\(UUID().uuidString.prefix(8))")
try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
defer { if !keep { try? FileManager.default.removeItem(at: tmp) } }

if let srcText = try? String(contentsOf: paths.globalOpenCodeSource, encoding: .utf8), let src = try? JSONC.parse(srcText) {
    check("repo opencode.global.jsonc parses", src["provider"]?["afm-agent"] != nil && src["mcp"]?["onbud"] != nil)
    // a) fresh config dir → creates opencode.json with everything
    let fresh = OpenCodeLink(configDir: tmp.appendingPathComponent("fresh"), source: paths.globalOpenCodeSource)
    if case .needsMerge(let plan) = fresh.inspect() {
        check("link: empty config needs merge", plan.added.contains("provider.afm-agent") && plan.added.contains("agent.codex") && plan.added.contains("mcp.onbud"))
        let backup = try? fresh.apply(plan)
        check("link: write without backup for a new file", backup == nil && FileManager.default.fileExists(atPath: plan.target.path))
        check("link: second inspect is a no-op", fresh.inspect() == .alreadyLinked)
    } else { check("link: empty config needs merge", false, "\(fresh.inspect())") }
    // b) user config with their own keys and an existing agent → only missing keys, user's values kept, backup made
    let userDir = tmp.appendingPathComponent("user")
    try? FileManager.default.createDirectory(at: userDir, withIntermediateDirectories: true)
    let userText = "{\n  // mine\n  \"theme\": \"dark\",\n  \"enabled_providers\": [\"anthropic\"],\n  \"agent\": { \"codex\": { \"model\": \"my/model\" } }\n}\n"
    try? userText.write(to: userDir.appendingPathComponent("opencode.jsonc"), atomically: true, encoding: .utf8)
    let user = OpenCodeLink(configDir: userDir, source: paths.globalOpenCodeSource)
    if case .needsMerge(let plan) = user.inspect() {
        let merged = try? JSONC.parse(plan.after)
        check("link: keeps user's values", merged?["theme"] == .string("dark") && merged?["agent"]?["codex"]?["model"] == .string("my/model") && !plan.added.contains("agent.codex"))
        check("link: enables the providers", plan.added.contains("enabled_providers.afm-agent"))
        check("link: diff shows additions", OpenCodeLink.diff(plan).contains("+    \"afm-agent\""))
        let backup = try? user.apply(plan)
        check("link: backup before write", backup.flatMap { try? String(contentsOf: $0, encoding: .utf8) } == userText)
    } else { check("link: user config needs merge", false, "\(user.inspect())") }
    // c) symlink to the repo file → nothing to do
    let linkDir = tmp.appendingPathComponent("symlink")
    try? FileManager.default.createDirectory(at: linkDir, withIntermediateDirectories: true)
    try? FileManager.default.createSymbolicLink(atPath: linkDir.appendingPathComponent("opencode.jsonc").path, withDestinationPath: paths.globalOpenCodeSource.path)
    if case .symlinkedToRepo = OpenCodeLink(configDir: linkDir, source: paths.globalOpenCodeSource).inspect() { check("link: symlink to repo detected", true) }
    else { check("link: symlink to repo detected", false) }
    // d) this Mac's real config (read only)
    print("info  ~/.config/opencode: \(OpenCodeLink().inspect())".prefix(200))
} else {
    print("skip  OpenCode merge checks (no \(paths.globalOpenCodeSource.path))")
}

// Skills switches (config/skills.json): defaults, toggles, unknown keys kept, atomic write with mode 600.
do {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("afm-skills-\(UUID().uuidString)")
    let f = dir.appendingPathComponent("config/skills.json")
    var s = SkillSettings.load(from: f)
    check("skills: defaults (web on, personal off, core on, convert 500 MB)",
          s.isOn("web") && !s.isOn("personal") && s.isOn("core") && s.convertMaxMB == 500)
    s.raw["future"] = ["x": 1]
    s.set("web", on: false); s.set("personal", on: true); s.set("core", on: false); s.convertMaxMB = 200
    try s.save(to: f)
    let back = SkillSettings.load(from: f)
    let mode = (try? FileManager.default.attributesOfItem(atPath: f.path)[.posixPermissions] as? Int) ?? 0
    check("skills: saved toggles, maxMB and unknown keys; mode 600",
          !back.isOn("web") && back.isOn("personal") && back.isOn("core") && back.convertMaxMB == 200
          && (back.raw["future"] as? [String: Int]) == ["x": 1] && (back.raw["disabled"] as? [String]) == ["web"]
          && (back.raw["enabled"] as? [String]) == ["personal"] && mode == 0o600, "\(back.raw) mode \(String(mode, radix: 8))")
    var t = back; t.set("web", on: true); t.set("personal", on: false)
    check("skills: turning back on/off clears the lists", t.raw["disabled"] == nil && t.raw["enabled"] == nil && !t.isOn("personal"))
    let infos = Skills.manifests(OnBudPaths(home: repoRoot.deletingLastPathComponent()))
    check("skills: all 13 manifests have a description", infos.count == 13 && infos.allSatisfy { !$0.description.isEmpty }, "\(infos.map(\.id))")
    let unknown = infos.flatMap { i in i.capabilities.filter { SkillCatalog.capability($0).symbol == "questionmark.circle" } + [i.lane].filter { SkillCatalog.lane($0).detail.isEmpty } + [i.egress].filter { SkillCatalog.egress($0).detail.isEmpty } }
    check("skills: every capability, lane and egress has a label", unknown.isEmpty, "\(unknown)")
    check("skills: personal is private, web sends a query", infos.first { $0.id == "personal" }?.isPrivate == true && infos.first { $0.id == "web" }?.egress == "query")
    try? FileManager.default.removeItem(at: dir)
} catch { check("skills: save", false, "\(error)") }

// Upgrade from v0.1.0 (OpenAFM): link, folded early logs, moved Application Support; a second run does nothing.
do {
    let fm = FileManager.default
    let h = fm.temporaryDirectory.appendingPathComponent("onbud-legacy-\(UUID().uuidString.prefix(6))")
    let old = h.appendingPathComponent(LegacyMigration.oldName), new = h.appendingPathComponent("OnBud")
    let sup = h.appendingPathComponent("Library/Application Support")
    for d in [old.appendingPathComponent("config"), old.appendingPathComponent("runtime/logs"), new.appendingPathComponent("runtime/logs"),
              sup.appendingPathComponent(LegacyMigration.oldName)] { try fm.createDirectory(at: d, withIntermediateDirectories: true) }
    try "a\n".write(to: old.appendingPathComponent("runtime/logs/gate.jsonl"), atomically: true, encoding: .utf8)
    try "b\n".write(to: new.appendingPathComponent("runtime/logs/gate.jsonl"), atomically: true, encoding: .utf8)
    try "[]".write(to: sup.appendingPathComponent("\(LegacyMigration.oldName)/history.json"), atomically: true, encoding: .utf8)
    let first = LegacyMigration.run(home: h, environment: [:], defaults: nil)
    let log = try? String(contentsOf: new.appendingPathComponent("runtime/logs/gate.jsonl"), encoding: .utf8)
    check("upgrade: ~/OnBud links to the old folder, early logs folded in",
          (try? fm.destinationOfSymbolicLink(atPath: new.path)) == old.path && log == "a\nb\n", "\(first) \(log ?? "nil")")
    check("upgrade: Application Support moved", fm.fileExists(atPath: sup.appendingPathComponent("OnBud/history.json").path)
          && !fm.fileExists(atPath: sup.appendingPathComponent(LegacyMigration.oldName).path))
    check("upgrade: a second run changes nothing; ONBUD_HOME skips the link",
          LegacyMigration.run(home: h, environment: [:], defaults: nil).isEmpty
          && LegacyMigration.run(home: h.appendingPathComponent("none"), environment: ["ONBUD_HOME": "/x"], defaults: nil).isEmpty)
    try? fm.removeItem(at: h)
} catch { check("upgrade: setup", false, "\(error)") }

do {
    let src = try JSONC.parse(#"{"mcp":{"onbud":{"type":"local"}}}"#)
    let user = try JSONC.parse(#"{"mcp":{"openafm":{"type":"local"},"other":{"type":"remote"}}}"#)
    let (m, added) = OpenCodeLink.merge(user, from: src)
    check("upgrade: the config link replaces the v0.1.0 MCP entry, keeps others",
          m["mcp"]?["onbud"] != nil && m["mcp"]?[LegacyMigration.oldMCPName] == nil && m["mcp"]?["other"] != nil, "\(added)")
} catch { check("upgrade: config link", false, "\(error)") }

// MARK: 2. live

let status = await Backend.probe(paths: paths)
print("info  backend: apfel=\(status.apfel) controller=\(status.controller) decima=\(status.decima) checkout=\(status.checkout) token=\(status.token) tokenPrivate=\(status.tokenPrivate) launchAgents=\(status.agentLaunchAgent && status.apfelLaunchAgent)")
for id in PluginID.allCases { let st = Plugins.detect(id, backend: status, paths: paths); print("info  plugin \(id.rawValue): installed=\(st.installed) ready=\(st.ready) — \(st.detail)") }
print("info  OpenCode service: \(OpenCodeService.load()?.url.absoluteString ?? "not running")")

func sh(_ cmd: String, in dir: URL) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", cmd]
    p.currentDirectoryURL = dir
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    try? p.run(); p.waitUntilExit()
    return p.terminationStatus
}

/** One launcher chat, exactly as the panel sends it. */
struct Chat {
    let client: ControllerClient
    var conv: Conversation
    mutating func say(_ text: String) async throws -> (String, String?) {
        conv.messages.append(ChatMessage(role: "user", content: text))
        let t0 = Date()
        let (reply, awaiting) = try await client.send(messages: conv.messages, root: conv.root)
        conv.messages.append(ChatMessage(role: "assistant", content: reply))
        conv.awaiting = awaiting
        print("      › \(text)  [\(String(format: "%.1f", Date().timeIntervalSince(t0)))s, awaiting=\(awaiting ?? "-")]  \(splitMeta(reply).meta ?? "")")
        return (reply, awaiting)
    }
}

if offline {
    print("skip  live checks (--offline)")
} else if !status.usable {
    check("controller reachable for live checks", false, "start dev.onbud.agent or pass --offline")
} else if let token = paths.readToken() {
    // The controller only reads folders inside $HOME, so the fixture lives under ~/OnBud/runtime.
    let fx = paths.home.appendingPathComponent("runtime/spotlight-smoke/\(Int(Date().timeIntervalSince1970))")
    let files: [String: String] = [
        "src/__init__.py": "", "tests/__init__.py": "",
        "src/stats.py": "def mean(xs):\n    return sum(xs) / (len(xs) - 1)\n",
        "tests/test_stats.py": "import unittest\nfrom src.stats import mean\n\n\nclass T(unittest.TestCase):\n    def test_mean(self):\n        self.assertEqual(mean([2, 4, 6]), 4)\n",
        "notes.md": "# Meeting notes\nThe release is planned for Friday. Mina owns the changelog.\n",
        "README.md": "# demo\n",
    ]
    for (p, body) in files {
        let u = fx.appendingPathComponent(p)
        try? FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? body.write(to: u, atomically: true, encoding: .utf8)
    }
    _ = sh("git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", in: fx)
    let client = ControllerClient(token: token, setting: setting)
    print("info  setting \(setting.rawValue), fixture \(fx.path)")
    do {
        var doc = Chat(client: client, conv: Conversation(root: fx.path))
        let (a, _) = try await doc.say("Summarize notes.md")
        check("document question answered from the file", a.range(of: "Friday|금요일", options: .regularExpression) != nil, String(a.prefix(400)))

        var steps: [String] = []
        let msgs = [ChatMessage(role: "user", content: "Summarize notes.md")]
        for try await ev in client.stream(messages: msgs, root: fx.path) { if case .step(let k, _) = ev { steps.append(k) } }
        check("progress: the controller streams its steps", steps.count >= 2, "\(steps)")

        var help = Chat(client: client, conv: Conversation(root: fx.path))
        let (h, _) = try await help.say("show commands")
        let tables = MarkdownBlocks.parse(splitMeta(h).body).filter { if case .table = $0 { return true }; return false }
        check("help reply renders as tables", tables.count >= 2, String(h.prefix(200)))

        var pasted = Chat(client: client, conv: Conversation(root: fx.path))
        let (p1, _) = try await pasted.say(Attachments.compose("What day is the launch? Answer with the day only.",
                                                               [.text("Team update: the launch moved to Thursday because of QA.", source: "clipboard")], root: fx.path))
        check("attached text is answered from", p1.range(of: "Thursday|목요일", options: .regularExpression) != nil, String(p1.prefix(300)))

        var cmd = Chat(client: client, conv: Conversation(root: fx.path))
        let (_, w1) = try await cmd.say("Run `touch approved.txt`")
        check("terminal: command waits for approval", w1 == "command" && !FileManager.default.fileExists(atPath: fx.appendingPathComponent("approved.txt").path))
        let (r1, _) = try await cmd.say("yes")
        check("terminal: approved command ran", FileManager.default.fileExists(atPath: fx.appendingPathComponent("approved.txt").path), String(r1.prefix(400)))

        var deny = Chat(client: client, conv: Conversation(root: fx.path))
        let (_, w2) = try await deny.say("Run `touch denied.txt`")
        let (r2, _) = try await deny.say("no")
        check("terminal: denied command did not run", w2 == "command" && !FileManager.default.fileExists(atPath: fx.appendingPathComponent("denied.txt").path), String(r2.prefix(200)))

        var edit = Chat(client: client, conv: Conversation(root: fx.path))
        var (e, w) = try await edit.say("src/stats.py의 mean 함수가 평균을 잘못 계산해. 고쳐줘")
        var rounds = 0
        while let kind = w, ["edit", "apply"].contains(kind), rounds < 3 { (e, w) = try await edit.say("yes"); rounds += 1 }
        check("small edit: proposed, tried, applied, tests pass", sh("python3 -m unittest -q tests.test_stats", in: fx) == 0, String(e.prefix(600)))
    } catch {
        check("live requests", false, (error as? LocalizedError)?.errorDescription ?? "\(error)")
    }
    if !keep { try? FileManager.default.removeItem(at: fx) }
}

print(failures == 0 ? "\nsmoke: all checks passed" : "\nsmoke: \(failures) check(s) failed")
exit(failures == 0 ? 0 : 1)
