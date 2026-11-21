import Carbon
import Foundation

public final class MacOSGlobalHotKey {
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void

    public init(action: @escaping () -> Void) throws {
        self.action = action
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)
        )
        let status = InstallEventHandler(
            GetApplicationEventTarget(), { _, _, context in
                guard let context else { return OSStatus(eventNotHandledErr) }
                Unmanaged<MacOSGlobalHotKey>.fromOpaque(context).takeUnretainedValue().action()
                return noErr
            }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &handler
        )
        guard status == noErr else { throw HotKeyError(status: status) }

        let registration = RegisterEventHotKey(
            UInt32(kVK_ANSI_S), UInt32(controlKey | optionKey),
            EventHotKeyID(signature: 0x57534E50, id: 1), GetApplicationEventTarget(),
            OptionBits(kEventHotKeyExclusive), &hotKey
        )
        guard registration == noErr else {
            if let handler { RemoveEventHandler(handler) }
            handler = nil
            throw HotKeyError(status: registration)
        }
    }

    deinit {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let handler { RemoveEventHandler(handler) }
    }
}

private struct HotKeyError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? {
        "无法注册快捷键 ⌃⌥S（系统错误 \(status)）。请退出重复运行的 Qiyi，或检查其他应用是否占用了这个快捷键。"
    }
}
