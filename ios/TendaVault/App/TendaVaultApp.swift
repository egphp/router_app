import SwiftUI

@main
struct TendaVaultApp: App {
    @UIApplicationDelegateAdaptor(VaultAppDelegate.self) private var delegate
    @StateObject private var store = VaultStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environment(\.layoutDirection, .rightToLeft)
                .preferredColorScheme(.dark)
                .tint(Ink.mint)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: VaultStore
    @Environment(\.scenePhase) private var scene

    var body: some View {
        Group {
            if store.phase == .ready {
                MainTabs()
            } else {
                LockView()
            }
        }
        .background(Ink.canvas.ignoresSafeArea())
        .onChange(of: scene) { _, phase in
            if phase == .active, store.phase == .ready {
                store.startPolling()
                Task { await store.refreshHome() }
            } else {
                store.stopPolling()
            }
        }
    }
}

struct LockView: View {
    @EnvironmentObject private var store: VaultStore

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            ZStack {
                Circle().stroke(Ink.mint.opacity(0.45), lineWidth: 1.5).frame(width: 96, height: 96)
                Image(systemName: "touchid")
                    .font(.system(size: 42, weight: .light))
                    .foregroundStyle(Ink.mint)
            }
            VStack(spacing: 6) {
                Text("Tenda Vault")
                    .font(.largeTitle.weight(.semibold))
                Text("الخزنة لا تفتح إلا ببصمة الجهاز المربوط. لا كلمة مرور هنا.")
                    .font(.subheadline)
                    .foregroundStyle(Ink.mist)
                    .multilineTextAlignment(.center)
            }
            if let notice = store.notice {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(Ink.amber)
                    .multilineTextAlignment(.center)
            }
            VStack(spacing: 10) {
                Button {
                    Task {
                        if SessionKeychain.load() != nil {
                            await store.unlockSaved()
                        } else {
                            await store.signInWithPasskey()
                        }
                    }
                } label: {
                    Text(store.phase == .working ? "جاري التحقق" : "الدخول بالبصمة")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.phase == .working)

                if SessionKeychain.load() != nil {
                    Button("بصمة من جديد") { Task { await store.signInWithPasskey() } }
                        .buttonStyle(.bordered)
                }

                Button("معاينة المراجعة") { Task { await store.enterDemo() } }
                    .buttonStyle(.bordered)
            }
            Text("المعاينة بيانات وهمية لمراجعة أبل، ولا تصل إلى الراوتر.")
                .font(.caption)
                .foregroundStyle(Ink.mist)
            Spacer()
        }
        .padding(24)
    }
}

struct MainTabs: View {
    @EnvironmentObject private var store: VaultStore
    @AppStorage("vault.tab") private var savedTab = 0

    var body: some View {
        TabView(selection: $store.tab) {
            HomeView().tag(0).tabItem { Label("الرئيسية", systemImage: "waveform.path.ecg") }
            DevicesView().tag(1).tabItem { Label("الأجهزة", systemImage: "laptopcomputer.and.iphone") }
            AlertsView().tag(2).tabItem { Label("التنبيهات", systemImage: "bell") }
            SecurityHub().tag(3).tabItem { Label("الحماية", systemImage: "shield") }
            MoreView().tag(4).tabItem { Label("المزيد", systemImage: "square.grid.2x2") }
        }
        .onAppear {
            store.tab = savedTab
            Task {
                await store.refreshHome()
                await store.refreshAlerts()
            }
        }
        .onChange(of: store.tab) { _, value in savedTab = value }
    }
}
