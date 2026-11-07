// Calendar and Reminders, read-only, for the personal skill (EventKit, on-device). macOS asks once for access.
// Output is JSON on stdout for the caller to show to the user; it is never stored or sent anywhere.
//   pim events <days>      → events from now to <days> days ahead
//   pim reminders          → incomplete reminders
import Foundation
import EventKit

@main struct PIM {
  static func out(_ v: Any) { let d = try! JSONSerialization.data(withJSONObject: v, options: [.sortedKeys]); print(String(data: d, encoding: .utf8)!) }
  static func main() async {
    let a = CommandLine.arguments
    let store = EKEventStore()
    let iso = ISO8601DateFormatter()
    do {
      switch a.count > 1 ? a[1] : "" {
      case "events":
        guard try await store.requestFullAccessToEvents() else { out(["error": "calendar access denied"]); exit(2) }
        let days = Double(a.count > 2 ? a[2] : "1") ?? 1
        let pred = store.predicateForEvents(withStart: Date(), end: Date().addingTimeInterval(days * 86400), calendars: nil)
        out(store.events(matching: pred).prefix(50).map { ["title": $0.title ?? "", "start": iso.string(from: $0.startDate), "end": iso.string(from: $0.endDate),
          "allDay": $0.isAllDay, "calendar": $0.calendar.title, "location": $0.location ?? ""] as [String: Any] })
      case "reminders":
        guard try await store.requestFullAccessToReminders() else { out(["error": "reminders access denied"]); exit(2) }
        let pred = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        let items: [EKReminder] = await withCheckedContinuation { c in store.fetchReminders(matching: pred) { c.resume(returning: $0 ?? []) } }
        out(items.prefix(50).map { ["title": $0.title ?? "", "due": $0.dueDateComponents?.date.map { iso.string(from: $0) } ?? "", "list": $0.calendar.title] as [String: Any] })
      default:
        out(["error": "usage: pim events <days> | pim reminders"]); exit(1)
      }
    } catch { out(["error": error.localizedDescription]); exit(2) }
  }
}
