import Combine
import Foundation
import OwnerDeviceAuth
import UIKit
import UserNotifications

extension Notification.Name {
    static let tendaApnsToken = Notification.Name("com.tveg.tendavault.apnsToken")
    static let tendaPushDeepLink = Notification.Name("com.tveg.tendavault.pushDeepLink")
}

struct TendaPushLink: Sendable, Equatable {
    let url: String
    let kind: String
    let mac: String
}

final class VaultAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        if let remote = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            Self.emitDeepLink(from: remote)
        }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(name: .tendaApnsToken, object: hex)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        Self.emitDeepLink(from: response.notification.request.content.userInfo)
    }

    private nonisolated static func emitDeepLink(from info: [AnyHashable: Any]) {
        let url = (info["url"] as? String) ?? ""
        let kind = (info["kind"] as? String) ?? ""
        let mac = (info["mac"] as? String) ?? ""
        let link = TendaPushLink(url: url, kind: kind, mac: mac)
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .tendaPushDeepLink, object: link)
        }
    }
}

enum AppTab: Int, CaseIterable, Hashable {
    case home = 0
    case devices = 1
    case security = 2
    case analytics = 3
    case settings = 4
}

@MainActor
final class TendaStore: ObservableObject {
    @Published var isLocked: Bool = true
    @Published var isPaired: Bool = OwnerReviewGate.isOwnerDevicePaired
    @Published var isAuthenticating: Bool = false
    @Published var authNotice: String? = nil
    @Published var authNoticeIsError: Bool = false

    @Published var selectedTab: AppTab = .home
    @Published var deepLinkDeviceMac: String? = nil
    @Published var toastMessage: String? = nil
    @Published var toastIsError: Bool = false

    // Domain state
    @Published var bootstrap: BootstrapPayload? = nil
    @Published var devices: [TendaDevice] = []
    @Published var wanPorts: [WanPortInfo] = []
    @Published var security: SecurityPayload? = nil
    @Published var consumption: ConsumptionPayload? = nil
    @Published var outages: OutagesPayload? = nil
    @Published var networkMap: NetworkMapPayload? = nil
    @Published var report: ReportPayload? = nil
    @Published var settings: RouterSettingsPayload? = nil
    @Published var localDeviceId: String = ""

    @Published var isLoadingHome: Bool = false
    @Published var isLoadingDevices: Bool = false
    @Published var isLoadingSecurity: Bool = false
    @Published var isLoadingAnalytics: Bool = false
    @Published var isLoadingSettings: Bool = false

    // In-memory offline demo state
    private var demoDevices: [TendaDevice] = TendaDemoFixtures.makeDevices()
    private var demoAlerts: [TendaAlert] = TendaDemoFixtures.makeAlerts()
    private var demoNsfwEnabled: Bool = true
    private var demoGuestWifi: Bool = false

    private let client = TendaClient()
    private var pollTask: Task<Void, Never>?
    private var toastTask: Task<Void, Never>?
    private var apnsTokenHex: String?
    private var cancellables: Set<AnyCancellable> = []

    var isDemoActive: Bool {
        OwnerReviewGate.shared.isOn || OwnerReviewGate.transportOn
    }

