import SwiftUI

/// Tab 5 `الإعدادات` — Router & Security:
/// - Router status, model & firmware
/// - Remote Reboot (with confirmation), Refresh Poll, Guest Wi-Fi toggle (when supported)
/// - Notification & Alert thresholds
/// - Bound iPhone Security panel (`OwnerDeviceAuth v2` key fingerprint, last seen, Unbind with confirmation)
struct SettingsTabView: View {
    @EnvironmentObject private var store: TendaStore
    @State private var confirmReboot: Bool = false
    @State private var confirmUnbind: Bool = false
    @State private var actionBusy: Bool = false

    @State private var totalThresholdEnabled: Bool = false
    @State private var totalLimitGb: Double = 500
    @State private var totalPeriod: String = "month"
    @State private var deviceThresholdEnabled: Bool = false
    @State private var deviceLimitGb: Double = 25
    @State private var devicePeriod: String = "today"
    @State private var thresholdsSynced: Bool = false
    @State private var savingThresholds: Bool = false

    var body: some View {
        NavigationStack {
            ZStack {
                AuroraBackdrop()

                ScrollView {
                    VStack(spacing: 16) {
                        if let cfg = store.settings {
                            routerHealthCard(cfg.router)
                            routerActionsCard(cfg.router)
                            notificationsCard(cfg)
                            boundSecurityCard(cfg.deviceAuth)
                        } else if store.isLoadingSettings {
                            ProgressView().tint(Aurora.mint).padding(.top, 60)
                        } else {
                            fallbackUnbindCard
                        }
                    }
                    .padding(16)
                }
                .refreshable {
                    await store.refreshSettings()
                }
            }
            .navigationTitle("الإعدادات")
            .toolbarColorScheme(.dark, for: .navigationBar)
            .confirmationDialog(
                "إعادة تشغيل الراوتر الآن؟",
                isPresented: $confirmReboot,
                titleVisibility: .visible
            ) {
                Button("نعم، أعد تشغيل الراوتر", role: .destructive) {
                    Task {
                        actionBusy = true
                        await store.performRouterAction("reboot")
                        actionBusy = false
                    }
                }
                Button("إلغاء", role: .cancel) {}
            } message: {
                Text("سينقطع الاتصال مؤقتاً عن جميع الأجهزة لحوالي دقيقة حتى يعود الراوتر للعمل.")
            }
            .confirmationDialog(
                "فك ربط هذا الآيفون من تندا؟",
                isPresented: $confirmUnbind,
                titleVisibility: .visible
            ) {
                Button("نعم، فك الربط ومسح المفاتيح", role: .destructive) {
                    Task { await store.unbindThisPhone() }
                }
                Button("إلغاء", role: .cancel) {}
            } message: {
                Text("سيتم إلغاء مفاتيح Secure Enclave على هذا الجهاز وإغلاق الجلسة. ستحتاج لكود ربط جديد من لوحة الويب لإعادة التفعيل.")
            }
            .task {
                if store.settings == nil {
                    await store.refreshSettings()
                }
                syncThresholdsFromStore()
            }
            .onChange(of: store.settings?.thresholds.totalLimitBytes) { _, _ in
                if !thresholdsSynced { syncThresholdsFromStore() }
            }
        }
    }

    private func syncThresholdsFromStore() {
        guard let t = store.settings?.thresholds else { return }
        totalThresholdEnabled = t.totalEnabled
        let totGb = t.totalLimitBytes / 1_073_741_824.0
        totalLimitGb = totGb > 0 ? (totGb).rounded() : 500
        totalPeriod = Self.normalizePeriod(t.totalPeriod)
        deviceThresholdEnabled = t.deviceEnabled
        let devGb = t.deviceDefaultLimitBytes / 1_073_741_824.0
        deviceLimitGb = devGb > 0 ? (devGb).rounded() : 25
        devicePeriod = Self.normalizePeriod(t.deviceDefaultPeriod)
        thresholdsSynced = true
    }

