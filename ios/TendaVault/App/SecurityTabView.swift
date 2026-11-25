import SwiftUI

enum SecuritySection: Int, CaseIterable {
    case attacks = 0
    case contentFilter = 1
    case alerts = 2

    var title: String {
        switch self {
        case .attacks: return "الهجمات"
        case .contentFilter: return "فلتر المحتوى"
        case .alerts: return "التنبيهات"
        }
    }
}

/// Tab 3 `الحماية` — Security & Radar:
/// - Segmented picker: `الهجمات` | `فلتر المحتوى` | `التنبيهات`
/// - Attack log with severity badges & source IP
/// - NSFW / Content guard toggle & blocked domains / devices
/// - Alerts with Acknowledge swipe action + Dismiss All
struct SecurityTabView: View {
    @EnvironmentObject private var store: TendaStore
    @State private var section: SecuritySection = .attacks

    var body: some View {
        NavigationStack {
            ZStack {
                AuroraBackdrop()

                VStack(spacing: 0) {
                    Picker("قسم الحماية", selection: $section) {
                        ForEach(SecuritySection.allCases, id: \.self) { sec in
                            Text(sec.title).tag(sec)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)

                    switch section {
                    case .attacks:
                        attacksListView
                    case .contentFilter:
                        contentFilterView
                    case .alerts:
                        alertsListView
                    }
                }
            }
            .navigationTitle("الحماية")
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                if section == .alerts {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("إغلاق الكل") {
                            Task { await store.ackAlert(action: "dismiss_all") }
                        }
                        .font(.subheadline)
                        .foregroundStyle(Aurora.coral)
                    }
                }
            }
            .task {
                if store.security == nil {
                    await store.refreshSecurity()
                }
            }
        }
    }

    // MARK: - Attacks Log

    private var attacksListView: some View {
        ScrollView {
            VStack(spacing: 14) {
                if let sec = store.security {
                    HStack(spacing: 10) {
                        securityMetric(
                            title: "إجمالي الهجمات",
                            value: "\(sec.attacks.stats.totals.attacks ?? sec.attacks.entries.count)",
                            tint: Aurora.coral
                        )
                        securityMetric(
                            title: "أحداث السجل",
                            value: "\(sec.attacks.stats.totals.total)",
                            tint: Aurora.violet
                        )
                    }

                    if sec.attacks.entries.isEmpty {
                        AuroraCard(accent: Aurora.mint) {
                            HStack(spacing: 12) {
                                Image(systemName: "checkmark.shield.fill")
                                    .font(.title2)
                                    .foregroundStyle(Aurora.mint)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text("لا توجد هجمات مسجّلة")
                                        .font(.headline)
                                        .foregroundStyle(Aurora.ink)
                                    Text("جدار الحماية في راوتر تندا يعمل بشكل طبيعي.")
                                        .font(.caption)
                                        .foregroundStyle(Aurora.inkSecondary)
                                }
                            }
                        }
                    } else {
                        ForEach(sec.attacks.entries) { entry in
                            AuroraCard(accent: entry.isHighSeverity ? Aurora.coral : Aurora.amber, padding: 14) {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: entry.isHighSeverity ? "flame.fill" : "exclamationmark.triangle.fill")
                                        .foregroundStyle(entry.isHighSeverity ? Aurora.coral : Aurora.amber)
                                        .font(.title3)

                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Text(entry.attackKind ?? "تهديد شبكي")
                                                .font(.subheadline.weight(.bold))
                                                .foregroundStyle(Aurora.ink)
                                            Spacer()
                                            StatusPill(
                                                text: entry.isHighSeverity ? "خطورة عالية" : "متوسط",
                                                tint: entry.isHighSeverity ? Aurora.coral : Aurora.amber
                                            )
                                        }

                                        Text(entry.message)
                                            .font(.caption)
                                            .foregroundStyle(Aurora.inkSecondary)
                                            .lineLimit(3)

                                        HStack(spacing: 8) {
                                            if let ip = entry.attackerIp, !ip.isEmpty {
                                                StatusPill(text: ip, icon: "network", tint: Aurora.ice, forceLTR: true)
                                            }
                                            if let count = entry.attackCount, count > 0 {
                                                StatusPill(text: "\(count)×", tint: Aurora.coral, forceLTR: true)
                                            }
                                            Spacer()
                                            Text(F.timestamp(entry.ts))
                                                .font(.caption2.monospaced())
                                                .foregroundStyle(Aurora.inkMuted)
                                                .environment(\.layoutDirection, .leftToRight)
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    ProgressView().tint(Aurora.mint).padding(.top, 60)
                }
            }
            .padding(16)
        }
        .refreshable { await store.refreshSecurity() }
    }

    // MARK: - NSFW / Content Filter

    private var contentFilterView: some View {
        ScrollView {
            VStack(spacing: 14) {
                if let nsfw = store.security?.nsfw {
                    AuroraCard(accent: nsfw.enabled ? Aurora.mint : Aurora.amber) {
                        HStack(spacing: 12) {
                            Image(systemName: nsfw.enabled ? "lock.shield.fill" : "shield.slash.fill")
                                .font(.title2)
                                .foregroundStyle(nsfw.enabled ? Aurora.mint : Aurora.amber)
                            VStack(alignment: .leading, spacing: 3) {
                                Text("درع فلتر المحتوى (NSFW Guard)")
                                    .font(.headline)
                                    .foregroundStyle(Aurora.ink)
                                Text("يرصد النطاقات غير اللائقة من سجلات الراوتر ويرسل تنبيهاً فورياً")
                                    .font(.caption)
                                    .foregroundStyle(Aurora.inkSecondary)
                            }
                            Spacer()
                            Toggle("", isOn: Binding(
                                get: { nsfw.enabled },
                                set: { next in Task { await store.setNsfwEnabled(next) } }
                            ))
                            .labelsHidden()
                            .tint(Aurora.mint)
                        }

                        HStack(spacing: 10) {
                            securityMetric(title: "محاولات (24 ساعة)", value: "\(nsfw.last24h.hits)", tint: nsfw.last24h.hits > 0 ? Aurora.coral : Aurora.mint)
                            securityMetric(title: "الأجهزة المعنية", value: "\(nsfw.last24h.devices)", tint: Aurora.violet)
                        }
                    }

                    AuroraCard {
                        AuroraSectionHeader(title: "أكثر النطاقات المحجوبة", icon: "globe.badge.chevron.backward", tint: Aurora.coral)
                        if nsfw.topDomains.isEmpty {
                            Text("لم تُسجّل أي محاولات خلال آخر 24 ساعة.")
                                .font(.caption)
                                .foregroundStyle(Aurora.inkMuted)
                        } else {
                            ForEach(nsfw.topDomains) { row in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(row.domain)
                                            .font(.subheadline.monospaced().weight(.semibold))
                                            .foregroundStyle(Aurora.ink)
                                            .environment(\.layoutDirection, .leftToRight)
                                        Text("\(row.category) · \(F.timestamp(row.lastTs))")
                                            .font(.caption2)
                                            .foregroundStyle(Aurora.inkMuted)
                                    }
                                    Spacer()
                                    StatusPill(text: "\(row.hits) محاولة", tint: Aurora.coral)
                                }
                                .padding(10)
                                .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                        }
                    }

                    if !nsfw.byDevice.isEmpty {
                        AuroraCard {
                            AuroraSectionHeader(title: "حسب الجهاز", icon: "iphone.radiowaves.left.and.right", tint: Aurora.amber)
                            ForEach(nsfw.byDevice) { row in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(row.label)
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(Aurora.ink)
                                        Text(row.sourceIp ?? row.sourceMac)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(Aurora.inkMuted)
                                            .environment(\.layoutDirection, .leftToRight)
                                    }
                                    Spacer()
                                    StatusPill(text: "\(row.hits)×", tint: Aurora.amber, forceLTR: true)
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
            .padding(16)
        }
        .refreshable { await store.refreshSecurity() }
    }

    // MARK: - Alerts List with Swipe Acknowledge

    private var alertsListView: some View {
        let alerts = store.security?.alerts ?? []
        return List {
            if alerts.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "bell.slash.fill")
                        .font(.title)
                        .foregroundStyle(Aurora.mint)
                    Text("لا توجد تنبيهات حالياً")
                        .font(.subheadline)
                        .foregroundStyle(Aurora.inkSecondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 48)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else {
                ForEach(alerts) { alert in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(alert.deviceLabel ?? alert.kindArabic)
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(alert.isDismissed ? Aurora.inkSecondary : Aurora.ink)
                            Spacer()
                            StatusPill(
                                text: alert.isDismissed ? "مؤكّد" : alert.kindArabic,
                                tint: alert.isDismissed ? Aurora.mint : Aurora.coral
                            )
                        }
                        if let payload = alert.payload, !payload.isEmpty {
                            Text(payload)
                                .font(.caption)
                                .foregroundStyle(Aurora.inkSecondary)
                                .lineLimit(3)
                        }
                        Text(F.timestamp(alert.createdAt))
                            .font(.caption2.monospaced())
                            .foregroundStyle(Aurora.inkMuted)
                            .environment(\.layoutDirection, .leftToRight)
                    }
                    .padding(14)
                    .background(Aurora.surface1, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(alert.isDismissed ? Aurora.border : Aurora.coral.opacity(0.32), lineWidth: 1)
                    )
                    .opacity(alert.isDismissed ? 0.65 : 1.0)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        if !alert.isDismissed {
                            Button {
                                Task { await store.ackAlert(id: alert.id) }
                            } label: {
                                Label("تأكيد", systemImage: "checkmark.circle.fill")
                            }
                            .tint(Aurora.mint)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await store.refreshSecurity() }
    }

    private func securityMetric(title: String, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(Aurora.inkMuted)
            Text(value)
                .font(.title2.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(tint)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
