// OnBud chat widget (medium, desktop or Notification Center): the last question and answer as chat bubbles
// and an "Ask OnBud" box that opens the launcher panel (onbud://ask). Widgets cannot take typing, so the box
// is a link. Content comes from the snapshot the app writes (Sources/SpotlightCore/WidgetSnapshot.swift,
// compiled into this extension); the app reloads the widget after every answer.
// Built by `make app` with swiftc into OnBud.app/Contents/PlugIns/OnBudWidget.appex (sandboxed).
import AppKit
import SwiftUI
import WidgetKit

struct ChatEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct ChatProvider: TimelineProvider {
    func placeholder(in context: Context) -> ChatEntry {
        ChatEntry(date: Date(), snapshot: WidgetSnapshot(question: "What changed in this folder today?",
                                                          answer: "Three files changed: the report draft, its figures and the bibliography.", folder: "Desktop"))
    }
    func getSnapshot(in context: Context, completion: @escaping (ChatEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : ChatEntry(date: Date(), snapshot: WidgetSnapshot.load()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ChatEntry>) -> Void) {
        // The app asks WidgetKit to reload after each answer; nothing to refresh on a schedule.
        completion(Timeline(entries: [ChatEntry(date: Date(), snapshot: WidgetSnapshot.load())], policy: .never))
    }
}

struct ChatWidgetView: View {
    let entry: ChatEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if let s = entry.snapshot, !s.question.isEmpty {
                bubble(s.question, mine: true, lines: 1)
                if s.running && s.answer.isEmpty { bubble("Working on it…", mine: false, lines: 1).opacity(0.7) }
                else { bubble(s.answer.isEmpty ? "No answer" : s.answer, mine: false, lines: 3) }
            } else {
                Text("Ask about files in a folder, a document, your code or the web — answered on this Mac.")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
            Spacer(minLength: 0)
            Link(destination: URL(string: "onbud://ask")!) {
                HStack(spacing: 6) {
                    Image(systemName: "text.cursor")
                    Text("Ask OnBud").lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "return")
                }
                .font(.caption).foregroundStyle(.secondary)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(.quaternary.opacity(0.7), in: Capsule())
            }
        }
        .widgetURL(URL(string: "onbud://open")!)
    }

    private var header: some View {
        HStack(spacing: 6) {
            if let url = Bundle.main.url(forResource: "PanelIcon", withExtension: "png"), let img = NSImage(contentsOf: url) {
                Image(nsImage: img).resizable().frame(width: 16, height: 16)
            }
            Text("OnBud").font(.caption.weight(.semibold))
            if let f = entry.snapshot?.folder { Text("· " + f).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            Spacer(minLength: 0)
            if let d = entry.snapshot?.date, entry.snapshot?.question.isEmpty == false {
                Text(d, style: .relative).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
    }

    private func bubble(_ text: String, mine: Bool, lines: Int) -> some View {
        HStack {
            if mine { Spacer(minLength: 40) }
            Text(text)
                .font(.caption)
                .lineLimit(lines)
                .foregroundStyle(mine ? Color.white : Color.primary)
                .padding(.horizontal, 9).padding(.vertical, 5)
                .background(mine ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.quaternary.opacity(0.6)),
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            if !mine { Spacer(minLength: 24) }
        }
    }
}

struct ChatWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetSnapshot.kind, provider: ChatProvider()) { entry in
            ChatWidgetView(entry: entry).containerBackground(.background, for: .widget)
        }
        .configurationDisplayName("OnBud Chat")
        .description("Your last question and answer, and a box that opens OnBud.")
        .supportedFamilies([.systemMedium])
    }
}

@main
struct OnBudWidgets: WidgetBundle {
    var body: some Widget { ChatWidget() }
}
