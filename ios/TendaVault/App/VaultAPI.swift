import Foundation
import Security

enum VaultError: LocalizedError {
    case locked
    case cancelled
    case server(Int, String)
    case network(String)

    var errorDescription: String? {
        switch self {
        case .locked: return "الجلسة مقفلة"
        case .cancelled: return "تم إلغاء البصمة"
        case .server(let code, let message): return "\(message) (\(code))"
        case .network(let message): return message
        }
    }
}

struct SessionCookie: Codable {
    var name: String
    var value: String
    var header: String { "\(name)=\(value)" }
}

enum SessionKeychain {
    private static let service = "com.tveg.tendavault.session"

    static func save(_ cookie: SessionCookie) {
        guard let data = try? JSONEncoder().encode(cookie) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "panel",
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func load() -> SessionCookie? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "panel",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(SessionCookie.self, from: data)
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "panel",
        ]
        SecItemDelete(query as CFDictionary)
    }
}

struct VaultDevice: Identifiable, Hashable {
    var id: String { mac }
    var mac: String
    var label: String
    var ip: String
    var category: String
    var vendor: String
    var online: Bool
    var isNew: Bool
    var downBps: Double
    var upBps: Double
    var bytesToday: Double
    var bytesUpToday: Double
    var downloadLimit: Int
    var uploadLimit: Int
    var reserved: Bool
    var wan: String
    var signal: String
    var extras: [(String, String)]

    static func == (lhs: VaultDevice, rhs: VaultDevice) -> Bool { lhs.mac == rhs.mac && lhs.bytesToday == rhs.bytesToday && lhs.online == rhs.online }
    func hash(into hasher: inout Hasher) { hasher.combine(mac) }
}

struct VaultAlert: Identifiable {
    var id: Int
    var kind: String
    var title: String
    var detail: String
    var when: String
    var dismissed: Bool
    var mac: String
}

struct DisplayRow: Identifiable {
    let id = UUID()
    var title: String
    var subtitle: String
    var fields: [(String, String)]
}

enum DemoVault {
    static let devices: [VaultDevice] = [
        VaultDevice(mac: "AA:BB:CC:00:00:11", label: "جهاز المكتب", ip: "10.0.0.11", category: "computer", vendor: "Sample", online: true, isNew: false, downBps: 2_400_000, upBps: 180_000, bytesToday: 1_200_000_000, bytesUpToday: 80_000_000, downloadLimit: 0, uploadLimit: 0, reserved: true, wan: "WAN1", signal: "", extras: []),
        VaultDevice(mac: "AA:BB:CC:00:00:22", label: "هاتف العينة", ip: "10.0.0.22", category: "phone", vendor: "Sample", online: true, isNew: true, downBps: 640_000, upBps: 40_000, bytesToday: 340_000_000, bytesUpToday: 12_000_000, downloadLimit: 2048, uploadLimit: 512, reserved: false, wan: "WAN2", signal: "-48 dBm", extras: []),
        VaultDevice(mac: "AA:BB:CC:00:00:33", label: "تلفزيون العينة", ip: "10.0.0.33", category: "tv", vendor: "Sample", online: false, isNew: false, downBps: 0, upBps: 0, bytesToday: 90_000_000, bytesUpToday: 1_000_000, downloadLimit: 0, uploadLimit: 0, reserved: false, wan: "", signal: "", extras: []),
    ]

    static let alerts: [VaultAlert] = [
        VaultAlert(id: 1, kind: "new_device", title: "جهاز جديد", detail: "هاتف العينة ظهر على الشبكة", when: "اليوم", dismissed: false, mac: "AA:BB:CC:00:00:22"),
        VaultAlert(id: 2, kind: "attack", title: "محاولة ARP", detail: "عينة مراجعة، ليست حركة حقيقية", when: "اليوم", dismissed: false, mac: ""),
    ]
}

final class VaultAPI {
    let demo: Bool
    private let base = URL(string: "https://tv-eg.com:2055")!
    private let session: URLSession
    var cookie: SessionCookie?

    init(demo: Bool) {
        self.demo = demo
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 25
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        session = URLSession(configuration: config)
    }

    func get(_ path: String) async throws -> Data {
        if demo { return Data("{}".utf8) }
        guard let cookie else { throw VaultError.locked }
        guard let url = URL(string: path, relativeTo: base) else { throw VaultError.network("مسار غير صالح") }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(cookie.header, forHTTPHeaderField: "Cookie")
        request.setValue("https://tv-eg.com:2055", forHTTPHeaderField: "Origin")
        return try await send(request)
    }