    init() {
        NotificationCenter.default.publisher(for: .tendaApnsToken)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] note in
                guard let self, let hex = note.object as? String else { return }
                self.apnsTokenHex = hex
                Task { await self.syncApnsTokenIfReady(hex) }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .tendaPushDeepLink)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] note in
                guard let self, let link = note.object as? TendaPushLink else { return }
                self.applyPushDeepLink(link)
            }
            .store(in: &cancellables)

        OwnerReviewGate.shared.$isOn
            .receive(on: DispatchQueue.main)
            .sink { [weak self] demoOn in
                guard let self else { return }
                if demoOn {
                    self.loadAllDemoData()
                } else {
                    self.stopPolling()
                    if self.isLocked {
                        self.clearLiveData()
                    }
                }
            }
            .store(in: &cancellables)

        if isDemoActive {
            loadAllDemoData()
        }

        Task { await refreshPairingState() }
    }

    // MARK: - Pairing & Biometric Lock

    func refreshPairingState() async {
        let state = await client.pairingState()
        switch state {
        case .paired:
            isPaired = true
            localDeviceId = (await client.deviceId()) ?? ""
            OwnerReviewGate.markOwnerDevicePaired()
        case .unpaired:
            isPaired = false
            localDeviceId = ""
            OwnerReviewGate.clearOwnerDevicePaired()
        case .unknown:
            // Keychain temporarily unreadable or unsigned simulator: preserve keys (never wipe),
            // and only stay paired if this device was previously paired.
            isPaired = OwnerReviewGate.isOwnerDevicePaired
        }
    }

    /// Resets local keys ONLY when the server authoritatively confirms this device is no longer bound
    /// (`device_not_bound` / `device_mismatch`). Never runs on Face ID cancel/failure or network errors.
    @discardableResult
    private func handleServerRevocationIfNeeded(_ error: Error) async -> Bool {
        guard !isDemoActive,
              let apiErr = error as? TendaAPIError,
              apiErr.isAuthoritativeServerRevocation
        else { return false }
        await client.resetLocal()
        OwnerReviewGate.clearOwnerDevicePaired()
        isPaired = false
        localDeviceId = ""
        stopPolling()
        clearLiveData()
        isLocked = true
        authNotice = "تم فك ربط هذا الآيفون من لوحة التحكم. أنشئ كود ربط جديداً من الإعدادات لإعادة التفعيل."
        authNoticeIsError = true
        return true
    }

    /// Binds this iPhone using the 8-digit pairing code from `/settings` (`OwnerDeviceAuth v2` + App Attest).
    func pairWithCode(_ rawCode: String) async {
        let trimmed = rawCode.trimmingCharacters(in: .whitespacesAndNewlines)
        if OwnerReviewGate.isDemoCode(trimmed) {
            OwnerReviewGate.shared.openDemoOffline()
            return
        }

        let digits = trimmed.filter(\.isNumber)
        guard digits.count == 8 else {
            authNotice = "أدخل كود الربط المكوّن من 8 أرقام."
            authNoticeIsError = true
            return
        }

        isAuthenticating = true
        authNotice = nil
        authNoticeIsError = false
        defer { isAuthenticating = false }

        do {
            try await client.pair(code: digits)
            isPaired = true
            localDeviceId = (await client.deviceId()) ?? ""
            OwnerReviewGate.markOwnerDevicePaired()
            isLocked = false
            requestPushAuthorization()
            await refreshHome()
            startPolling()
        } catch {
            authNotice = error.localizedDescription
            authNoticeIsError = true
        }
    }

    /// Unlocks using hardware Secure Enclave Face ID (`K_bio`).
    /// Never deletes stored keys on a failed or cancelled Face ID attempt.
    func unlockWithFaceID() async {
        guard !isAuthenticating else { return }
        isAuthenticating = true
        authNotice = nil
        authNoticeIsError = false
        defer { isAuthenticating = false }

        do {
            try await client.unlockWithBiometrics()
            localDeviceId = (await client.deviceId()) ?? ""
            isLocked = false
            requestPushAuthorization()
            await refreshHome()
            startPolling()
        } catch let apiErr as TendaAPIError {
            if await handleServerRevocationIfNeeded(apiErr) { return }
            authNotice = apiErr.localizedDescription
            authNoticeIsError = true
        } catch {
            authNotice = error.localizedDescription
            authNoticeIsError = true
        }
    }

    func lockApp() {
        stopPolling()
        isLocked = true
        authNotice = nil
        authNoticeIsError = false
        if isDemoActive {
            OwnerReviewGate.shared.exitDemo()
        }
        clearLiveData()
    }

    func unbindThisPhone() async {
        if isDemoActive {
            OwnerReviewGate.shared.exitDemo()
            showToast("تم الخروج من وضع المعاينة", isError: false)
            return
        }
        isAuthenticating = true
        defer { isAuthenticating = false }
        do {
            if let token = apnsTokenHex {
                try? await client.registerApns(token: token, environment: apnsEnvironment, bundleId: bundleId, disable: true)
            }
            try await client.releaseDevice()
            OwnerReviewGate.clearOwnerDevicePaired()
            isPaired = false
            localDeviceId = ""
            lockApp()
            authNotice = "تم فك ربط هذا الآيفون بنجاح."
            authNoticeIsError = false
        } catch {
            showToast(error.localizedDescription, isError: true)
        }
    }

    // MARK: - Polling

    func startPolling() {
        stopPolling()
        guard !isLocked || isDemoActive else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(18))
                guard let self, !Task.isCancelled else { break }
                if self.selectedTab == .home && (!self.isLocked || self.isDemoActive) {
                    await self.refreshHome(silent: true)
                }
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    // MARK: - Tab Loaders

    func refreshHome(silent: Bool = false) async {
        if isDemoActive {
            loadAllDemoData()
            return
        }
        if !silent { isLoadingHome = true }
        defer { isLoadingHome = false }
        do {
            let boot = try await client.fetchBootstrap()
            bootstrap = boot
            wanPorts = boot.router.wanPorts
        } catch {
            if await handleServerRevocationIfNeeded(error) { return }
            if !silent { showToast(error.localizedDescription, isError: true) }
        }
    }

    func refreshDevices() async {
        if isDemoActive {
            devices = demoDevices
            wanPorts = TendaDemoFixtures.wanPorts
            return
        }
        isLoadingDevices = true
        defer { isLoadingDevices = false }
        do {
            let payload = try await client.fetchDevices()
            devices = payload.devices
            wanPorts = payload.wanPorts
        } catch {
            if await handleServerRevocationIfNeeded(error) { return }
            showToast(error.localizedDescription, isError: true)
        }
    }

    func loadDeviceDetail(mac: String, range: String) async -> DeviceDetailPayload? {
        if isDemoActive {
            let target = demoDevices.first(where: { $0.mac == mac }) ?? demoDevices[0]
            return TendaDemoFixtures.makeDeviceDetail(device: target, range: range)
        }
        do {
            return try await client.fetchDeviceDetail(mac: mac, range: range)
        } catch {
            if await handleServerRevocationIfNeeded(error) { return nil }
            showToast(error.localizedDescription, isError: true)
            return nil
        }
    }

    func controlDevice(
        mac: String,
        action: String,
        downloadMbps: Double? = nil,
        downloadLimitKbs: Int? = nil,
        uploadLimitKbs: Int? = nil,
        customLabel: String? = nil,
        wanPort: String? = nil,
        dhcpReserved: Bool? = nil
    ) async -> Bool {
        if isDemoActive {
            applyDemoDeviceControl(
                mac: mac,
                action: action,
                downloadMbps: downloadMbps,
                downloadLimitKbs: downloadLimitKbs,
                customLabel: customLabel,
                wanPort: wanPort,
                dhcpReserved: dhcpReserved
            )
            return true
        }

        var payload: [String: Any] = ["mac": mac, "action": action]
        if let downloadMbps { payload["download_mbps"] = downloadMbps }
        if let downloadLimitKbs { payload["download_limit_kbs"] = downloadLimitKbs }
        if let uploadLimitKbs { payload["upload_limit_kbs"] = uploadLimitKbs }
        if let customLabel { payload["custom_label"] = customLabel }
        if let wanPort { payload["wan_port"] = wanPort }
        if let dhcpReserved { payload["dhcp_reserved"] = dhcpReserved }

        do {
            if let updated = try await client.controlDevice(payload: payload) {
                replaceDevice(updated)
            }
            await refreshDevices()
            await refreshHome(silent: true)
            showToast("تم تطبيق التغيير على الراوتر", isError: false)
            return true
        } catch {
            if await handleServerRevocationIfNeeded(error) { return false }
            showToast(error.localizedDescription, isError: true)
            return false
        }
    }

    func refreshSecurity() async {
        if isDemoActive {
            security = TendaDemoFixtures.makeSecurity(nsfwEnabled: demoNsfwEnabled, alerts: demoAlerts)
            return
        }
        isLoadingSecurity = true
        defer { isLoadingSecurity = false }
        do {
            security = try await client.fetchSecurity()
        } catch {
            if await handleServerRevocationIfNeeded(error) { return }
            showToast(error.localizedDescription, isError: true)
        }
    }

    func setNsfwEnabled(_ enabled: Bool) async {
        if isDemoActive {
            demoNsfwEnabled = enabled
            security = TendaDemoFixtures.makeSecurity(nsfwEnabled: demoNsfwEnabled, alerts: demoAlerts)
            settings = TendaDemoFixtures.makeSettings(nsfwEnabled: demoNsfwEnabled, guestWifi: demoGuestWifi)
            showToast(enabled ? "تم تفعيل فلتر المحتوى" : "تم إيقاف فلتر المحتوى", isError: false)
            return
        }
        do {
            try await client.setNsfwEnabled(enabled)
            security?.nsfw.enabled = enabled
            settings?.nsfwEnabled = enabled
            showToast(enabled ? "تم تفعيل فلتر المحتوى" : "تم إيقاف فلتر المحتوى", isError: false)
        } catch {
            if await handleServerRevocationIfNeeded(error) { return }
            showToast(error.localizedDescription, isError: true)
        }
    }

    func ackAlert(id: Int? = nil, action: String? = nil) async {
        if isDemoActive {
            let now = Date().timeIntervalSince1970 * 1000.0
            if action == "dismiss_all" {
                for i in demoAlerts.indices { demoAlerts[i].dismissedAt = now }
            } else if let id, let idx = demoAlerts.firstIndex(where: { $0.id == id }) {
                demoAlerts[idx].dismissedAt = now
            }
            loadAllDemoData()
            showToast("تم تحديث التنبيهات", isError: false)
            return
        }
        var body: [String: Any] = [:]
        if let id { body["id"] = id }
        if let action { body["action"] = action }
        do {
            try await client.ackAlert(payload: body)
            await refreshSecurity()
            await refreshHome(silent: true)
            showToast("تم تأكيد التنبيه", isError: false)
        } catch {
            if await handleServerRevocationIfNeeded(error) { return }
            showToast(error.localizedDescription, isError: true)
        }
    }

    func refreshAnalytics(reportDays: Int = 7) async {
        if isDemoActive {
            consumption = TendaDemoFixtures.makeConsumption(devices: demoDevices)
            networkMap = TendaDemoFixtures.makeMap(devices: demoDevices)
            outages = TendaDemoFixtures.outages
            report = TendaDemoFixtures.makeReport(days: reportDays, devices: demoDevices)
            return
        }
        isLoadingAnalytics = true
        defer { isLoadingAnalytics = false }
        async let cRes: Result<ConsumptionPayload, Error> = {
            do { return .success(try await client.fetchConsumption()) } catch { return .failure(error) }
        }()
        async let mRes: Result<NetworkMapPayload, Error> = {
            do { return .success(try await client.fetchMap()) } catch { return .failure(error) }
        }()
        async let oRes: Result<OutagesPayload, Error> = {
            do { return .success(try await client.fetchOutages()) } catch { return .failure(error) }
        }()
        async let rRes: Result<ReportPayload, Error> = {
            do { return .success(try await client.fetchReport(days: reportDays)) } catch { return .failure(error) }
        }()
        let (c, m, o, r) = await (cRes, mRes, oRes, rRes)
        var firstError: Error? = nil
        switch c { case .success(let v): consumption = v; case .failure(let e): firstError = firstError ?? e }
        switch m { case .success(let v): networkMap = v; case .failure(let e): firstError = firstError ?? e }
        switch o { case .success(let v): outages = v; case .failure(let e): firstError = firstError ?? e }
        switch r { case .success(let v): report = v; case .failure(let e): firstError = firstError ?? e }
        if let err = firstError {
            if await handleServerRevocationIfNeeded(err) { return }
            if consumption == nil && networkMap == nil && outages == nil && report == nil {
                showToast(err.localizedDescription, isError: true)
            }
        }
    }

    func refreshReport(days: Int) async {
        if isDemoActive {
            report = TendaDemoFixtures.makeReport(days: days, devices: demoDevices)
            return
        }
        do {
            report = try await client.fetchReport(days: days)
        } catch {
            if await handleServerRevocationIfNeeded(error) { return }
            showToast(error.localizedDescription, isError: true)
        }
    }

    func refreshSettings() async {
        if isDemoActive {
            settings = TendaDemoFixtures.makeSettings(nsfwEnabled: demoNsfwEnabled, guestWifi: demoGuestWifi)
            return
        }
        isLoadingSettings = true
        defer { isLoadingSettings = false }
        do {
            settings = try await client.fetchSettings()
        } catch {
            if await handleServerRevocationIfNeeded(error) { return }
            showToast(error.localizedDescription, isError: true)
        }
    }

    func toggleNotificationType(key: String, enabled: Bool) async {
        if isDemoActive {
            if var cur = settings, let idx = cur.notificationTypes.firstIndex(where: { $0.key == key }) {
                cur.notificationTypes[idx].enabled = enabled
                settings = cur
            }
            showToast("تم حفظ إعدادات الإشعارات", isError: false)
            return
        }
        do {
            try await client.updateSettings(payload: [
                "action": "set_notification_type",
                "type": key,
                "enabled": enabled,
            ])
            await refreshSettings()
        } catch {
            if await handleServerRevocationIfNeeded(error) { return }
            showToast(error.localizedDescription, isError: true)
        }
    }

    func saveThresholds(_ thresholds: ThresholdConfigPayload) async -> Bool {
        if isDemoActive {
            settings?.thresholds = thresholds
            showToast("تم حفظ حدود التنبيه (معاينة)", isError: false)
            return true
        }
        do {
            try await client.updateSettings(payload: [
                "action": "save_thresholds",
                "totalEnabled": thresholds.totalEnabled,
                "totalLimitBytes": Int64(thresholds.totalLimitBytes.rounded()),
                "totalPeriod": thresholds.totalPeriod,
                "deviceEnabled": thresholds.deviceEnabled,
                "deviceDefaultLimitBytes": Int64(thresholds.deviceDefaultLimitBytes.rounded()),
                "deviceDefaultPeriod": thresholds.deviceDefaultPeriod,
            ])
            await refreshSettings()
            showToast("تم حفظ حدود التنبيه بنجاح", isError: false)
            return true
        } catch {
            if await handleServerRevocationIfNeeded(error) { return false }
            showToast(error.localizedDescription, isError: true)
            return false
        }
    }

    func performRouterAction(_ action: String, enabled: Bool? = nil) async {
        if isDemoActive {
            if action == "toggle_guest_wifi", let enabled {
                demoGuestWifi = enabled
                settings = TendaDemoFixtures.makeSettings(nsfwEnabled: demoNsfwEnabled, guestWifi: demoGuestWifi)
                showToast(enabled ? "تم تفعيل شبكة الضيوف (معاينة)" : "تم إيقاف شبكة الضيوف (معاينة)", isError: false)
            } else if action == "reboot" {
                showToast("تم إرسال أمر إعادة التشغيل (معاينة)", isError: false)
            } else {
                loadAllDemoData()
                showToast("تم تحديث القراءات", isError: false)
            }
            return
        }
        do {
            try await client.performRouterAction(action, enabled: enabled)
            let msg: String
            switch action {
            case "reboot": msg = "تم إرسال أمر إعادة تشغيل الراوتر بنجاح"
            case "toggle_guest_wifi": msg = (enabled ?? false) ? "تم تفعيل شبكة الضيوف" : "تم إيقاف شبكة الضيوف"
            default: msg = "تم تحديث قراءات الراوتر بنجاح"
            }
            showToast(msg, isError: false)
            await refreshHome(silent: true)
            await refreshSettings()
        } catch {
            if await handleServerRevocationIfNeeded(error) { return }
            showToast(error.localizedDescription, isError: true)
        }
    }

    // MARK: - Helpers

    func showToast(_ message: String, isError: Bool) {
        toastTask?.cancel()
        toastMessage = message
        toastIsError = isError
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3.2))
            guard let self, !Task.isCancelled else { return }
            self.toastMessage = nil
        }
    }

    private func replaceDevice(_ updated: TendaDevice) {
        if let idx = devices.firstIndex(where: { $0.mac == updated.mac }) {
            devices[idx] = updated
        }
    }

    private func loadAllDemoData() {
        devices = demoDevices
        wanPorts = TendaDemoFixtures.wanPorts
        bootstrap = TendaDemoFixtures.makeBootstrap(devices: demoDevices, alerts: demoAlerts)
        security = TendaDemoFixtures.makeSecurity(nsfwEnabled: demoNsfwEnabled, alerts: demoAlerts)
        consumption = TendaDemoFixtures.makeConsumption(devices: demoDevices)
        outages = TendaDemoFixtures.outages
        networkMap = TendaDemoFixtures.makeMap(devices: demoDevices)
        report = TendaDemoFixtures.makeReport(days: 7, devices: demoDevices)
        settings = TendaDemoFixtures.makeSettings(nsfwEnabled: demoNsfwEnabled, guestWifi: demoGuestWifi)
    }

    private func clearLiveData() {
        bootstrap = nil
        devices = []
        wanPorts = []
        security = nil
        consumption = nil
        outages = nil
        networkMap = nil
        report = nil
        settings = nil
    }

    private func applyDemoDeviceControl(
        mac: String,
        action: String,
        downloadMbps: Double?,
        downloadLimitKbs: Int?,
        customLabel: String?,
        wanPort: String?,
        dhcpReserved: Bool?
    ) {
        guard let idx = demoDevices.firstIndex(where: { $0.mac == mac }) else { return }
        switch action {
        case "block":
            demoDevices[idx].isBlocked = true
            demoDevices[idx].isLimited = false
            demoDevices[idx].downloadLimitKbs = 1
            demoDevices[idx].uploadLimitKbs = 1
            showToast("تم حظر الجهاز (معاينة)", isError: false)
        case "unblock":
            demoDevices[idx].isBlocked = false
            demoDevices[idx].isLimited = false
            demoDevices[idx].downloadLimitKbs = 0
            demoDevices[idx].uploadLimitKbs = 0
            showToast("تم فك الحظر (معاينة)", isError: false)
        case "speed_limit":
            let kbs = downloadLimitKbs ?? Int(((downloadMbps ?? 0) * 128.0).rounded())
            demoDevices[idx].isBlocked = false
            demoDevices[idx].isLimited = kbs > 0
            demoDevices[idx].downloadLimitKbs = kbs
            demoDevices[idx].uploadLimitKbs = kbs == 0 ? 0 : max(64, Int(Double(kbs) * 0.4))
            showToast("تم تحديث حد السرعة (معاينة)", isError: false)
        case "rename":
            if let customLabel, !customLabel.trimmingCharacters(in: .whitespaces).isEmpty {
                demoDevices[idx].customLabel = customLabel
                demoDevices[idx].label = customLabel
                showToast("تم حفظ الاسم الجديد", isError: false)
            }
        case "wan_bind":
            demoDevices[idx].wanPort = (wanPort == "auto") ? nil : wanPort
            showToast("تم تحديث خط الـ WAN", isError: false)
        case "dhcp_reserve":
            if let dhcpReserved { demoDevices[idx].reserved = dhcpReserved }
            showToast("تم تحديث تثبيت الـ IP", isError: false)
        case "mark_known":
            demoDevices[idx].isNew = false
            showToast("تم تعليم الجهاز كمعروف", isError: false)
        default:
            break
        }
        loadAllDemoData()
    }

    // MARK: - APNs

    private var apnsEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    private var bundleId: String {
        Bundle.main.bundleIdentifier ?? "com.tveg.tendavault"
    }

    private func requestPushAuthorization() {
        guard !isDemoActive else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    private func syncApnsTokenIfReady(_ token: String) async {
        guard !isLocked, !isDemoActive else { return }
        try? await client.registerApns(token: token, environment: apnsEnvironment, bundleId: bundleId)
    }

    /// Routes APNs push taps (`url`: `/devices/<mac>`, `/security`, `/attacks`, `/outages`, `/analytics`, `/settings`)
    /// to the exact tab and (for device alerts) directly opens that device's `DeviceDetailSheet`.
    func applyPushDeepLink(_ link: TendaPushLink) {
        let rawUrl = link.url.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowerUrl = rawUrl.lowercased()
        let lowerKind = link.kind.lowercased()

        // Extract MAC from explicit payload or `/devices/<encoded_mac>` path
        var targetMac = link.mac.trimmingCharacters(in: .whitespacesAndNewlines)
        if targetMac.isEmpty, let range = lowerUrl.range(of: "/devices/") {
            let tail = String(rawUrl[range.upperBound...])
            let rawSeg = tail.split(separator: "?").first.map(String.init) ?? tail
            let cleanSeg = rawSeg.split(separator: "#").first.map(String.init) ?? rawSeg
            targetMac = (cleanSeg.removingPercentEncoding ?? cleanSeg).trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        }

        if !targetMac.isEmpty {
            selectedTab = .devices
            deepLinkDeviceMac = targetMac.lowercased()
            if !isLocked || isDemoActive {
                Task { await refreshDevices() }
            }
            return
        }

        if lowerUrl.contains("/security") || lowerUrl.contains("/attacks") || lowerUrl.contains("/outages")
            || lowerKind.contains("security") || lowerKind.contains("nsfw") || lowerKind.contains("attack") || lowerKind.contains("outage") || lowerKind.contains("reboot") {
            selectedTab = .security
            if !isLocked || isDemoActive {
                Task { await refreshSecurity() }
            }
        } else if lowerUrl.contains("/analytics") || lowerKind.contains("download") || lowerKind.contains("threshold") {
            selectedTab = .analytics
            if !isLocked || isDemoActive {
                Task { await refreshAnalytics() }
            }
        } else if lowerUrl.contains("/settings") {
            selectedTab = .settings
        } else if lowerUrl.contains("/devices") || lowerKind.contains("device") {
            selectedTab = .devices
            if !isLocked || isDemoActive {
                Task { await refreshDevices() }
            }
        } else {
            selectedTab = .home
            if !isLocked || isDemoActive {
                Task { await refreshHome(silent: true) }
            }
        }
    }
}
