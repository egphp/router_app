import Foundation
import OwnerDeviceAuth

enum TendaAPIError: LocalizedError {
    case auth(OwnerAuthError)
    case server(Int, String)
    case network(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .auth(let err):
            return Self.arabicMessage(for: err)
        case .server(let status, let msg):
            if !msg.isEmpty { return msg }
            return "رفض الخادم الطلب (\(status))"
        case .network(let msg):
            return msg
        case .decoding(let msg):
            return "تعذّر قراءة رد الخادم: \(msg)"
        }
    }

    var isAuthoritativeServerRevocation: Bool {
        if case .auth(let err) = self {
            return err == .deviceNotBound || err == .deviceMismatch
        }
        return false
    }

    var requiresRepairing: Bool {
        if case .auth(let err) = self { return err.requiresRepairing }
        return false
    }

    static func arabicMessage(for err: OwnerAuthError) -> String {
        switch err {
        case .notPaired, .deviceNotBound:
            return "هذا الآيفون غير مربوط بعد. أدخل كود الربط من صفحة الإعدادات."
        case .biometryCancelled:
            return "تم إلغاء التحقق ببصمة الوجه."
        case .biometryFailed:
            return "لم تنجح بصمة الوجه — أعد المحاولة (لم يتم حذف المفاتيح)."
        case .secureEnclaveUnavailable:
            return "شريحة الأمان غير متاحة على هذا الجهاز."
        case .keychain:
            return "تعذّرت قراءة مفاتيح الحماية حالياً — افتح قفل الجهاز وحاول مجدداً."
        case .invalidPairCode:
            return "كود الربط غير صحيح. تأكد من الأرقام الثمانية وحاول مرة أخرى."
        case .pairCodeExpired:
            return "انتهت صلاحية كود الربط (10 دقائق). أنشئ كوداً جديداً من الإعدادات."
        case .deviceLocked:
            return "توجد جلسة مربوطة مسبقاً — افتح كود ربط جديد من صفحة الإعدادات لاستبدالها."
        case .deviceMismatch:
            return "هذا الجهاز غير مطابق للآيفون المربوط على الخادم."
        case .attestationFailed:
            return "فشل التحقق من شهادة App Attest للجهاز."
        case .rateLimited:
            return "تم تجاوز عدد المحاولات المسموحة — أنشئ كوداً جديداً من الإعدادات."
        case .staleTimestamp:
            return "توقيت الجهاز غير متزامن مع الخادم — حاول مجدداً."
        case .replayedNonce:
            return "طلب مكرر — أعد المحاولة."
        case .badSignature, .invalidToken, .tokenExpired:
            return "انتهت صلاحية التوقيع — أعد التحقق ببصمة الوجه."
        case .challengeExpired, .challengeInvalid:
            return "انتهى رمز التحدي الأمني — حاول مرة أخرى."
        case .transport:
            return "تعذّر الاتصال بخادم تندا. تأكد من اتصالك بالإنترنت."
        case .malformedResponse, .invalidRequest:
            return "استجابة غير صالحة من الخادم."
        case .server(let code, let status):
            return "خطأ من الخادم: \(code) (\(status))"
        }
    }
}

