import SwiftUI

enum Ink {
    static let canvas = Color(red: 0.04, green: 0.06, blue: 0.09)
    static let card = Color(red: 0.09, green: 0.12, blue: 0.16)
    static let line = Color.white.opacity(0.08)
    static let mint = Color(red: 0.29, green: 0.86, blue: 0.62)
    static let coral = Color(red: 1.0, green: 0.38, blue: 0.42)
    static let amber = Color(red: 1.0, green: 0.72, blue: 0.34)
    static let mist = Color.white.opacity(0.62)
}

enum L {
    static func n(_ value: Double, digits: Int = 0) -> String {
        String(format: "%.\(digits)f", locale: Locale(identifier: "en_US_POSIX"), value)
    }

    static func int(_ value: Int) -> String { String(value) }

    static func bytes(_ value: Double) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var v = max(0, value)
        var i = 0
        while v >= 1024 && i < units.count - 1 {
            v /= 1024
            i += 1
        }
        if i == 0 { return "\(Int(v)) \(units[i])" }
        return "\(n(v, digits: 1)) \(units[i])"
    }

    static func speed(_ bps: Double) -> String {
        if bps >= 1_000_000 { return "\(n(bps / 1_000_000, digits: 1)) Mbps" }
        return "\(n(bps / 1000, digits: 0)) Kbps"
    }

    static func when(_ ms: Double) -> String {
        guard ms > 0 else { return "—" }
        let date = Date(timeIntervalSince1970: ms / 1000)
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "dd/MM HH:mm"
        return fmt.string(from: date)
    }
}

struct VaultCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Ink.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Ink.line))
    }
}

struct MetricTile: View {
    let title: String
    let value: String
    let tint: Color
    var body: some View {
        VaultCard {
            Text(title)
                .font(.footnote)
                .foregroundStyle(Ink.mist)
            Text(value)
                .font(.title3.weight(.semibold))
                .foregroundStyle(tint)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
        }
    }
}

struct LiveDot: View {
    let on: Bool
    var body: some View {
        Circle()
            .fill(on ? Ink.mint : Ink.coral)
            .frame(width: 8, height: 8)
    }
}
