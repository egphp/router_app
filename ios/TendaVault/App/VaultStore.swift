import AuthenticationServices
import Foundation
import LocalAuthentication
import UIKit
import UserNotifications

extension Notification.Name {
    static let apnsToken = Notification.Name("tendavault.apnsToken")
}

final class VaultAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(name: .apnsToken, object: hex)
    }
}

final class WebAuthPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first ?? ASPresentationAnchor()
    }
}

@MainActor
final class VaultStore: ObservableObject {
    enum Phase: Equatable {
        case locked
        case working
        case ready
    }

    @Published var phase: Phase = .locked
    @Published var demo = false
    @Published var notice: String?
    @Published var statusLine = "غير متصل"
    @Published var connected = false
    @Published var alertCount = 0
    @Published var bytesDown = "0"
    @Published var bytesUp = "0"
    @Published var online = "0"
    @Published var uptime = "—"
    @Published var speeds: [Double] = []
    @Published var devices: [VaultDevice] = []
    @Published var alerts: [VaultAlert] = []
    @Published var tab = 0

    let api: VaultAPI
    private let presenter = WebAuthPresenter()
    private var authSession: ASWebAuthenticationSession?
    private var poll: Task<Void, Never>?
    private var authFailures = 0
    private var pushToken: String?

    init() {
        let fixture = ProcessInfo.processInfo.arguments.contains("-demo")
        demo = fixture
        api = VaultAPI(demo: fixture)
        if fixture {
            phase = .ready
            loadDemo()
        }
        NotificationCenter.default.addObserver(forName: .apnsToken, object: nil, queue: .main) { [weak self] note in
            guard let token = note.object as? String else { return }
            Task { @MainActor in
                self?.pushToken = token
                await self?.registerPush(token)
            }
        }
    }

    func unlockSaved() async {
        guard let saved = SessionKeychain.load() else {
            notice = "لا توجد جلسة. ادخل بالبصمة أولاً."
            return
        }
        let ok = await localBiometric(reason: "فتح خزنة الشبكة")
        guard ok else { return }
        api.cookie = saved
        phase = .ready
        demo = false
        await refreshHome()
        askNotifications()
    }

