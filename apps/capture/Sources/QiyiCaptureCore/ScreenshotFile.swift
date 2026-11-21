import Foundation

enum ScreenshotFile {
    static func name(appName: String, date: Date = Date(), id: UUID = UUID()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss-SSS"

        let safeName = String(appName.unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.contains(scalar) || scalar == "-" || scalar == "_"
                ? Character(String(scalar)) : "_"
        }.prefix(40))
        let label = safeName.isEmpty ? "Window" : safeName
        return "\(formatter.string(from: date))_\(label)_\(id.uuidString).png"
    }
}
