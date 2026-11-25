import Charts
import SwiftUI

/// Tab 1 `الرئيسية` — Live Command Center:
/// - Live WAN Health & Dual Throughput Hero card (`↓ Mbps` / `↑ Mbps`, active devices, today's outages)
///   with live Swift Charts AreaMark + LineMark sparkline graph
/// - Monthly Quota & AI Forecast card (circular progress ring + projected days remaining + daily average)
/// - Top Bandwidth Hogs quick cards (tap -> DeviceDetailSheet)
/// - Recent Security Alert / Threat banner (tap -> Security tab)
struct HomeTabView: View {
    @EnvironmentObject private var store: TendaStore
    @State private var selectedDevice: TendaDevice? = nil

    var body: some View {
        NavigationStack {
            ZStack {
                AuroraBackdrop()

                ScrollView {
                    VStack(spacing: 16) {
                        if let boot = store.bootstrap {
                            wanHealthBar(boot)
                            throughputHeroCard(boot)
                            if let topAlert = boot.recentAlerts.first {
                                securityBanner(alert: topAlert, attackCount: boot.counts.activeAttacks24h)
                            } else if boot.counts.activeAttacks24h > 0 {
                                attacksOnlyBanner(count: boot.counts.activeAttacks24h)
                            }
                            quotaForecastCard(boot.quota)
                            topHogsSection(boot.topHogs)
                        } else if store.isLoadingHome {
                            loadingState
                        } else {
                            emptyState
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .refreshable {
                    await store.refreshHome()
                }
            }
            .navigationTitle("الرئيسية")
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await store.refreshHome() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .foregroundStyle(Aurora.mint)
                    }
                    .accessibilityLabel("تحديث القراءات")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        store.lockApp()
                    } label: {
                        Image(systemName: "lock.fill")
                            .foregroundStyle(Aurora.inkSecondary)
                    }
                    .accessibilityLabel("قفل التطبيق")
                }
            }
            .sheet(item: $selectedDevice) { device in
                DeviceDetailSheet(device: device)
                    .environmentObject(store)
            }
            .task {
                if store.bootstrap == nil {
                    await store.refreshHome()
                }
            }
        }
    }

    // MARK: - WAN Health Strip

    private func wanHealthBar(_ boot: BootstrapPayload) -> some View {
        HStack(spacing: 10) {
            HStack(spacing: 7) {
                Circle()
                    .fill(boot.router.connected ? Aurora.mint : Aurora.coral)
                    .frame(width: 9, height: 9)
                    .shadow(color: (boot.router.connected ? Aurora.mint : Aurora.coral).opacity(0.65), radius: 5)
                Text(boot.router.connected ? "الراوتر متصل ومستقر" : "الراوتر غير متصل")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Aurora.ink)
            }

            Spacer(minLength: 4)

            StatusPill(
                text: "تشغيل \(F.uptime(boot.router.uptimeSec))",
                icon: "clock.fill",
                tint: Aurora.violet
            )
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Aurora.surface1, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Aurora.border, lineWidth: 1))
    }

    // MARK: - Live Dual Throughput Hero + Swift Charts Sparkline

    private func throughputHeroCard(_ boot: BootstrapPayload) -> some View {
        AuroraCard(accent: Aurora.mint) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Label("التحميل المباشر", systemImage: "arrow.down.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Aurora.mint)
                    Text(F.mbps(boot.throughput.downBps))
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Aurora.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .environment(\.layoutDirection, .leftToRight)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Divider()
                    .frame(height: 46)
                    .overlay(Aurora.border)

                VStack(alignment: .leading, spacing: 4) {
                    Label("الرفع المباشر", systemImage: "arrow.up.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Aurora.coral)
                    Text(F.mbps(boot.throughput.upBps))
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Aurora.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .environment(\.layoutDirection, .leftToRight)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Swift Charts Area + Line sparkline (non-mirrored time axis)
            throughputChart(points: boot.throughput.speeds)
                .frame(height: 132)
                .environment(\.layoutDirection, .leftToRight)

            // Quick status counters row
            HStack(spacing: 8) {
                miniCounter(
                    title: "الأجهزة النشطة",
                    value: "\(boot.counts.online) / \(boot.counts.totalDevices)",
                    icon: "wifi",
                    tint: Aurora.mint
                )
                miniCounter(
                    title: "انقطاعات اليوم",
                    value: "\(boot.counts.outagesToday)",
                    icon: boot.counts.outagesToday == 0 ? "checkmark.shield.fill" : "bolt.slash.fill",
                    tint: boot.counts.outagesToday == 0 ? Aurora.mint : Aurora.coral
                )
                miniCounter(
                    title: "استهلاك اليوم",
                    value: F.bytes(boot.throughput.bytesTodayDown + boot.throughput.bytesTodayUp),
                    icon: "chart.bar.fill",
                    tint: Aurora.violet
                )
            }

            if !boot.router.wanPorts.isEmpty {
                HStack(spacing: 8) {
                    ForEach(boot.router.wanPorts) { wan in
                        StatusPill(
                            text: "\(wan.wanName) · \(F.mbps(wan.downFluxBps))",
                            icon: wan.isConnected ? "globe" : "wifi.slash",
                            tint: wan.isConnected ? (wan.wanId == 1 ? Aurora.mint : Aurora.violet) : Aurora.coral,
                            forceLTR: true
                        )
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private func throughputChart(points: [SpeedPoint]) -> some View {
        Group {
            if points.isEmpty {
                HStack {
                    Spacer()
                    Text("جاري تجميع قراءات السرعة من الراوتر...")
                        .font(.caption)
                        .foregroundStyle(Aurora.inkMuted)
                    Spacer()
                }
                .frame(maxHeight: .infinity)
            } else {
                Chart(points) { pt in
                    AreaMark(
                        x: .value("الوقت", pt.date),
                        y: .value("التحميل", F.mbpsValue(pt.downBps))
                    )
                    .interpolationMethod(.monotone)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Aurora.mint.opacity(0.36), Aurora.mint.opacity(0.02)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )

                    LineMark(
                        x: .value("الوقت", pt.date),
                        y: .value("التحميل", F.mbpsValue(pt.downBps)),
                        series: .value("السلسلة", "تحميل")
                    )
                    .interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round))
                    .foregroundStyle(Aurora.mint)

                    LineMark(
                        x: .value("الوقت", pt.date),
                        y: .value("الرفع", F.mbpsValue(pt.upBps)),
                        series: .value("السلسلة", "رفع")
                    )
                    .interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                    .foregroundStyle(Aurora.coral.opacity(0.85))
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 4)) {
                        AxisValueLabel(format: .dateTime.hour().minute())
                            .font(.caption2)
                            .foregroundStyle(Aurora.inkMuted)
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5))
                            .foregroundStyle(Aurora.border)
                        AxisValueLabel {
                            if let mbps = value.as(Double.self) {
                                Text("\(F.num(mbps, digits: 0))M")
                                    .font(.caption2)
                                    .monospacedDigit()
                                    .foregroundStyle(Aurora.inkMuted)
                            }
                        }
                    }
                }
                .chartLegend(.hidden)
            }
        }
    }

    private func miniCounter(title: String, value: String, icon: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.caption2)
                    .foregroundStyle(tint)
                Text(title)
                    .font(.caption2)
                    .foregroundStyle(Aurora.inkMuted)
                    .lineLimit(1)
            }
            Text(value)
                .font(.footnote.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(Aurora.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: - Recent Security Alert Banner

    private func securityBanner(alert: TendaAlert, attackCount: Int) -> some View {
        Button {
            store.selectedTab = .security
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(Aurora.coral.opacity(0.18))
                        .frame(width: 40, height: 40)
                    Image(systemName: "shield.lefthalf.filled.badge.checkmark")
                        .foregroundStyle(Aurora.coral)
                        .font(.body.weight(.semibold))
                }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(alert.kindArabic)
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(Aurora.ink)
                        if attackCount > 0 {
                            StatusPill(text: "\(attackCount) هجمات 24س", tint: Aurora.coral)
                        }
                    }
                    Text(alert.payload ?? alert.deviceLabel ?? "تنبيه أمني نشط على الشبكة")
                        .font(.caption)
                        .foregroundStyle(Aurora.inkSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.left")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Aurora.inkMuted)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Aurora.coral.opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Aurora.coral.opacity(0.35), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func attacksOnlyBanner(count: Int) -> some View {
        Button {
            store.selectedTab = .security
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.shield.fill")
                    .foregroundStyle(Aurora.coral)
                Text("تم رصد وصد \(count) محاولات هجوم خلال آخر 24 ساعة")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Aurora.ink)
                Spacer()
                Image(systemName: "chevron.left")
                    .font(.caption)
                    .foregroundStyle(Aurora.inkMuted)
            }
            .padding(14)
            .background(Aurora.coral.opacity(0.12), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Aurora.coral.opacity(0.32), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Monthly Quota & AI Forecast Card

    private func quotaForecastCard(_ quota: QuotaForecast) -> some View {
        let pct = Int((quota.usageRatio * 100).rounded())
        return AuroraCard(accent: quota.willExhaustBeforeRenewal ? Aurora.coral : Aurora.violet) {
            AuroraSectionHeader(
                title: "الباقة الشهرية وتوقعات الذكاء",
                subtitle: "تجديد الدورة يوم \(quota.renewalDay) من الشهر",
                icon: "sparkles",
                tint: Aurora.violet
            )

            HStack(spacing: 16) {
                QuotaRingView(
                    progress: quota.usageRatio,
                    label: "\(pct)%",
                    sublabel: "مستهلك",
                    warning: quota.willExhaustBeforeRenewal
                )

                VStack(alignment: .leading, spacing: 8) {
                    quotaMetricRow(
                        label: "المستخدم من الباقة",
                        value: "\(F.bytes(quota.usedBytes)) / \(F.bytes(quota.combinedQuotaBytes))",
                        tint: Aurora.ink
                    )
                    quotaMetricRow(
                        label: "المتوسط اليومي",
                        value: "\(F.bytes(quota.weightedDailyBurnBytes)) / يوم",
                        tint: Aurora.mint
                    )
                    quotaMetricRow(
                        label: "الأيام المتبقية للتجديد",
                        value: "\(Int(quota.daysRemainingInCycle.rounded())) أيام",
                        tint: quota.willExhaustBeforeRenewal ? Aurora.coral : Aurora.violet
                    )
                    if let daysLeft = quota.daysUntilExhaustion {
                        quotaMetricRow(
                            label: "كفاية الرصيد المتوقعة",
                            value: "\(F.num(daysLeft, digits: 1)) يوم",
                            tint: quota.willExhaustBeforeRenewal ? Aurora.coral : Aurora.mint
                        )
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if !quota.summaryAr.isEmpty {
                Text(quota.summaryAr)
                    .font(.caption)
                    .foregroundStyle(Aurora.inkSecondary)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private func quotaMetricRow(label: String, value: String, tint: Color) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(Aurora.inkMuted)
            Spacer(minLength: 4)
            Text(value)
                .font(.caption.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(tint)
        }
    }

    // MARK: - Top Bandwidth Hogs

    private func topHogsSection(_ hogs: [TendaDevice]) -> some View {
        AuroraCard {
            HStack {
                AuroraSectionHeader(
                    title: "الأكثر استهلاكاً اليوم",
                    subtitle: "اضغط على أي جهاز للتحكم في سرعته أو حظره",
                    icon: "flame.fill",
                    tint: Aurora.coral
                )
                Button("الكل") {
                    store.selectedTab = .devices
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(Aurora.mint)
            }

            if hogs.isEmpty {
                Text("لا توجد حركة بيانات مسجّلة اليوم بعد.")
                    .font(.footnote)
                    .foregroundStyle(Aurora.inkMuted)
            } else {
                let peakBytes = max(hogs.map { $0.bytesToday + $0.bytesUpToday }.max() ?? 1, 1)
                VStack(spacing: 10) {
                    ForEach(hogs.prefix(5)) { device in
                        Button {
                            selectedDevice = device
                        } label: {
                            hogRow(device: device, ratio: (device.bytesToday + device.bytesUpToday) / peakBytes)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func hogRow(device: TendaDevice, ratio: Double) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Aurora.surface3)
                        .frame(width: 36, height: 36)
                    Image(systemName: F.deviceIcon(category: device.category, label: device.label))
                        .font(.subheadline)
                        .foregroundStyle(device.isBlocked ? Aurora.coral : (device.online ? Aurora.mint : Aurora.inkMuted))
                }

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(device.label)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Aurora.ink)
                            .lineLimit(1)
                        if device.isBlocked {
                            StatusPill(text: "محظور", tint: Aurora.coral)
                        } else if device.isLimited {
                            StatusPill(text: F.speedLimitKbs(device.downloadLimitKbs), tint: Aurora.amber, forceLTR: true)
                        }
                    }
                    HStack(spacing: 8) {
                        Text(device.ip ?? device.mac)
                            .font(.caption2.monospaced())
                            .foregroundStyle(Aurora.inkMuted)
                            .environment(\.layoutDirection, .leftToRight)
                        if device.online && device.downSpeedBps > 0 {
                            Text("↓ \(F.mbps(device.downSpeedBps))")
                                .font(.caption2.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(Aurora.mint)
                                .environment(\.layoutDirection, .leftToRight)
                        }
                    }
                }

                Spacer(minLength: 4)

                Text(F.bytes(device.bytesToday + device.bytesUpToday))
                    .font(.subheadline.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(Aurora.ink)
                    .environment(\.layoutDirection, .leftToRight)
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Aurora.surface3)
                    Capsule()
                        .fill(device.isBlocked ? Aurora.coral : Aurora.mint)
                        .frame(width: max(6, geo.size.width * CGFloat(max(0, min(1, ratio)))))
                }
            }
            .frame(height: 5)
        }
        .padding(10)
        .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
                .tint(Aurora.mint)
                .scaleEffect(1.2)
            Text("جاري قراءة حالة الراوتر والشبكة...")
                .font(.footnote)
                .foregroundStyle(Aurora.inkSecondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 64)
    }

    private var emptyState: some View {
        AuroraCard {
            VStack(spacing: 12) {
                Image(systemName: "wifi.exclamationmark")
                    .font(.largeTitle)
                    .foregroundStyle(Aurora.amber)
                Text("لم تصل قراءات الراوتر بعد")
                    .font(.headline)
                    .foregroundStyle(Aurora.ink)
                Button("إعادة المحاولة") {
                    Task { await store.refreshHome() }
                }
                .buttonStyle(.borderedProminent)
                .tint(Aurora.violet)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
        }
    }
}
