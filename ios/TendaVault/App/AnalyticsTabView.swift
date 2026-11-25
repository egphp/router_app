import Charts
import SwiftUI

enum AnalyticsSection: Int, CaseIterable {
    case consumption = 0
    case map = 1
    case outages = 2
    case report = 3

    var title: String {
        switch self {
        case .consumption: return "الاستهلاك"
        case .map: return "الخريطة"
        case .outages: return "الانقطاعات"
        case .report: return "التقرير"
        }
    }
}

/// Tab 4 `التحليلات` — Consumption, Network Map, Outages & Reports:
/// - `الاستهلاك`: Swift Charts 7-day & 30-day bar chart + per-device consumption share
/// - `خريطة الشبكة`: interactive native topology grouped by band / LAN / blocked
/// - `الانقطاعات`: uptime percentage + outages timeline
/// - `التقرير`: daily/weekly summary + native ShareLink export
struct AnalyticsTabView: View {
    @EnvironmentObject private var store: TendaStore
    @State private var section: AnalyticsSection = .consumption
    @State private var consumptionWindow: Int = 7
    @State private var reportDays: Int = 7
    @State private var selectedDevice: TendaDevice? = nil

    var body: some View {
        NavigationStack {
            ZStack {
                AuroraBackdrop()

                VStack(spacing: 0) {
                    Picker("قسم التحليلات", selection: $section) {
                        ForEach(AnalyticsSection.allCases, id: \.self) { sec in
                            Text(sec.title).tag(sec)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)

                    ScrollView {
                        VStack(spacing: 16) {
                            switch section {
                            case .consumption:
                                consumptionView
                            case .map:
                                networkMapView
                            case .outages:
                                outagesView
                            case .report:
                                reportView
                            }
                        }
                        .padding(16)
                    }
                    .refreshable {
                        await store.refreshAnalytics(reportDays: reportDays)
                    }
                }
            }
            .navigationTitle("التحليلات")
            .toolbarColorScheme(.dark, for: .navigationBar)
            .sheet(item: $selectedDevice) { device in
                DeviceDetailSheet(device: device)
                    .environmentObject(store)
            }
            .task {
                if store.consumption == nil {
                    await store.refreshAnalytics(reportDays: reportDays)
                }
            }
        }
    }

    // MARK: - 1. Consumption (7d / 30d Swift Charts + Per-Device Share)

    @ViewBuilder
    private var consumptionView: some View {
        if let cons = store.consumption {
            let points = consumptionWindow == 7 ? cons.daily7d : cons.daily30d
            let periodTotal = points.reduce(0.0) { $0 + $1.totalBytes }

            AuroraCard(accent: Aurora.violet) {
                HStack {
                    AuroraSectionHeader(
                        title: "الاستهلاك اليومي",
                        subtitle: "الإجمالي: \(F.bytes(periodTotal))",
                        icon: "chart.bar.xaxis",
                        tint: Aurora.violet
                    )
                    Picker("المدة", selection: $consumptionWindow) {
                        Text("7 أيام").tag(7)
                        Text("30 يوم").tag(30)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 144)
                }

                if points.isEmpty {
                    Text("لا توجد بيانات استهلاك متاحة لهذه الفترة.")
                        .font(.caption)
                        .foregroundStyle(Aurora.inkMuted)
                        .frame(maxWidth: .infinity, minHeight: 140)
                } else {
                    Chart(points) { pt in
                        BarMark(
                            x: .value("اليوم", pt.date, unit: .day),
                            y: .value("التحميل", F.gb(pt.bytesDown))
                        )
                        .foregroundStyle(Aurora.mint.gradient)
                        .cornerRadius(4)

                        BarMark(
                            x: .value("اليوم", pt.date, unit: .day),
                            y: .value("الرفع", F.gb(pt.bytesUp))
                        )
                        .foregroundStyle(Aurora.coral.opacity(0.85))
                        .cornerRadius(4)
                    }
                    .frame(height: 185)
                    .environment(\.layoutDirection, .leftToRight)
                    .chartXAxis {
                        AxisMarks(values: .automatic(desiredCount: consumptionWindow == 7 ? 7 : 5)) {
                            AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                                .font(.caption2)
                                .foregroundStyle(Aurora.inkMuted)
                        }
                    }
                    .chartYAxis {
                        AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { v in
                            AxisGridLine().foregroundStyle(Aurora.border)
                            AxisValueLabel {
                                if let gb = v.as(Double.self) {
                                    Text("\(F.num(gb, digits: 0)) GB")
                                        .font(.caption2)
                                        .monospacedDigit()
                                        .foregroundStyle(Aurora.inkMuted)
                                }
                            }
                        }
                    }
                }

                HStack(spacing: 14) {
                    legendDot(color: Aurora.mint, text: "تحميل (Download)")
                    legendDot(color: Aurora.coral, text: "رفع (Upload)")
                }
            }

            AuroraCard {
                AuroraSectionHeader(
                    title: "حصة كل جهاز من الاستهلاك",
                    subtitle: "مرتّبة حسب استهلاك الشهر الحالي",
                    icon: "list.number",
                    tint: Aurora.mint
                )

                let totalMonth = max(cons.devices.reduce(0.0) { $0 + $1.monthDown + $1.monthUp }, 1)
                ForEach(cons.devices.prefix(12)) { row in
                    let devMonth = row.monthDown + row.monthUp
                    let pct = min(1.0, devMonth / totalMonth)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(row.label)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Aurora.ink)
                                .lineLimit(1)
                            Spacer()
                            Text("\(F.bytes(devMonth)) (\(Int((pct * 100).rounded()))%)")
                                .font(.caption.weight(.bold))
                                .monospacedDigit()
                                .foregroundStyle(Aurora.mint)
                                .environment(\.layoutDirection, .leftToRight)
                        }
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Aurora.surface3)
                                Capsule()
                                    .fill(Aurora.mintVioletGradient)
                                    .frame(width: max(6, geo.size.width * CGFloat(pct)))
                            }
                        }
                        .frame(height: 6)
                        HStack {
                            Text("اليوم: \(F.bytes(row.todayDown + row.todayUp))")
                            Spacer()
                            Text("الأسبوع: \(F.bytes(row.weekDown + row.weekUp))")
                        }
                        .font(.caption2)
                        .foregroundStyle(Aurora.inkMuted)
                    }
                    .padding(10)
                    .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        } else {
            ProgressView().tint(Aurora.mint).padding(.top, 60)
        }
    }

    // MARK: - 2. Network Topology Map

    @ViewBuilder
    private var networkMapView: some View {
        if let map = store.networkMap {
            // Core Router Node
            AuroraCard(accent: Aurora.mint) {
                HStack(spacing: 14) {
                    ZStack {
                        Circle()
                            .fill(Aurora.brandGradient)
                            .frame(width: 54, height: 54)
                        Image(systemName: "wifi.router.fill")
                            .font(.title2)
                            .foregroundStyle(.white)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text("بوابة تندا W30E")
                                .font(.headline.weight(.bold))
                                .foregroundStyle(Aurora.ink)
                            StatusPill(
                                text: map.router.connected ? "نشط" : "غير متصل",
                                tint: map.router.connected ? Aurora.mint : Aurora.coral
                            )
                        }
                        Text("\(map.router.host) · تشغيل \(F.uptime(map.router.uptimeSec))")
                            .font(.caption.monospaced())
                            .foregroundStyle(Aurora.inkSecondary)
                            .environment(\.layoutDirection, .leftToRight)
                    }
                    Spacer()
                }

                if !map.router.wanPorts.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(map.router.wanPorts) { wan in
                            StatusPill(
                                text: "\(wan.wanName): \(wan.publicIp ?? wan.wanIp ?? wan.status)",
                                icon: "globe",
                                tint: wan.isConnected ? Aurora.mint : Aurora.coral,
                                forceLTR: true
                            )
                        }
                    }
                }
            }

            topologyGroupCard(title: "سلكي LAN", icon: "cable.connector", tint: Aurora.ice, devices: map.groups.wired)
            topologyGroupCard(title: "واي فاي 5GHz", icon: "wifi", tint: Aurora.violet, devices: map.groups.wifi5g)
            topologyGroupCard(title: "واي فاي 2.4GHz", icon: "wifi", tint: Aurora.mint, devices: map.groups.wifi24g)
            if !map.groups.blocked.isEmpty {
                topologyGroupCard(title: "الأجهزة المحظورة", icon: "hand.raised.fill", tint: Aurora.coral, devices: map.groups.blocked)
            }
            if !map.groups.offline.isEmpty {
                topologyGroupCard(title: "غير متصل حالياً", icon: "moon.zzz.fill", tint: Aurora.inkMuted, devices: map.groups.offline)
            }
        } else {
            ProgressView().tint(Aurora.mint).padding(.top, 60)
        }
    }

    private func topologyGroupCard(title: String, icon: String, tint: Color, devices: [TendaDevice]) -> some View {
        AuroraCard(accent: tint) {
            HStack {
                AuroraSectionHeader(title: title, icon: icon, tint: tint)
                StatusPill(text: "\(devices.count) جهاز", tint: tint)
            }

            if devices.isEmpty {
                Text("لا توجد أجهزة في هذه المجموعة حالياً.")
                    .font(.caption)
                    .foregroundStyle(Aurora.inkMuted)
            } else {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                    ForEach(devices) { dev in
                        Button {
                            selectedDevice = dev
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Image(systemName: F.deviceIcon(category: dev.category, label: dev.label))
                                        .foregroundStyle(tint)
                                    Spacer()
                                    if let rssi = dev.wifiRssiDbm {
                                        Text("\(Int(rssi)) dBm")
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(Aurora.inkMuted)
                                            .environment(\.layoutDirection, .leftToRight)
                                    }
                                }
                                Text(dev.label)
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(Aurora.ink)
                                    .lineLimit(1)
                                Text(dev.ip ?? dev.mac)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(Aurora.inkMuted)
                                    .lineLimit(1)
                                    .environment(\.layoutDirection, .leftToRight)
                                Text("↓ \(F.mbps(dev.downSpeedBps))")
                                    .font(.caption2.weight(.semibold))
                                    .monospacedDigit()
                                    .foregroundStyle(dev.downSpeedBps > 0 ? Aurora.mint : Aurora.inkMuted)
                                    .environment(\.layoutDirection, .leftToRight)
                            }
                            .padding(11)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .strokeBorder(tint.opacity(0.22), lineWidth: 1)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: - 3. Outages & Uptime

    @ViewBuilder
    private var outagesView: some View {
        if let out = store.outages {
            AuroraCard(accent: out.uptimePct30d >= 99.0 ? Aurora.mint : Aurora.amber) {
                AuroraSectionHeader(title: "استقرار الاتصال (Uptime)", icon: "waveform.path.ecg", tint: Aurora.mint)

                HStack(spacing: 12) {
                    QuotaRingView(
                        progress: out.uptimePct30d / 100.0,
                        label: "\(F.num(out.uptimePct30d, digits: 2))%",
                        sublabel: "آخر 30 يوم",
                        warning: out.uptimePct30d < 98.5
                    )

                    VStack(alignment: .leading, spacing: 8) {
                        statLine(label: "استقرار 7 أيام", value: "\(F.num(out.uptimePct7d, digits: 2))%", tint: Aurora.mint)
                        statLine(label: "انقطاعات اليوم", value: "\(out.outagesToday)", tint: out.outagesToday == 0 ? Aurora.mint : Aurora.coral)
                        statLine(label: "زمن التشغيل الحالي", value: F.uptime(out.currentUptimeSec), tint: Aurora.violet)
                        statLine(label: "إجمالي التوقف (30 يوم)", value: F.duration(out.totalDowntimeSec30d), tint: Aurora.amber)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            AuroraCard {
                AuroraSectionHeader(title: "الجدول الزمني للانقطاعات", icon: "clock.badge.exclamationmark", tint: Aurora.coral)

                if out.outages.isEmpty {
                    HStack(spacing: 10) {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(Aurora.mint)
                        Text("لا توجد انقطاعات مسجّلة — خط الإنترنت مستقر بالكامل.")
                            .font(.caption)
                            .foregroundStyle(Aurora.inkSecondary)
                    }
                } else {
                    ForEach(out.outages.prefix(30)) { item in
                        HStack(alignment: .top, spacing: 12) {
                            VStack {
                                Circle()
                                    .fill(item.endedAt == nil ? Aurora.coral : Aurora.amber)
                                    .frame(width: 10, height: 10)
                                Rectangle()
                                    .fill(Aurora.border)
                                    .frame(width: 2)
                            }
                            .frame(width: 12)

                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(Self.arabicOutageReason(item.reason))
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(Aurora.ink)
                                    Spacer()
                                    StatusPill(
                                        text: F.duration(item.durationSec),
                                        tint: item.endedAt == nil ? Aurora.coral : Aurora.amber
                                    )
                                }
                                Text("بدأ: \(F.timestamp(item.startedAt))")
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(Aurora.inkMuted)
                                    .environment(\.layoutDirection, .leftToRight)
                                if let notes = item.notes, !notes.isEmpty {
                                    Text(notes)
                                        .font(.caption)
                                        .foregroundStyle(Aurora.inkSecondary)
                                }
                            }
                        }
                        .padding(10)
                        .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
            }
        } else {
            ProgressView().tint(Aurora.mint).padding(.top, 60)
        }
    }

    // MARK: - 4. Report + Share Export

    @ViewBuilder
    private var reportView: some View {
        if let rep = store.report {
            AuroraCard(accent: Aurora.violet) {
                HStack {
                    AuroraSectionHeader(
                        title: "ملخص التقرير",
                        subtitle: "آخر \(rep.days) أيام",
                        icon: "doc.text.fill",
                        tint: Aurora.violet
                    )
                    Picker("فترة التقرير", selection: $reportDays) {
                        Text("7 أيام").tag(7)
                        Text("14 يوم").tag(14)
                        Text("30 يوم").tag(30)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 170)
                    .onChange(of: reportDays) { _, newDays in
                        Task { await store.refreshReport(days: newDays) }
                    }
                }

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                    reportBox(title: "إجمالي الاستهلاك", value: F.bytes(rep.summary.totalBytes), tint: Aurora.mint)
                    reportBox(title: "المتوسط اليومي", value: F.bytes(rep.summary.avgDailyBytes), tint: Aurora.violet)
                    reportBox(title: "التحميل / الرفع", value: "\(F.bytes(rep.summary.totalDown)) / \(F.bytes(rep.summary.totalUp))", tint: Aurora.ice)
                    reportBox(title: "الانقطاعات / الهجمات", value: "\(rep.summary.outagesCount) · \(rep.summary.attacksCount)", tint: Aurora.coral)
                }

                ShareLink(item: rep.shareTextAr) {
                    Label("مشاركة وتصدير التقرير", systemImage: "square.and.arrow.up")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(Aurora.brandGradient, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }

            AuroraCard {
                AuroraSectionHeader(title: "أعلى الأجهزة في الفترة", icon: "crown.fill", tint: Aurora.amber)
                ForEach(rep.topDevices) { dev in
                    HStack {
                        Text(dev.label)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Aurora.ink)
                        Spacer()
                        Text(F.bytes(dev.totalBytes))
                            .font(.subheadline.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(Aurora.mint)
                            .environment(\.layoutDirection, .leftToRight)
                    }
                    .padding(10)
                    .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        } else {
            ProgressView().tint(Aurora.mint).padding(.top, 60)
        }
    }

    private func legendDot(color: Color, text: String) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(text).font(.caption2).foregroundStyle(Aurora.inkSecondary)
        }
    }

    private func statLine(label: String, value: String, tint: Color) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(Aurora.inkMuted)
            Spacer()
            Text(value).font(.caption.weight(.bold)).monospacedDigit().foregroundStyle(tint)
        }
    }

    private static func arabicOutageReason(_ raw: String) -> String {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "wan_drop", "wan_down": return "هبوط خط الإنترنت (WAN)"
        case "reboot", "router_reboot": return "إعادة تشغيل الراوتر"
        case "unreachable", "router_unreachable", "timeout": return "تعذّر الوصول للراوتر"
        case "auth_failed", "login_failed": return "فشل مصادقة الراوتر"
        case "unknown", "": return "انقطاع مؤقت"
        default: return raw
        }
    }

    private func reportBox(title: String, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption2).foregroundStyle(Aurora.inkMuted)
            Text(value)
                .font(.subheadline.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
