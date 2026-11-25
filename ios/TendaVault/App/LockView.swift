import SwiftUI

/// Lock & Pairing screen (`OwnerDeviceAuth v2`).
/// - Transparent 3D `BrandMark` (ZERO opaque card box).
/// - Paired device: Face ID ONLY (`K_bio` biometric unlock; single clean CTA).
/// - Unpaired / Fresh install: clean 8-digit pairing code field.
///   (`ReviewSwitch` appends `OwnerReviewForm` offline `DEMO-2026` disclosure below on fresh installs.)
struct LockView: View {
    @EnvironmentObject private var store: TendaStore
    @State private var pairCode: String = ""
    @FocusState private var codeFocused: Bool

    var body: some View {
        ZStack {
            AuroraBackdrop()

            ScrollView {
                VStack(spacing: 24) {
                    Spacer(minLength: 32)

                    // Transparent 3D BrandMark floating over subtle ambient aura (ZERO opaque box)
                    ZStack {
                        Circle()
                            .fill(
                                RadialGradient(
                                    colors: [
                                        Aurora.violet.opacity(0.32),
                                        Aurora.coral.opacity(0.18),
                                        .clear,
                                    ],
                                    center: .center,
                                    startRadius: 12,
                                    endRadius: 88
                                )
                            )
                            .frame(width: 176, height: 176)

                        Image("BrandMark")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 112, height: 112)
                            .accessibilityLabel("شعار تندا")
                    }

                    VStack(spacing: 8) {
                        Text("تندا")
                            .font(.largeTitle.weight(.bold))
                            .foregroundStyle(Aurora.ink)

                        Text(
                            store.isPaired
                                ? "التطبيق مربوط بهذا الآيفون. افتح الخزنة ببصمة الوجه."
                                : "أدخل كود الربط من لوحة التحكم لربط هذا الآيفون حصرياً."
                        )
                        .font(.subheadline)
                        .foregroundStyle(Aurora.inkSecondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 12)

                    if let notice = store.authNotice, !notice.isEmpty {
                        HStack(spacing: 8) {
                            Image(systemName: store.authNoticeIsError ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
                                .foregroundStyle(store.authNoticeIsError ? Aurora.coral : Aurora.mint)
                            Text(notice)
                                .font(.footnote)
                                .foregroundStyle(store.authNoticeIsError ? Aurora.coral : Aurora.mint)
                                .multilineTextAlignment(.leading)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            (store.authNoticeIsError ? Aurora.coral : Aurora.mint).opacity(0.12),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder((store.authNoticeIsError ? Aurora.coral : Aurora.mint).opacity(0.32), lineWidth: 1)
                        )
                    }

                    if store.isPaired {
                        pairedUnlockSection
                    } else {
                        unpairedPairingSection
                    }

                    HStack(spacing: 6) {
                        Image(systemName: "lock.shield.fill")
                            .font(.caption)
                            .foregroundStyle(Aurora.mint)
                        Text("مفاتيح Secure Enclave لا تغادر هذا الآيفون أبداً")
                            .font(.caption)
                            .foregroundStyle(Aurora.inkMuted)
                    }
                    .padding(.top, 4)

                    Spacer(minLength: 16)
                }
                .padding(.horizontal, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .onAppear {
            Task { await store.refreshPairingState() }
        }
    }

    // MARK: - Paired: Face ID ONLY

    private var pairedUnlockSection: some View {
        VStack(spacing: 14) {
            Button {
                Task { await store.unlockWithFaceID() }
            } label: {
                HStack(spacing: 10) {
                    if store.isAuthenticating {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Image(systemName: "faceid")
                            .font(.title3.weight(.semibold))
                    }
                    Text(store.isAuthenticating ? "جاري التحقق..." : "فتح ببصمة الوجه")
                        .font(.headline.weight(.semibold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 54)
                .background(Aurora.brandGradient, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .shadow(color: Aurora.coral.opacity(0.30), radius: 14, y: 6)
            }
            .disabled(store.isAuthenticating)

            if !store.localDeviceId.isEmpty {
                StatusPill(
                    text: "ID: \(store.localDeviceId.prefix(10))…",
                    icon: "cpu",
                    tint: Aurora.violet,
                    forceLTR: true
                )
            }
        }
    }

    // MARK: - Unpaired: 8-Digit Pairing Code (`OwnerDeviceAuth v2`)

    private var unpairedPairingSection: some View {
        AuroraCard(accent: Aurora.violet) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Label("كود الربط (8 أرقام)", systemImage: "key.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Aurora.ink)
                    Spacer()
                    StatusPill(text: "v2", tint: Aurora.mint, forceLTR: true)
                }

                Text("افتح الإعدادات في لوحة تندا واضغط «إنشاء كود ربط (10 دقائق)» ثم اكتب الأرقام هنا.")
                    .font(.caption)
                    .foregroundStyle(Aurora.inkSecondary)

                TextField("0000 0000", text: $pairCode)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .focused($codeFocused)
                    .font(.title2.monospaced().weight(.bold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Aurora.ink)
                    .padding(.vertical, 14)
                    .padding(.horizontal, 12)
                    .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(codeFocused ? Aurora.mint : Aurora.borderStrong, lineWidth: 1.2)
                    )
                    .environment(\.layoutDirection, .leftToRight)
                    .onChange(of: pairCode) { _, newValue in
                        let digits = String(newValue.filter(\.isNumber).prefix(8))
                        let formatted = digits.count > 4
                            ? "\(digits.prefix(4)) \(digits.dropFirst(4))"
                            : digits
                        if formatted != newValue {
                            pairCode = formatted
                        }
                    }

                Button {
                    codeFocused = false
                    Task { await store.pairWithCode(pairCode) }
                } label: {
                    HStack(spacing: 8) {
                        if store.isAuthenticating {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "iphone.radiowaves.left.and.right")
                        }
                        Text(store.isAuthenticating ? "جاري الربط..." : "ربط الآيفون الآن")
                            .font(.headline.weight(.semibold))
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(Aurora.brandGradient, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .disabled(store.isAuthenticating || pairCode.filter(\.isNumber).count < 8)
                .opacity(pairCode.filter(\.isNumber).count < 8 ? 0.55 : 1.0)
            }
        }
    }
}
