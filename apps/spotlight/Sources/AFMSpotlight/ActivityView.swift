// Activity window: the controller's local jobs (each on its own git branch) and background sessions
// (tmux -L onbud), with buttons that send the matching chat command through the panel.
import SpotlightCore
import SwiftUI

struct ActivityView: View {
    @ObservedObject var state: AppState
    var run: (_ prompt: String, _ root: String) -> Void
    @ObservedObject private var model = ActivityModel()

    var body: some View {
        Form {
            Section("Local jobs") {
                if model.jobs.isEmpty { Text("No local jobs yet. Ask for a new file or feature and choose “Try locally on a branch”.").foregroundStyle(.secondary) }
                ForEach(model.jobs) { j in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(j.id).font(.system(.body, design: .monospaced))
                            Text(j.status).font(.caption).padding(.horizontal, 6).padding(.vertical, 2)
                                .background(color(j.status).opacity(0.18), in: Capsule())
                            Spacer()
                            Text(j.createdAt.prefix(16).replacingOccurrences(of: "T", with: " ")).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(j.request).lineLimit(2).font(.callout)
                        Text("\(URL(fileURLWithPath: j.root).lastPathComponent) · branch \(j.branch)").font(.caption).foregroundStyle(.secondary)
                        HStack {
                            if j.status == "planned" || j.status == "blocked" { Button("Continue") { run("job \(j.id) continue", j.root) } }
                            if j.status == "done" { Button("Apply to project") { run("job \(j.id) apply", j.root) } }
                            if j.status != "applied" && j.status != "discarded" {
                                if state.codexAvailable { Button("Review with Codex") { run("job \(j.id) review", j.root) } }
                                Button("Discard", role: .destructive) { run("job \(j.id) discard", j.root) }
                            }
                        }
                        .controlSize(.small)
                    }
                    .padding(.vertical, 2)
                }
            }
            Section("Background sessions") {
                if model.sessions.isEmpty { Text("None running.").foregroundStyle(.secondary) }
                ForEach(model.sessions, id: \.self) { s in
                    HStack {
                        Text(s).font(.system(.body, design: .monospaced))
                        Spacer()
                        Text("tmux -L onbud attach -t \(s)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                Text("Ask “show the log” or “stop the session” in the panel to manage them.").font(.callout).foregroundStyle(.secondary)
            }
            Button("Refresh") { model.refresh() }
        }
        .formStyle(.grouped)
        .frame(width: 600)
        .frame(minHeight: 480)
        .onAppear { model.refresh() }
    }

    private func color(_ status: String) -> Color {
        switch status { case "done", "applied": return .green; case "blocked": return .orange; case "discarded": return .secondary; default: return .blue }
    }
}

@MainActor
final class ActivityModel: ObservableObject {
    @Published var jobs: [JobSummary] = []
    @Published var sessions: [String] = []
    func refresh() {
        jobs = Activity.jobs()
        sessions = Activity.sessions()
    }
}