    private static func normalizePeriod(_ raw: String) -> String {
        switch raw.lowercased() {
        case "today", "day": return "today"
        case "week": return "week"
        case "month": return "month"
        default: return "today"
        }
    }

    private static func localizedNotificationTitle(for item: NotificationTypeRow) -> String {
        switch item.key {
        case "new_device": return "جهاز جديد على الشبكة"
        case "nsfw": return "فلتر المحتوى (NSFW)"
        case "security": return "تحليلات الحماية والشذوذ"
        case "attack": return "هجمات جدار الحماية"
        case "outage": return "انقطاع الاتصال"
        case "reboot": return "إعادة تشغيل الراوتر"
        case "total_download_threshold": return "حد الاستهلاك الإجمالي"
        case "device_download_threshold": return "حد استهلاك الجهاز"
        case "test": return "إشعارات الاختبار"
        default: return item.label
        }
    }

    private static func localizedNotificationDescription(for item: NotificationTypeRow) -> String {
        switch item.key {
        case "new_device": return "تنبيه فوري عند اتصال جهاز بعنوان MAC جديد."
        case "nsfw": return "رصد نطاقات المحتوى غير اللائق من سجلات الراوتر."
        case "security": return "كشف ارتفاع الاتصالات أو الشذوذ في حركة الشبكة."
        case "attack": return "تنبيهات هجمات ARP و SYN Flood وفحص المنافذ."
        case "outage": return "إشعار عند هبوط الاتصال أو تعذّر الوصول للراوتر."
        case "reboot": return "إشعار عند إعادة تشغيل الراوتر وتصفير زمن التشغيل."
        case "total_download_threshold": return "تنبيه عند تجاوز مجموع استهلاك الشبكة الحد المحدد."
        case "device_download_threshold": return "تنبيه عند تجاوز جهاز واحد سقف الاستهلاك."
        case "test": return "إشعارات التجربة المرسلة من لوحة الإعدادات."
        default: return item.description
        }
    }

    // MARK: - Router Status & Firmware

    private func routerHealthCard(_ info: RouterSettingsPayload.RouterInfo) -> some View {
        AuroraCard(accent: Aurora.mint) {
            HStack {
                AuroraSectionHeader(
                    title: info.model,
                    subtitle: info.firmware ?? "Tenda Enterprise Router",
                    icon: "wifi.router.fill",
                    tint: Aurora.mint
                )
                StatusPill(
                    text: info.daemonRunning ? "المراقب يعمل" : "متوقف",
                    tint: info.daemonRunning ? Aurora.mint : Aurora.coral
                )
            }

            VStack(spacing: 8) {
                kvRow(label: "عنوان الراوتر", value: info.host, forceLTR: true)
                kvRow(label: "مدة التشغيل", value: F.uptime(info.uptimeSec))
                kvRow(label: "فترة الفحص", value: "\(info.pollIntervalMs / 1000) ثوانٍ")
                if let cpu = info.cpuPercent {
                    kvRow(label: "استخدام المعالج", value: "\(Int(cpu.rounded()))%", forceLTR: true)
                }
                if let mem = info.memPercent {
                    kvRow(label: "استخدام الذاكرة", value: "\(Int(mem.rounded()))%", forceLTR: true)
                }
            }
        }
    }

    // MARK: - Router Remote Controls

