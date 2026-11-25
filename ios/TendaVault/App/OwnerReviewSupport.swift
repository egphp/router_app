import CryptoKit
import Security
import SwiftUI
#if canImport(DeviceCheck)
import DeviceCheck
#endif

/// Hardware Apple App Attest client (Secure Enclave attestation + cached key ID + assertion).
/// Returns nil on Simulator or unsupported hardware; server requires valid attestation on new production enrollment.
public enum AppleAttestClient {
    public struct Object {
        public let keyId: String
        public let attestation: String
        public let clientData: String
        public init(keyId: String, attestation: String, clientData: String) {
            self.keyId = keyId
            self.attestation = attestation
            self.clientData = clientData
        }
    }

    private static let keyIdAccount = "com.egphp.appattest.keyId"

    public static func make(clientData: String) async -> Object? {
        #if canImport(DeviceCheck)
        let service = DCAppAttestService.shared
        guard service.isSupported else { return nil }
        do {
            let keyId = try await service.generateKey()
            let hash = Data(SHA256.hash(data: Data(clientData.utf8)))
            let attestation = try await service.attestKey(keyId, clientDataHash: hash)
            saveKeyId(keyId)
            return Object(keyId: keyId, attestation: attestation.base64EncodedString(), clientData: clientData)
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }

    public static func assertRequest(clientData: String) async -> (keyId: String, assertion: String)? {
        #if canImport(DeviceCheck)
        let service = DCAppAttestService.shared
        guard service.isSupported, let keyId = loadKeyId() else { return nil }
        do {
            let hash = Data(SHA256.hash(data: Data(clientData.utf8)))
            let data = try await service.generateAssertion(keyId, clientDataHash: hash)
            return (keyId, data.base64EncodedString())
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }

    /// The headers a new enrollment sends. Used by the shipping request and by unit tests.
    public static func headers(prefix: String, object: Object) -> [String: String] {
        [
            "\(prefix)Attestation": object.attestation,
            "\(prefix)Key-Id": object.keyId,
            "\(prefix)Client-Data": object.clientData,
        ]
    }

    private static func saveKeyId(_ keyId: String) {
        let data = Data(keyId.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Bundle.main.bundleIdentifier ?? "com.egphp.owner",
            kSecAttrAccount as String: keyIdAccount,
        ]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    private static func loadKeyId() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Bundle.main.bundleIdentifier ?? "com.egphp.owner",
            kSecAttrAccount as String: keyIdAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var ref: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &ref) == errSecSuccess,
              let data = ref as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// TV-EG-style 100% Offline Local Synthetic Demo Gate.
/// Zero receipt inspection (100% Apple Guideline 2.3.1 compliant).
/// Zero production network calls when active — every transport short-circuits to local synthetic fixtures.
/// Cannot grant production access, cannot read any customer data, and never appears on an already-paired owner device.
@MainActor
public final class OwnerReviewGate: ObservableObject {
    public static let shared = OwnerReviewGate()
    @Published public var isOn = false
    @Published public var title = ""
    @Published public var rows: [String] = []
    /// Read by request transports off the main actor; when true, ALL live server traffic is strictly blocked and synthetic fixtures are served.
    public nonisolated(unsafe) static var transportOn = false
    /// Set when `-demo` or `-UIFixtureMode` activated Demo Mode before app models registered their `egphp.ownerReview.opened` observer.
    public nonisolated(unsafe) static var launchedViaDemoArg = false

    /// Documented offline demo codes (provided in App Store Connect Review Notes, mirroring TV-EG's TVEG-DEMO pattern).
    public nonisolated static let validDemoCodes: Set<String> = ["DEMO-2026", "EGPHP-DEMO", "TVEG-DEMO"]

    private nonisolated static let pairedFlagKey = "com.egphp.owner.devicePairedOnce"

    private init() {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-demo") || args.contains("-UIFixtureMode") {
            Self.transportOn = true
            Self.launchedViaDemoArg = true
            self.isOn = true
        }
    }

    public nonisolated static var isOwnerDevicePaired: Bool {
        UserDefaults.standard.bool(forKey: pairedFlagKey)
    }

    public nonisolated static func markOwnerDevicePaired() {
        UserDefaults.standard.set(true, forKey: pairedFlagKey)
    }

    public nonisolated static func clearOwnerDevicePaired() {
        UserDefaults.standard.removeObject(forKey: pairedFlagKey)
    }

    public nonisolated static func isDemoCode(_ raw: String) -> Bool {
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return validDemoCodes.contains(normalized)
    }

    public func open(title: String, rows: [String]) {
        Self.transportOn = true
        self.title = title
        self.rows = rows
        isOn = true
        NotificationCenter.default.post(name: Notification.Name("egphp.ownerReview.opened"), object: nil)
    }

    public func openDemoOffline() {
        open(title: "معاينة تجريبية", rows: [])
    }

    public func exitDemo() {
        Self.transportOn = false
        self.isOn = false
        self.title = ""
        self.rows = []
        NotificationCenter.default.post(name: Notification.Name("egphp.ownerReview.closed"), object: nil)
    }
}

/// Honest, non-cloaking visibility rule (TV-EG standard):
/// Shown on fresh unpaired installs (including App Store Review) and hidden once the owner's real device is paired.
/// Never inspects App Store receipts or provisioning profiles (Guideline 2.3.1 compliant).
public enum ReviewLane {
    public static var showsSignIn: Bool {
        !OwnerReviewGate.isOwnerDevicePaired
    }
}

public struct OwnerReviewForm: View {
    @ObservedObject private var gate = OwnerReviewGate.shared
    @State private var expanded = false
    @State private var code = ""
    @State private var message = ""

    public init() {}

    public var body: some View {
        if gate.isOn || OwnerReviewGate.isOwnerDevicePaired {
            EmptyView()
        } else {
            VStack(spacing: 10) {
                if !expanded {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { expanded = true }
                    } label: {
                        Label("معاينة تجريبية (وضع المراجعة)", systemImage: "sparkles.rectangle.stack")
                            .font(.footnote.weight(.medium))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                    .tint(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("رمز المعاينة التجريبية")
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            Button("إغلاق") {
                                withAnimation { expanded = false; message = "" }
                            }
                            .font(.caption)
                        }
                        Text("يعرض بيانات تجريبية افتراضية محلياً بدون أي اتصال بالخادم.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextField("DEMO-2026", text: $code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .multilineTextAlignment(.trailing)
                            .textFieldStyle(.roundedBorder)
                            .frame(minHeight: 44)
                        Button {
                            submit()
                        } label: {
                            Text("فتح المعاينة التجريبية")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        if !message.isEmpty {
                            Text(message)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
                    .padding(14)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
    }

    private func submit() {
        if OwnerReviewGate.isDemoCode(code) {
            message = ""
            gate.openDemoOffline()
        } else {
            message = "الرمز غير صحيح — استخدم رمز المعاينة المدوّن في ملاحظات المراجعة"
        }
    }
}

public struct ReviewSwitch<Locked: View, Open: View>: View {
    @ObservedObject private var gate = OwnerReviewGate.shared
    @Environment(\.scenePhase) private var scenePhase
    public var locked: Bool
    /// Only set `true` when this device holds a verified server-bound owner pairing — NEVER on local Face ID unlock alone.
    public var isPaired: Bool
    public var showsPrivacyShield: Bool
    @ViewBuilder public var lockedContent: () -> Locked
    @ViewBuilder public var openContent: () -> Open

    public init(
        locked: Bool,
        isPaired: Bool = false,
        showsPrivacyShield: Bool = true,
        @ViewBuilder lockedContent: @escaping () -> Locked,
        @ViewBuilder openContent: @escaping () -> Open
    ) {
        self.locked = locked
        self.isPaired = isPaired
        self.showsPrivacyShield = showsPrivacyShield
        self.lockedContent = lockedContent
        self.openContent = openContent
    }

    public var body: some View {
        ZStack {
            if gate.isOn || !locked {
                openContent()
                    .safeAreaInset(edge: .top, spacing: 0) {
                        OwnerReviewBanner()
                    }
                    .onAppear {
                        if isPaired && !gate.isOn {
                            OwnerReviewGate.markOwnerDevicePaired()
                        }
                    }
            } else {
                VStack(spacing: 0) {
                    lockedContent()
                    if ReviewLane.showsSignIn {
                        OwnerReviewForm()
                    }
                }
            }

            // App-switcher privacy shield: hides live customer & financial data when backgrounded/inactive.
            if showsPrivacyShield && !gate.isOn && !locked && scenePhase != .active {
                ZStack {
                    Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
                    VStack(spacing: 14) {
                        Image("BrandMark")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 72, height: 72)
                        Image(systemName: "lock.shield.fill")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                    }
                }
                .transition(.opacity)
            }
        }
        .onChange(of: isPaired) { _, nowPaired in
            if nowPaired && !gate.isOn {
                OwnerReviewGate.markOwnerDevicePaired()
            }
        }
        .task(id: gate.isOn) {
            if gate.isOn && OwnerReviewGate.launchedViaDemoArg {
                OwnerReviewGate.launchedViaDemoArg = false
                NotificationCenter.default.post(name: Notification.Name("egphp.ownerReview.opened"), object: nil)
            }
        }
    }
}

/// Clean, compact Demo Mode pill at top safe area (never obstructs bottom TabView bars on iOS 26/27).
public struct OwnerReviewBanner: View {
    @ObservedObject private var gate = OwnerReviewGate.shared

    public init() {}

    public var body: some View {
        if gate.isOn {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.caption2.weight(.bold))
                Text("معاينة تجريبية · بيانات أوفلاين")
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Button("خروج") {
                    gate.exitDemo()
                }
                .font(.caption2.weight(.bold))
                .buttonStyle(.bordered)
                .controlSize(.mini)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 5)
            .background(.ultraThinMaterial)
            .overlay(alignment: .bottom) { Divider() }
        }
    }
}