/// Signed OwnerDeviceAuth v2 transport for TendaVault (`https://tv-eg.com:2055/api/native/v2/*`).
/// Strictly blocks all live network traffic whenever `OwnerReviewGate.transportOn` is true.
actor TendaClient {
    static let baseURL = URL(string: "https://tv-eg.com:2055")!
    static let v2Prefix = "/api/native/v2"

    private let session: SessionManager
    private let urlSession: URLSession
    private let decoder = JSONDecoder()

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.waitsForConnectivity = false
        let transportSession = URLSession(configuration: config)
        self.urlSession = transportSession

        let keyStore = KeyStore(
            service: "com.tveg.tendavault.auth.v2",
            mode: .automatic,
            localizedReason: "افتح خزنة تندا ببصمة الوجه"
        )
        let managerConfig = SessionManager.Configuration(
            baseURL: Self.baseURL,
            endpoints: .node(prefix: Self.v2Prefix),
            refreshLeeway: 60,
            requestTimeout: 20
        )
        self.session = SessionManager(
            configuration: managerConfig,
            keyStore: keyStore,
            transport: { request in
                if OwnerReviewGate.transportOn {
                    throw TendaAPIError.network("وضع المعاينة أوفلاين")
                }
                return try await transportSession.data(for: request)
            }
        )
    }

    // MARK: - Auth Lifecycle

    func pairingState() async -> PairingState {
        await session.pairingState
    }

    func isPaired() async -> Bool {
        await session.isPaired
    }

    func deviceId() async -> String? {
        try? await session.deviceId()
    }

    func pair(code: String) async throws {
        guard !OwnerReviewGate.transportOn else { return }
        let digits = code.filter(\.isNumber)
        do {
            try await session.pair(code: digits)
        } catch let err as OwnerAuthError {
            throw TendaAPIError.auth(err)
        } catch {
            throw TendaAPIError.network(error.localizedDescription)
        }
    }

    /// Face ID (`K_bio`) hardware unlock. One failed attempt NEVER wipes stored keys.
    func unlockWithBiometrics() async throws {
        guard !OwnerReviewGate.transportOn else { return }
        do {
            try await session.refreshNow()
        } catch let err as OwnerAuthError {
            throw TendaAPIError.auth(err)
        } catch {
            throw TendaAPIError.network(error.localizedDescription)
        }
    }

    func resetLocal() async {
        try? await session.resetLocal()
    }

    func releaseDevice() async throws {
        guard !OwnerReviewGate.transportOn else { return }
        do {
            try await session.release()
        } catch let err as OwnerAuthError {
            // If server already unbound this device, wipe local keys cleanly so user can pair again.
            if err.requiresRepairing {
                try? await session.resetLocal()
                return
            }
            throw TendaAPIError.auth(err)
        } catch {
            throw TendaAPIError.network(error.localizedDescription)
        }
    }

    // MARK: - Signed Operator Endpoints

    func fetchBootstrap() async throws -> BootstrapPayload {
        try await get("bootstrap")
    }

    func fetchDevices() async throws -> DevicesPayload {
        try await get("devices")
    }

    func fetchDeviceDetail(mac: String, range: String) async throws -> DeviceDetailPayload {
        // Dash-separated MAC uses pure unreserved RFC 3986 path chars so reverse proxies
        // never alter percent-encoding and break X-Dev-Sig path verification.
        let safeMac = mac.uppercased().replacingOccurrences(of: ":", with: "-")
        return try await get("devices/\(safeMac)", query: "range=\(range)")
    }

    func controlDevice(payload: [String: Any]) async throws -> TendaDevice? {
        struct Resp: Codable {
            let ok: Bool
            let device: TendaDevice?
        }
        let resp: Resp = try await post("devices/control", body: payload)
        return resp.device
    }

    func fetchSecurity() async throws -> SecurityPayload {
        try await get("security")
    }

    func setNsfwEnabled(_ enabled: Bool) async throws {
        struct OkResp: Codable { let ok: Bool }
        let _: OkResp = try await post("security/nsfw", body: ["enabled": enabled])
    }

    func ackAlert(payload: [String: Any]) async throws {
        struct OkResp: Codable { let ok: Bool }
        let _: OkResp = try await post("alerts/ack", body: payload)
    }

    func fetchConsumption() async throws -> ConsumptionPayload {
        try await get("consumption")
    }

    func fetchOutages() async throws -> OutagesPayload {
        try await get("outages")
    }

    func fetchMap() async throws -> NetworkMapPayload {
        try await get("map")
    }

    func fetchReport(days: Int) async throws -> ReportPayload {
        try await get("report", query: "days=\(days)")
    }

    func fetchSettings() async throws -> RouterSettingsPayload {
        try await get("settings")
    }

    func updateSettings(payload: [String: Any]) async throws {
        struct OkResp: Codable { let ok: Bool }
        let _: OkResp = try await post("settings", body: payload)
    }

    func performRouterAction(_ action: String, enabled: Bool? = nil) async throws {
        struct OkResp: Codable { let ok: Bool }
        var body: [String: Any] = ["action": action]
        if let enabled { body["enabled"] = enabled }
        let _: OkResp = try await post("router/action", body: body)
    }

    func registerApns(token: String, environment: String, bundleId: String, disable: Bool = false) async throws {
        struct OkResp: Codable { let ok: Bool }
        var body: [String: Any] = [
            "token": token,
            "environment": environment,
            "bundleId": bundleId,
        ]
        if disable { body["action"] = "disable" }
        let _: OkResp = try await post("push/apns", body: body)
    }

    // MARK: - Signed Request Plumbing

    private func get<T: Decodable>(_ subpath: String, query: String? = nil) async throws -> T {
        let req = try buildRequest(method: "GET", subpath: subpath, query: query, body: nil)
        return try await execute(req)
    }

    private func post<T: Decodable>(_ subpath: String, body: [String: Any]) async throws -> T {
        let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        let req = try buildRequest(method: "POST", subpath: subpath, query: nil, body: data)
        return try await execute(req)
    }

    private func buildRequest(method: String, subpath: String, query: String?, body: Data?) throws -> URLRequest {
        guard var comps = URLComponents(url: Self.baseURL, resolvingAgainstBaseURL: false) else {
            throw TendaAPIError.network("عنوان الخادم غير صالح")
        }
        comps.percentEncodedPath = "\(Self.v2Prefix)/\(subpath)"
        comps.percentEncodedQuery = query
        guard let url = comps.url else {
            throw TendaAPIError.network("مسار الطلب غير صالح")
        }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        return req
    }

    private func execute<T: Decodable>(_ request: URLRequest) async throws -> T {
        if OwnerReviewGate.transportOn {
            throw TendaAPIError.network("وضع المعاينة أوفلاين")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.sendSigned(request)
        } catch let err as OwnerAuthError {
            throw TendaAPIError.auth(err)
        } catch {
            throw TendaAPIError.network("تعذّر الاتصال بخادم تندا")
        }

        guard let http = response as? HTTPURLResponse else {
            throw TendaAPIError.network("رد غير معروف من الخادم")
        }

        if !(200..<300).contains(http.statusCode) {
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let code = obj["error"] as? String {
                let mapped = OwnerAuthError(serverCode: code, status: http.statusCode)
                if case .server = mapped {
                    throw TendaAPIError.server(http.statusCode, code)
                }
                throw TendaAPIError.auth(mapped)
            }
            throw TendaAPIError.server(http.statusCode, "رفض الخادم الطلب")
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw TendaAPIError.decoding(error.localizedDescription)
        }
    }
}
