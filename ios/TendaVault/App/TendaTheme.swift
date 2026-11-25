import SwiftUI

// MARK: - Aurora Midnight Design Tokens

enum Aurora {
    static let canvas = Color(red: 0.039, green: 0.035, blue: 0.094)       // #0A0918
    static let surface1 = Color(red: 0.071, green: 0.063, blue: 0.157)     // #121028
    static let surface2 = Color(red: 0.102, green: 0.090, blue: 0.212)     // #1A1736
    static let surface3 = Color(red: 0.137, green: 0.122, blue: 0.275)     // #231F46

    static let coral = Color(red: 1.000, green: 0.420, blue: 0.290)        // #FF6B4A
    static let violet = Color(red: 0.545, green: 0.361, blue: 0.965)       // #8B5CF6
    static let mint = Color(red: 0.176, green: 0.831, blue: 0.749)         // #2DD4BF
    static let amber = Color(red: 0.984, green: 0.749, blue: 0.141)        // #FBBF24
    static let ice = Color(red: 0.376, green: 0.647, blue: 0.980)          // #60A5FA

    static let ink = Color(red: 0.969, green: 0.973, blue: 0.988)
    static let inkSecondary = Color(red: 0.706, green: 0.737, blue: 0.835)
    static let inkMuted = Color(red: 0.490, green: 0.525, blue: 0.645)

    static let border = Color.white.opacity(0.08)
    static let borderStrong = Color.white.opacity(0.16)

    static let brandGradient = LinearGradient(
        colors: [coral, violet],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let mintVioletGradient = LinearGradient(
        colors: [mint, violet],
        startPoint: .leading,
        endPoint: .trailing
    )
}

// MARK: - Ambient Aurora Backdrop

struct AuroraBackdrop: View {
    var body: some View {
        ZStack {
            Aurora.canvas
            RadialGradient(
                colors: [Aurora.violet.opacity(0.18), .clear],
                center: .topTrailing,
                startRadius: 20,
                endRadius: 340
            )
            RadialGradient(
                colors: [Aurora.coral.opacity(0.13), .clear],
                center: .topLeading,
                startRadius: 10,
                endRadius: 280
            )
            RadialGradient(
                colors: [Aurora.mint.opacity(0.09), .clear],
                center: .bottom,
                startRadius: 10,
                endRadius: 360
            )
        }
        .ignoresSafeArea()
    }
}

// MARK: - Surface Card

struct AuroraCard<Content: View>: View {
    var accent: Color? = nil
    var padding: CGFloat = 16
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content()
        }
        .padding(padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Aurora.surface1)
                .overlay {
                    if let accent {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [accent.opacity(0.10), .clear],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                    }
                }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(accent?.opacity(0.28) ?? Aurora.border, lineWidth: 1)
        }
    }
}

// MARK: - Status Pill

struct StatusPill: View {
    let text: String
    var icon: String? = nil
    var tint: Color = Aurora.mint
    var forceLTR: Bool = false

    var body: some View {
        HStack(spacing: 5) {
            if let icon {
                Image(systemName: icon)
                    .font(.caption2.weight(.semibold))
            }
            Text(text)
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(tint.opacity(0.13), in: Capsule())
        .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 1))
        .environment(\.layoutDirection, forceLTR ? .leftToRight : .rightToLeft)
    }
}

// MARK: - Section Title

struct AuroraSectionHeader: View {
    let title: String
    var subtitle: String? = nil
    var icon: String? = nil
    var tint: Color = Aurora.mint

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if let icon {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(tint)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(Aurora.ink)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(Aurora.inkMuted)
                }
            }
            Spacer(minLength: 4)
        }
    }
}

// MARK: - Quota Circular Ring

struct QuotaRingView: View {
    let progress: Double // 0...1
    let label: String
    let sublabel: String
    var warning: Bool = false

    private var clamped: Double { max(0, min(1, progress)) }

    var body: some View {
        ZStack {
            Circle()
                .stroke(Aurora.surface3, lineWidth: 11)
            Circle()
                .trim(from: 0, to: clamped)
                .stroke(
                    warning
                        ? LinearGradient(colors: [Aurora.coral, Aurora.amber], startPoint: .topLeading, endPoint: .bottomTrailing)
                        : LinearGradient(colors: [Aurora.mint, Aurora.violet], startPoint: .topLeading, endPoint: .bottomTrailing),
                    style: StrokeStyle(lineWidth: 11, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.45), value: clamped)

            VStack(spacing: 2) {
                Text(label)
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                    .foregroundStyle(Aurora.ink)
                Text(sublabel)
                    .font(.caption2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .foregroundStyle(Aurora.inkMuted)
            }
            .padding(.horizontal, 12)
        }
        .frame(width: 98, height: 98)
    }
}

// MARK: - Formatting Utilities (POSIX digits + Arabic labels)

enum F {
    private static let posix = Locale(identifier: "en_US_POSIX")