    func sendJSON(_ path: String, method: String, body: [String: Any]?) async throws -> Data {
        if demo { return Data("{\"ok\":true}".utf8) }
        guard let cookie else { throw VaultError.locked }
        guard let url = URL(string: path, relativeTo: base) else { throw VaultError.network("مسار غير صالح") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(cookie.header, forHTTPHeaderField: "Cookie")
        request.setValue("https://tv-eg.com:2055", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return try await send(request)
    }

    func exchange(code: String) async throws -> SessionCookie {
        guard let url = URL(string: "https://tv-eg.com:2055/api/auth/native/exchange") else {
            throw VaultError.network("مسار غير صالح")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("https://tv-eg.com:2055", forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])
        let data = try await send(request)
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard let name = obj?["cookieName"] as? String, let value = obj?["sessionCookie"] as? String, !value.isEmpty else {
            throw VaultError.server(401, "لم ترجع الجلسة بعد البصمة")
        }
        let cookie = SessionCookie(name: name, value: value)
        self.cookie = cookie
        return cookie
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw VaultError.network("تعذّر الاتصال بالخزنة")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw VaultError.server(401, "الجلسة انتهت") }
        if !(200..<300).contains(status) {
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = (obj?["error"] as? String) ?? (obj?["message"] as? String) ?? "رفض الخادم الطلب"
            throw VaultError.server(status, message)
        }
        return data
    }
}

enum JSONRows {
    static func object(_ data: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    static func devices(from data: Data) -> [VaultDevice] {
        let root = object(data)
        let list = (root["devices"] as? [[String: Any]]) ?? []
        return list.compactMap(device)
    }

    static func device(_ raw: [String: Any]) -> VaultDevice? {
        guard let mac = string(raw["mac"]), !mac.isEmpty else { return nil }
        let label = string(raw["custom_label"]) ?? string(raw["router_remark"]) ?? string(raw["hostname"]) ?? mac
        var extras: [(String, String)] = []
        for key in ["notes", "os_guess", "device_type", "ai_rationale_ar", "ai_suggested_label"] {
            if let value = string(raw[key]), !value.isEmpty { extras.append((key, value)) }
        }
        return VaultDevice(
            mac: mac,
            label: label,
            ip: string(raw["ip"]) ?? "",
            category: string(raw["category"]) ?? "",
            vendor: string(raw["vendor"]) ?? "",
            online: number(raw["online"]) > 0,
            isNew: number(raw["is_new"]) > 0,
            downBps: number(raw["down_speed_bps"]),
            upBps: number(raw["up_speed_bps"]),
            bytesToday: number(raw["bytes_today"]),
            bytesUpToday: number(raw["bytes_up_today"]),
            downloadLimit: Int(number(raw["download_limit_kbs"])),
            uploadLimit: Int(number(raw["upload_limit_kbs"])),
            reserved: number(raw["reserved"]) > 0,
            wan: string(raw["wan_group_name"]) ?? string(raw["wan_port"]) ?? "",
            signal: raw["wifi_rssi_dbm"] == nil ? "" : "\(L.n(number(raw["wifi_rssi_dbm"]), digits: 0)) dBm",
            extras: extras
        )
    }

    static func alerts(from data: Data) -> [VaultAlert] {
        let root = object(data)
        let list = (root["alerts"] as? [[String: Any]]) ?? []
        return list.compactMap { raw in
            let id = Int(number(raw["id"]))
            guard id > 0 else { return nil }
            let kind = string(raw["kind"]) ?? "alert"
            let label = string(raw["device_label"]) ?? string(raw["mac"]) ?? kind
            let payload = string(raw["payload"]) ?? ""
            return VaultAlert(
                id: id,
                kind: kind,
                title: label,
                detail: payload.isEmpty ? kind : payload,
                when: L.when(number(raw["created_at"])),
                dismissed: raw["dismissed_at"] != nil && !(raw["dismissed_at"] is NSNull) && number(raw["dismissed_at"]) > 0,
                mac: string(raw["mac"]) ?? ""
            )
        }
    }

    static func rows(from data: Data) -> [DisplayRow] {
        let root = object(data)
        if let array = firstArray(in: root) {
            return array.enumerated().map { index, item in
                if let dict = item as? [String: Any] {
                    let pairs = dict.map { ($0.key, present($0.value)) }.sorted { $0.0 < $1.0 }
                    let title = pairs.first(where: { ["label", "name", "hostname", "domain", "kind", "message", "day"].contains($0.0) })?.1
                        ?? pairs.first?.1
                        ?? "سجل \(index + 1)"
                    let subtitle = pairs.first(where: { ["ip", "mac", "category", "severity", "bytes_down", "hits"].contains($0.0) }).map { "\($0.0): \($0.1)" } ?? ""
                    return DisplayRow(title: title, subtitle: subtitle, fields: pairs)
                }
                return DisplayRow(title: present(item), subtitle: "", fields: [])
            }
        }
        let pairs = root.map { ($0.key, present($0.value)) }.sorted { $0.0 < $1.0 }
        return [DisplayRow(title: "النتيجة", subtitle: "", fields: pairs)]
    }

    private static func firstArray(in object: [String: Any]) -> [Any]? {
        for key in ["devices", "alerts", "entries", "outages", "lines", "data", "schedules", "top_domains", "speeds"] {
            if let array = object[key] as? [Any] { return array }
        }
        return object.values.first { $0 is [Any] } as? [Any]
    }

    static func string(_ value: Any?) -> String? {
        if let text = value as? String { return text }
        if value is NSNull || value == nil { return nil }
        if let num = value as? NSNumber { return num.stringValue }
        return nil
    }

    static func number(_ value: Any?) -> Double {
        if let num = value as? NSNumber { return num.doubleValue }
        if let text = value as? String { return Double(text) ?? 0 }
        return 0
    }

    private static func present(_ value: Any) -> String {
        if value is NSNull { return "" }
        if let text = value as? String { return text }
        if let num = value as? NSNumber { return num.stringValue }
        if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) {
            return text
        }
        return String(describing: value)
    }
}
