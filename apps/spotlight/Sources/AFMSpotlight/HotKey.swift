// Global hotkey through Carbon's RegisterEventHotKey: works without the Accessibility permission
// (unlike an event tap), and only for the one key combination we register.
import Carbon.HIToolbox
import Foundation

enum HotKeyChoice: String, CaseIterable, Identifiable {
    case optionSpace, controlSpace, commandSpace
    var id: String { rawValue }
    var label: String {
        switch self {
        case .optionSpace: return "⌥ Space"
        case .controlSpace: return "⌃ Space"
        case .commandSpace: return "⌘ Space (replaces Spotlight)"
        }
    }
    var modifiers: UInt32 {
        switch self {
        case .optionSpace: return UInt32(optionKey)
        case .controlSpace: return UInt32(controlKey)
        case .commandSpace: return UInt32(cmdKey)
        }
    }
}

final class HotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void
    private static var current: HotKey?

    init(action: @escaping () -> Void) { self.action = action }

    /** Registers the combination; returns the OSStatus (noErr on success, eventHotKeyExistsErr if another app has it). */
    @discardableResult
    func register(_ choice: HotKeyChoice) -> OSStatus {
        unregister()
        HotKey.current = self
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { HotKey.current?.action() }
            return noErr
        }, 1, &spec, nil, &handler)
        let id = EventHotKeyID(signature: OSType(0x4146_4D53 /* 'AFMS' */), id: 1)
        return RegisterEventHotKey(UInt32(kVK_Space), choice.modifiers, id, GetApplicationEventTarget(), 0, &ref)
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
        ref = nil; handler = nil
    }
}