    private func routerActionsCard(_ info: RouterSettingsPayload.RouterInfo) -> some View {
        AuroraCard(accent: Aurora.coral) {
            AuroraSectionHeader(title: "تحكم مباشر بالراوتر", icon: "bolt.shield.fill", tint: Aurora.coral)

            Button {
                Task {
                    actionBusy = true
                    await store.performRouterAction("refresh_poll")
                    actionBusy = false
                }
            } label: {
                HStack {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .foregroundStyle(Aurora.mint)
                    Text("تحديث قراءات الراوتر والـ QoS الآن")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Aurora.ink)
                    Spacer()
                    if actionBusy { ProgressView().tint(Aurora.mint) }
                }
                .padding(12)
                .frame(maxWidth: .infinity, minHeight: 46)
                .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(actionBusy)

            if let guestOn = info.guestWifiEnabled {
                HStack {
                    Label("شبكة الضيوف (Guest Wi-Fi)", systemImage: "person.2.wave.2.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Aurora.ink)
                    Spacer()
                    Toggle("", isOn: Binding(
                        get: { guestOn },
                        set: { next in
                            Task {
                                actionBusy = true
                                await store.performRouterAction("toggle_guest_wifi", enabled: next)
                                actionBusy = false
                            }
                        }
                    ))
                    .labelsHidden()
                    .tint(Aurora.violet)
                    .disabled(actionBusy)
                }
                .padding(12)
                .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            }

            Button {
                confirmReboot = true
            } label: {
                HStack {
                    Image(systemName: "power")
                    Text("إعادة تشغيل الراوتر عن بُعد")
                        .font(.subheadline.weight(.semibold))
                }
                .foregroundStyle(Aurora.coral)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Aurora.coral.opacity(0.12), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .strokeBorder(Aurora.coral.opacity(0.35), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .disabled(actionBusy)
        }
    }

    // MARK: - Notifications & Thresholds

    private func notificationsCard(_ cfg: RouterSettingsPayload) -> some View {
        AuroraCard(accent: Aurora.violet) {
            AuroraSectionHeader(
                title: "التنبيهات وحدود الاستهلاك",
                subtitle: "تنبيهات فورية عبر APNs عند الأحداث الحساسة",
                icon: "bell.badge.fill",
                tint: Aurora.violet
            )

            ForEach(cfg.notificationTypes) { item in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Self.localizedNotificationTitle(for: item))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Aurora.ink)
                        Text(Self.localizedNotificationDescription(for: item))
                            .font(.caption2)
                            .foregroundStyle(Aurora.inkMuted)
                    }
                    Spacer()
                    Toggle("", isOn: Binding(
                        get: { item.enabled },
                        set: { next in
                            Task { await store.toggleNotificationType(key: item.key, enabled: next) }
                        }
                    ))
                    .labelsHidden()
                    .tint(Aurora.mint)
                }
                .padding(10)
                .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }

            Divider().overlay(Aurora.border).padding(.vertical, 4)

            // Interactive Alert Thresholds
            VStack(alignment: .leading, spacing: 10) {
                Text("حدود التنبيه للاستهلاك")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Aurora.ink)

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("تنبيه إجمالي الشبكة")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Aurora.inkSecondary)
                        Spacer()
                        Toggle("", isOn: $totalThresholdEnabled)
                            .labelsHidden()
                            .tint(Aurora.violet)
                    }

                    if totalThresholdEnabled {
                        HStack {
                            Text("السقف: \(Int(totalLimitGb)) GB")
                                .font(.caption.monospacedDigit().weight(.bold))
                                .foregroundStyle(Aurora.mint)
                                .environment(\.layoutDirection, .leftToRight)
                            Spacer()
                            Stepper("", value: $totalLimitGb, in: 10...5000, step: 25)
                                .labelsHidden()
                        }
                        Picker("الفترة", selection: $totalPeriod) {
                            Text("يومي").tag("today")
                            Text("أسبوعي").tag("week")
                            Text("شهري").tag("month")
                        }
                        .pickerStyle(.segmented)
                    }
                }
                .padding(10)
                .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("تنبيه استهلاك الجهاز الواحد")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Aurora.inkSecondary)
                        Spacer()
                        Toggle("", isOn: $deviceThresholdEnabled)
                            .labelsHidden()
                            .tint(Aurora.violet)
                    }

                    if deviceThresholdEnabled {
                        HStack {
                            Text("السقف: \(Int(deviceLimitGb)) GB")
                                .font(.caption.monospacedDigit().weight(.bold))
                                .foregroundStyle(Aurora.mint)
                                .environment(\.layoutDirection, .leftToRight)
                            Spacer()
                            Stepper("", value: $deviceLimitGb, in: 1...500, step: 5)
                                .labelsHidden()
                        }
                        Picker("فترة الجهاز", selection: $devicePeriod) {
                            Text("يومي").tag("today")
                            Text("أسبوعي").tag("week")
                            Text("شهري").tag("month")
                        }
                        .pickerStyle(.segmented)
                    }
                }
                .padding(10)
                .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                Button {
                    Task {
                        savingThresholds = true
                        let payload = ThresholdConfigPayload(
                            totalEnabled: totalThresholdEnabled,
                            totalLimitBytes: totalLimitGb * 1_073_741_824.0,
                            totalPeriod: totalPeriod,
                            deviceEnabled: deviceThresholdEnabled,
                            deviceDefaultLimitBytes: deviceLimitGb * 1_073_741_824.0,
                            deviceDefaultPeriod: devicePeriod
                        )
                        _ = await store.saveThresholds(payload)
                        savingThresholds = false
                    }
                } label: {
                    HStack(spacing: 8) {
                        if savingThresholds {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "checkmark.circle.fill")
                        }
                        Text(savingThresholds ? "جاري الحفظ..." : "حفظ حدود التنبيه")
                            .font(.subheadline.weight(.semibold))
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(Aurora.violet, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(savingThresholds)
            }
        }
    }

    // MARK: - Bound iPhone Security Panel (OwnerDeviceAuth v2)

    private func boundSecurityCard(_ auth: DeviceAuthStatusPayload) -> some View {
        let devId = !auth.deviceId.isEmpty ? auth.deviceId : store.localDeviceId
        let fingerprint = devId.count > 16 ? "\(devId.prefix(10))…\(devId.suffix(6))" : (devId.isEmpty ? "—" : devId)

        return AuroraCard(accent: Aurora.violet) {
            HStack {
                AuroraSectionHeader(
                    title: "أمان الآيفون المربوط",
                    subtitle: "OwnerDeviceAuth v2 · Secure Enclave",
                    icon: "faceid",
                    tint: Aurora.mint
                )
                if auth.attested {
                    StatusPill(text: "App Attest ✓", tint: Aurora.mint, forceLTR: true)
                }
            }

            VStack(spacing: 8) {
                kvRow(label: "بصمة المفتاح (Key ID)", value: fingerprint, forceLTR: true)
                kvRow(label: "تاريخ الربط", value: F.timestamp(auth.boundAt), forceLTR: true)
                kvRow(label: "آخر نشاط موقّع", value: F.timestamp(auth.lastSeenAt), forceLTR: true)
                kvRow(label: "حالة الجلسة", value: auth.sessionActive ? "نشطة ومشفّرة" : "مقفلة")
            }

            HStack(spacing: 10) {
                Button {
                    store.lockApp()
                } label: {
                    Label("قفل الآن", systemImage: "lock.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Aurora.ink)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                }
                .buttonStyle(.plain)

                Button {
                    confirmUnbind = true
                } label: {
                    Label(store.isDemoActive ? "خروج من المعاينة" : "فك ربط الآيفون", systemImage: "iphone.slash")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Aurora.coral)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(Aurora.coral.opacity(0.12), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                .strokeBorder(Aurora.coral.opacity(0.35), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var fallbackUnbindCard: some View {
        AuroraCard {
            AuroraSectionHeader(title: "أمان الجهاز", icon: "lock.shield", tint: Aurora.violet)
            Button("فك ربط الآيفون", role: .destructive) {
                confirmUnbind = true
            }
            .buttonStyle(.bordered)
            .tint(Aurora.coral)
        }
    }

    private func kvRow(label: String, value: String, forceLTR: Bool = false) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(Aurora.inkMuted)
            Spacer(minLength: 6)
            Text(value)
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(Aurora.ink)
                .environment(\.layoutDirection, forceLTR ? .leftToRight : .rightToLeft)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}
