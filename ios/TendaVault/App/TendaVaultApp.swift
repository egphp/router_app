import SwiftUI

@main
struct TendaVaultApp: App {
    @UIApplicationDelegateAdaptor(VaultAppDelegate.self) private var appDelegate
    @StateObject private var store = TendaStore()

    var body: some Scene {
        WindowGroup {
            RootContainerView()
                .environmentObject(store)
                .environment(\.layoutDirection, .rightToLeft)
                .environment(\.locale, Locale(identifier: "ar_EG@numbers=latn"))
                .preferredColorScheme(.dark)
                .tint(Aurora.mint)
        }
    }
}

private struct RootContainerView: View {
    @EnvironmentObject private var store: TendaStore
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ReviewSwitch(locked: store.isLocked, isPaired: store.isPaired) {
            LockView()
        } openContent: {
            MainTabView()
        }
        .background(Aurora.canvas.ignoresSafeArea())
        .overlay(alignment: .top) {
            if let message = store.toastMessage {
                HStack(spacing: 8) {
                    Image(systemName: store.toastIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                        .foregroundStyle(store.toastIsError ? Aurora.coral : Aurora.mint)
                    Text(message)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Aurora.ink)
                        .lineLimit(2)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(Aurora.surface2, in: Capsule())
                .overlay(
                    Capsule()
                        .strokeBorder((store.toastIsError ? Aurora.coral : Aurora.mint).opacity(0.42), lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
                .padding(.top, 10)
                .padding(.horizontal, 16)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.22), value: store.toastMessage)
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                if !store.isLocked || store.isDemoActive {
                    store.startPolling()
                    Task { await store.refreshHome(silent: true) }
                }
            case .inactive, .background:
                store.stopPolling()
            @unknown default:
                break
            }
        }
    }
}

private struct MainTabView: View {
    @EnvironmentObject private var store: TendaStore

    var body: some View {
        TabView(selection: $store.selectedTab) {
            HomeTabView()
                .tag(AppTab.home)
                .tabItem {
                    Label("الرئيسية", systemImage: "waveform.path.ecg")
                }

            DevicesTabView()
                .tag(AppTab.devices)
                .tabItem {
                    Label("الأجهزة", systemImage: "laptopcomputer.and.iphone")
                }

            SecurityTabView()
                .tag(AppTab.security)
                .tabItem {
                    Label("الحماية", systemImage: "shield.lefthalf.filled")
                }
                .badge(store.bootstrap?.counts.alertsUndismissed ?? 0)

            AnalyticsTabView()
                .tag(AppTab.analytics)
                .tabItem {
                    Label("التحليلات", systemImage: "chart.bar.xaxis")
                }

            SettingsTabView()
                .tag(AppTab.settings)
                .tabItem {
                    Label("الإعدادات", systemImage: "gearshape.fill")
                }
        }
        .toolbarBackground(Aurora.surface1, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .toolbarColorScheme(.dark, for: .tabBar)
        .task {
            if store.bootstrap == nil {
                await store.refreshHome()
            }
            store.startPolling()
        }
    }
}