    static func num(_ value: Double, digits: Int = 1) -> String {
        String(format: "%.\(digits)f", locale: posix, value)
    }

    static func mbps(_ bytesPerSec: Double) -> String {
        let mbpsVal = max(0, bytesPerSec * 8.0 / 1_000_000.0)
        if mbpsVal >= 100 { return "\(num(mbpsVal, digits: 0)) Mbps" }
        if mbpsVal >= 10 { return "\(num(mbpsVal, digits: 1)) Mbps" }
        if mbpsVal >= 0.1 { return "\(num(mbpsVal, digits: 2)) Mbps" }
        let kbps = max(0, bytesPerSec * 8.0 / 1_000.0)
        return "\(num(kbps, digits: 0)) Kbps"
    }

    static func mbpsValue(_ bytesPerSec: Double) -> Double {
        max(0, bytesPerSec * 8.0 / 1_000_000.0)
    }

    static func bytes(_ raw: Double) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var value = max(0, raw)
        var idx = 0
        while value >= 1024 && idx < units.count - 1 {
            value /= 1024
            idx += 1
        }
        if idx == 0 { return "\(Int(value)) B" }
        return "\(num(value, digits: value >= 100 ? 0 : 1)) \(units[idx])"
    }

    static func gb(_ rawBytes: Double) -> Double {
        max(0, rawBytes / 1_073_741_824.0)
    }

    static func speedLimitKbs(_ kbs: Int) -> String {
        if kbs <= 0 { return "مفتوح" }
        if kbs == 1 { return "محظور" }
        let mbps = Double(kbs) / 128.0
        if mbps >= 1 {
            let rounded = mbps.rounded()
            if abs(mbps - rounded) < 0.05 {
                return "\(Int(rounded)) Mbps"
            }
            return "\(num(mbps, digits: 1)) Mbps"
        }
        return "\(kbs) KB/s"
    }

    static func uptime(_ seconds: Int) -> String {
        guard seconds > 0 else { return "—" }
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3600
        let mins = (seconds % 3600) / 60
        if days > 0 { return "\(days)ي \(hours)س" }
        if hours > 0 { return "\(hours)س \(mins)د" }
        return "\(mins)د"
    }

    static func duration(_ seconds: Int?) -> String {
        guard let seconds, seconds > 0 else { return "مستمر" }
        if seconds < 60 { return "\(seconds) ث" }
        let mins = seconds / 60
        if mins < 60 { return "\(mins) د" }
        let hrs = mins / 60
        let remMins = mins % 60
        return remMins > 0 ? "\(hrs) س \(remMins) د" : "\(hrs) س"
    }

    static func timestamp(_ ms: Double?) -> String {
        guard let ms, ms > 0 else { return "—" }
        let date = Date(timeIntervalSince1970: ms / 1000.0)
        let fmt = DateFormatter()
        fmt.locale = posix
        fmt.dateFormat = "dd/MM HH:mm"
        return fmt.string(from: date)
    }

    static func shortDay(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000.0)
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "ar_EG")
        fmt.dateFormat = "EEE d"
        return fmt.string(from: date)
    }

    static func deviceIcon(category: String?, label: String) -> String {
        let cat = (category ?? "").lowercased()
        let name = label.lowercased()
        if cat.contains("phone") || name.contains("iphone") || name.contains("galaxy") { return "iphone" }
        if cat.contains("tablet") || name.contains("ipad") { return "ipad" }
        if cat.contains("tv") || name.contains("apple tv") || name.contains("smart tv") { return "appletv.fill" }
        if cat.contains("game") || cat.contains("console") || name.contains("playstation") || name.contains("xbox") { return "gamecontroller.fill" }
        if cat.contains("computer") || cat.contains("laptop") || name.contains("mac") || name.contains("pc") { return "desktopcomputer" }
        if cat.contains("camera") || name.contains("cam") { return "video.fill" }
        if cat.contains("iot") || cat.contains("smart") || name.contains("homepod") { return "homepodmini.fill" }
        if cat.contains("router") || cat.contains("access_point") { return "wifi.router.fill" }
        return "network"
    }
}