    func signInWithPasskey() async {
        phase = .working
        notice = nil
        guard let url = URL(string: "https://tv-eg.com:2055/login?next=/api/auth/native/handoff") else { return }
        do {
            let callback = try await webAuth(url)
            guard let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "code" })?.value else {
                throw VaultError.server(401, "البصمة لم ترجع رمز الجلسة")
            }
            let cookie = try await api.exchange(code: code)
            SessionKeychain.save(cookie)
            authFailures = 0
            demo = false
            phase = .ready
            await refreshHome()
            askNotifications()
        } catch let error as VaultError {
            phase = .locked
            notice = error.localizedDescription
        } catch {
            phase = .locked
            let text = error.localizedDescription
            notice = text.isEmpty ? "تم إلغاء البصمة" : text
        }
    }

    func enterDemo() async {
        if !ProcessInfo.processInfo.arguments.contains("-demo") {
            let ok = await localBiometric(reason: "فتح معاينة المراجعة")
            if !ok, notice == "تم الإلغاء" { return }
        }
        demo = true
        api.cookie = nil
        phase = .ready
        loadDemo()
    }

    func lock() {
        poll?.cancel()
        phase = .locked
        devices = []
        alerts = []
        speeds = []
    }

    func forget() async {
        if let token = pushToken, !demo {
            _ = try? await api.sendJSON("/api/push/apns", method: "POST", body: [
                "token": token, "action": "disable", "environment": environment, "bundleId": bundle,
            ])
            _ = try? await api.sendJSON("/api/auth/logout", method: "POST", body: [:])
        }
        SessionKeychain.clear()
        api.cookie = nil
        lock()
    }

    func refreshHome() async {
        if demo {
            loadDemo()
            return
        }
        do {
            async let statusData = api.get("/api/status")
            async let liveData = api.get("/api/live?minutes=60")
            async let deviceData = api.get("/api/devices?live=1")
            let status = JSONRows.object(try await statusData)
            let live = JSONRows.object(try await liveData)
            devices = JSONRows.devices(from: try await deviceData)
            connected = (status["connected"] as? Bool) ?? false
            statusLine = connected ? "مباشر" : "الراوتر غير متصل"
            alertCount = Int(JSONRows.number(status["alerts"]))
            bytesDown = L.bytes(JSONRows.number(status["bytes_today_down"]))
            bytesUp = L.bytes(JSONRows.number(status["bytes_today_up"]))
            online = L.int(Int(JSONRows.number(status["online_count"])))
            let seconds = JSONRows.number(status["uptime_sec"])
            uptime = seconds > 0 ? "\(L.int(Int(seconds / 3600))) س" : "—"
            let points = (live["speeds"] as? [[String: Any]]) ?? []
            speeds = points.suffix(24).map { JSONRows.number($0["down_bps"]) }
            authFailures = 0
            notice = nil
        } catch let error as VaultError {
            handle(error)
        } catch {
            notice = "تعذّر تحديث الرئيسية"
        }
    }

    func refreshAlerts() async {
        if demo {
            alerts = DemoVault.alerts
            return
        }
        do {
            alerts = JSONRows.alerts(from: try await api.get("/api/alerts"))
        } catch let error as VaultError {
            handle(error)
        } catch {
            notice = "تعذّر قراءة التنبيهات"
        }
    }

    func load(_ path: String) async -> [DisplayRow] {
        if demo { return [DisplayRow(title: "عينة مراجعة", subtitle: path, fields: [("ملاحظة", "هذه بيانات وهمية ولا تصل إلى الراوتر")])] }
        do {
            return JSONRows.rows(from: try await api.get(path))
        } catch let error as VaultError {
            handle(error)
            return []
        } catch {
            notice = "تعذّر التحميل"
            return []
        }
    }

    func mutate(_ path: String, method: String, body: [String: Any]) async -> Bool {
        if demo {
            notice = "المعاينة لا تغيّر الراوتر"
            return false
        }
        do {
            _ = try await api.sendJSON(path, method: method, body: body)
            notice = nil
            return true
        } catch let error as VaultError {
            handle(error)
            return false
        } catch {
            notice = "تعذّر تنفيذ الطلب"
            return false
        }
    }

    func startPolling() {
        poll?.cancel()
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard let self, self.phase == .ready, self.tab == 0 else { continue }
                await self.refreshHome()
            }
        }
    }

    func stopPolling() { poll?.cancel() }

    private func loadDemo() {
        connected = true
        statusLine = "معاينة مراجعة"
        alertCount = DemoVault.alerts.count
        bytesDown = L.bytes(1_630_000_000)
        bytesUp = L.bytes(93_000_000)
        online = "2"
        uptime = "36 س"
        speeds = [200_000, 800_000, 1_400_000, 2_400_000, 900_000, 300_000]
        devices = DemoVault.devices
        alerts = DemoVault.alerts
    }

    private func handle(_ error: VaultError) {
        if case .server(401, _) = error {
            authFailures += 1
            if authFailures >= 2 {
                api.cookie = nil
                SessionKeychain.clear()
                phase = .locked
                notice = "الجلسة رُفضت من الخادم مرتين"
            } else {
                notice = "الخادم رفض الجلسة مرة. أعد المحاولة."
            }
            return
        }
        notice = error.localizedDescription
    }

    private func localBiometric(reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        let policy: LAPolicy = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
            ? .deviceOwnerAuthenticationWithBiometrics
            : .deviceOwnerAuthentication
        if error != nil && policy == .deviceOwnerAuthentication {
            let code = LAError.Code(rawValue: error?.code ?? 0)
            if code == .biometryNotEnrolled || code == .passcodeNotSet {
                return true
            }
        }
        do {
            let ok = try await context.evaluatePolicy(policy, localizedReason: reason)
            return ok
        } catch let la as LAError where la.code == .userCancel || la.code == .appCancel || la.code == .systemCancel {
            notice = "تم الإلغاء"
            return false
        } catch {
            notice = "تعذّر التحقق المحلي"
            return false
        }
    }

    private func webAuth(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "tendavault") { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(throwing: VaultError.cancelled)
                }
            }
            session.presentationContextProvider = presenter
            session.prefersEphemeralWebBrowserSession = true
            authSession = session
            if !session.start() {
                continuation.resume(throwing: VaultError.network("تعذّر فتح شاشة البصمة"))
            }
        }
    }

    private func askNotifications() {
        guard !demo else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
            guard ok else { return }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    private var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    private var bundle: String { Bundle.main.bundleIdentifier ?? "com.tveg.tendavault" }

    private func registerPush(_ token: String) async {
        guard phase == .ready, !demo else { return }
        _ = await mutate("/api/push/apns", method: "POST", body: [
            "token": token,
            "environment": environment,
            "bundleId": bundle,
        ])
    }
}
