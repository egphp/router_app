import Charts
import SwiftUI

enum DeviceFilter: String, CaseIterable, Identifiable {
    case all = "الكل"
    case online = "متصل الآن"
    case blocked = "محظور"
    case limited = "محدد السرعة"

    var id: String { rawValue }
}

/// Tab 2 `الأجهزة` — Devices & Control:
/// - `.searchable` + Filter menu (`الكل`, `متصل الآن`, `محظور`, `محدد السرعة`)
/// - Rich rows with live ↓/↑ speed bar, IP, MAC, total GB, status pill, swipe actions (حظر / تحديد سرعة)
/// - Full `DeviceDetailSheet` with Swift Charts usage graph, Block/Unblock toggle, Speed Cap picker, Rename, History
struct DevicesTabView: View {
    @EnvironmentObject private var store: TendaStore
    @State private var query: String = ""
    @State private var filter: DeviceFilter = .all
    @State private var selectedDevice: TendaDevice? = nil
    @State private var quickLimitTarget: TendaDevice? = nil

    private var filteredDevices: [TendaDevice] {
        let byFilter: [TendaDevice] = store.devices.filter { dev in
            switch filter {
            case .all: return true
            case .online: return dev.online
            case .blocked: return dev.isBlocked
            case .limited: return dev.isLimited
            }
        }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return byFilter }
        return byFilter.filter { dev in
            dev.label.localizedCaseInsensitiveContains(q) ||
            (dev.ip?.localizedCaseInsensitiveContains(q) ?? false) ||
            dev.mac.localizedCaseInsensitiveContains(q) ||
            (dev.vendor?.localizedCaseInsensitiveContains(q) ?? false)
        }
    }

    private var maxLiveBps: Double {
        max(store.devices.map { $0.downSpeedBps + $0.upSpeedBps }.max() ?? 1, 500_000)
    }

    private func openDeepLinkedDeviceIfNeeded() {
        guard let target = store.deepLinkDeviceMac?.lowercased(), !target.isEmpty else { return }
        if let match = store.devices.first(where: { $0.mac.lowercased() == target }) {
            selectedDevice = match
            store.deepLinkDeviceMac = nil
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AuroraBackdrop()

                VStack(spacing: 0) {
                    filterStrip
                    deviceList
                }
            }
            .navigationTitle("الأجهزة")
            .toolbarColorScheme(.dark, for: .navigationBar)
            .searchable(text: $query, prompt: "ابحث بالاسم أو IP أو MAC")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        ForEach(DeviceFilter.allCases) { option in
                            Button {
                                filter = option
                            } label: {
                                if filter == option {
                                    Label(option.rawValue, systemImage: "checkmark")
                                } else {
                                    Text(option.rawValue)
                                }
                            }
                        }
                    } label: {
                        Label(filter.rawValue, systemImage: "line.3.horizontal.decrease.circle")
                            .font(.subheadline)
                            .foregroundStyle(Aurora.mint)
                    }
                }
            }
            .sheet(item: $selectedDevice) { device in
                DeviceDetailSheet(device: device)
                    .environmentObject(store)
            }
            .onAppear { openDeepLinkedDeviceIfNeeded() }
            .onChange(of: store.deepLinkDeviceMac) { _, _ in openDeepLinkedDeviceIfNeeded() }
            .onChange(of: store.devices.count) { _, _ in openDeepLinkedDeviceIfNeeded() }
            .confirmationDialog(
                "تحديد سرعة \(quickLimitTarget?.label ?? "")",
                isPresented: Binding(
                    get: { quickLimitTarget != nil },
                    set: { if !$0 { quickLimitTarget = nil } }
                ),
                titleVisibility: .visible,
                presenting: quickLimitTarget
            ) { target in
                Button("مفتوح (بدون حد)") {
                    Task { _ = await store.controlDevice(mac: target.mac, action: "speed_limit", downloadMbps: 0) }
                }
                ForEach([5.0, 10.0, 15.0, 25.0], id: \.self) { mbps in
                    Button("\(Int(mbps)) Mbps") {
                        Task { _ = await store.controlDevice(mac: target.mac, action: "speed_limit", downloadMbps: mbps) }
                    }
                }
                Button("إلغاء", role: .cancel) {}
            }
            .task {
                if store.devices.isEmpty {
                    await store.refreshDevices()
                }
            }
        }
    }

    private var filterStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(DeviceFilter.allCases) { item in
                    let active = filter == item
                    let count = countFor(item)
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) { filter = item }
                    } label: {
                        HStack(spacing: 5) {
                            Text(item.rawValue)
                            Text("\(count)")
                                .monospacedDigit()
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(active ? Color.white.opacity(0.22) : Aurora.surface3, in: Capsule())
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(active ? .white : Aurora.inkSecondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(active ? Aurora.violet : Aurora.surface1, in: Capsule())
                        .overlay(Capsule().strokeBorder(active ? Aurora.violet : Aurora.border, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }

    private func countFor(_ item: DeviceFilter) -> Int {
        switch item {
        case .all: return store.devices.count
        case .online: return store.devices.filter(\.online).count
        case .blocked: return store.devices.filter(\.isBlocked).count
        case .limited: return store.devices.filter(\.isLimited).count
        }
    }

    private var deviceList: some View {
        List {
            if filteredDevices.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.title)
                        .foregroundStyle(Aurora.inkMuted)
                    Text(store.isLoadingDevices ? "جاري تحميل الأجهزة..." : "لا توجد أجهزة مطابقة للفلتر الحالي")
                        .font(.subheadline)
                        .foregroundStyle(Aurora.inkSecondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 36)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            } else {
                ForEach(filteredDevices) { device in
                    Button {
                        selectedDevice = device
                    } label: {
                        DeviceRowCard(device: device, maxBps: maxLiveBps)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: device.isBlocked ? nil : .destructive) {
                            Task {
                                _ = await store.controlDevice(
                                    mac: device.mac,
                                    action: device.isBlocked ? "unblock" : "block"
                                )
                            }
                        } label: {
                            Label(
                                device.isBlocked ? "فك الحظر" : "حظر",
                                systemImage: device.isBlocked ? "lock.open.fill" : "hand.raised.fill"
                            )
                        }
                        .tint(device.isBlocked ? Aurora.mint : Aurora.coral)

                        Button {
                            quickLimitTarget = device
                        } label: {
                            Label("تحديد السرعة", systemImage: "speedometer")
                        }
                        .tint(Aurora.violet)
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable {
            await store.refreshDevices()
        }
    }
}

// MARK: - Rich Device Row Card

private struct DeviceRowCard: View {
    let device: TendaDevice
    let maxBps: Double

    private var speedRatio: Double {
        let total = device.downSpeedBps + device.upSpeedBps
        guard maxBps > 0 else { return 0 }
        return min(1.0, max(0.0, total / maxBps))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(statusColor.opacity(0.14))
                        .frame(width: 44, height: 44)
                    Image(systemName: F.deviceIcon(category: device.category, label: device.label))
                        .font(.title3)
                        .foregroundStyle(statusColor)
                }
                .overlay(alignment: .bottomTrailing) {
                    Circle()
                        .fill(device.online ? Aurora.mint : Aurora.inkMuted)
                        .frame(width: 10, height: 10)
                        .overlay(Circle().stroke(Aurora.surface1, lineWidth: 2))
                }

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(device.label)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Aurora.ink)
                            .lineLimit(1)
                        if device.isNew {
                            StatusPill(text: "جديد", tint: Aurora.amber)
                        }
                    }

                    HStack(spacing: 6) {
                        Text(device.ip ?? "—")
                            .font(.caption.monospaced())
                            .foregroundStyle(Aurora.inkSecondary)
                        Text("·")
                            .foregroundStyle(Aurora.inkMuted)
                        Text(device.mac)
                            .font(.caption2.monospaced())
                            .foregroundStyle(Aurora.inkMuted)
                            .lineLimit(1)
                    }
                    .environment(\.layoutDirection, .leftToRight)
                }

                Spacer(minLength: 4)

                VStack(alignment: .trailing, spacing: 4) {
                    statusPill
                    Text(F.bytes(device.bytesTotal + device.bytesUpTotal))
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(Aurora.inkSecondary)
                        .environment(\.layoutDirection, .leftToRight)
                }
            }

            // Live ↓/↑ Speed Bar
            HStack(spacing: 10) {
                HStack(spacing: 8) {
                    Text("↓ \(F.mbps(device.downSpeedBps))")
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(device.downSpeedBps > 0 ? Aurora.mint : Aurora.inkMuted)
                    Text("↑ \(F.mbps(device.upSpeedBps))")
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(device.upSpeedBps > 0 ? Aurora.coral : Aurora.inkMuted)
                }
                .environment(\.layoutDirection, .leftToRight)

                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Aurora.surface3)
                        if speedRatio > 0 {
                            Capsule()
                                .fill(Aurora.mintVioletGradient)
                                .frame(width: max(8, geo.size.width * CGFloat(speedRatio)))
                        }
                    }
                }
                .frame(height: 5)

                Text(device.bandLabel)
                    .font(.caption2)
                    .foregroundStyle(Aurora.inkMuted)
            }
        }
        .padding(14)
        .background(Aurora.surface1, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(device.isBlocked ? Aurora.coral.opacity(0.40) : Aurora.border, lineWidth: 1)
        )
    }

    private var statusColor: Color {
        if device.isBlocked { return Aurora.coral }
        if device.isLimited { return Aurora.amber }
        if device.online { return Aurora.mint }
        return Aurora.inkMuted
    }

    @ViewBuilder
    private var statusPill: some View {
        if device.isBlocked {
            StatusPill(text: "محظور", icon: "hand.raised.fill", tint: Aurora.coral)
        } else if device.isLimited {
            StatusPill(text: F.speedLimitKbs(device.downloadLimitKbs), icon: "speedometer", tint: Aurora.amber, forceLTR: true)
        } else if device.online {
            StatusPill(text: "متصل", tint: Aurora.mint)
        } else {
            StatusPill(text: "غير متصل", tint: Aurora.inkMuted)
        }
    }
}

// MARK: - Full Device Detail Sheet

struct DeviceDetailSheet: View {
    let initialDevice: TendaDevice
    @EnvironmentObject private var store: TendaStore
    @Environment(\.dismiss) private var dismiss

    @State private var detail: DeviceDetailPayload? = nil
    @State private var chartRange: String = "today"
    @State private var editName: String = ""
    @State private var selectedCapMbps: Int = 0
    @State private var selectedWan: String = "auto"
    @State private var dhcpReserved: Bool = false
    @State private var isBlocked: Bool = false
    @State private var busy: Bool = false

    private struct SpeedCapPreset: Identifiable {
        let id: Int
        let label: String
        var mbps: Int { id }
    }

    private let capPresets: [SpeedCapPreset] = [
        SpeedCapPreset(id: 0, label: "مفتوح"),
        SpeedCapPreset(id: 5, label: "5 Mbps"),
        SpeedCapPreset(id: 10, label: "10 Mbps"),
        SpeedCapPreset(id: 15, label: "15 Mbps"),
        SpeedCapPreset(id: 25, label: "25 Mbps"),
    ]

    init(device: TendaDevice) {
        self.initialDevice = device
        _editName = State(initialValue: device.label)
        _isBlocked = State(initialValue: device.isBlocked)
        _dhcpReserved = State(initialValue: device.reserved)
        _selectedWan = State(initialValue: device.wanPort ?? "auto")
        let approxMbps = device.isBlocked ? 0 : Int((Double(device.downloadLimitKbs) / 128.0).rounded())
        _selectedCapMbps = State(initialValue: approxMbps)
    }

    private var liveDevice: TendaDevice {
        store.devices.first(where: { $0.mac == initialDevice.mac }) ?? detail?.device ?? initialDevice
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AuroraBackdrop()

                ScrollView {
                    VStack(spacing: 16) {
                        identityHeroCard
                        usageChartCard
                        blockAndSpeedCard
                        renameAndRoutingCard
                        connectionHistoryCard
                    }
                    .padding(16)
                }
            }
            .navigationTitle(liveDevice.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("إغلاق") { dismiss() }
                        .foregroundStyle(Aurora.mint)
                }
            }
            .task(id: chartRange) {
                detail = await store.loadDeviceDetail(mac: initialDevice.mac, range: chartRange)
                if let d = detail?.device {
                    isBlocked = d.isBlocked
                    dhcpReserved = d.reserved
                    selectedWan = d.wanPort ?? "auto"
                    selectedCapMbps = d.isBlocked ? 0 : Int((Double(d.downloadLimitKbs) / 128.0).rounded())
                }
            }
        }
        .preferredColorScheme(.dark)
        .environment(\.layoutDirection, .rightToLeft)
    }

    private var identityHeroCard: some View {
        AuroraCard(accent: liveDevice.isBlocked ? Aurora.coral : Aurora.mint) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Aurora.surface2)
                        .frame(width: 52, height: 52)
                    Image(systemName: F.deviceIcon(category: liveDevice.category, label: liveDevice.label))
                        .font(.title2)
                        .foregroundStyle(liveDevice.isBlocked ? Aurora.coral : Aurora.mint)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(liveDevice.label)
                        .font(.headline.weight(.bold))
                        .foregroundStyle(Aurora.ink)
                    Text("\(liveDevice.ip ?? "—") · \(liveDevice.mac)")
                        .font(.caption.monospaced())
                        .foregroundStyle(Aurora.inkSecondary)
                        .environment(\.layoutDirection, .leftToRight)
                    if let vendor = liveDevice.vendor, !vendor.isEmpty {
                        Text(vendor)
                            .font(.caption2)
                            .foregroundStyle(Aurora.inkMuted)
                    }
                }
                Spacer()
            }

            HStack(spacing: 8) {
                infoChip(title: "تحميل حالي", value: F.mbps(liveDevice.downSpeedBps), tint: Aurora.mint)
                infoChip(title: "رفع حالي", value: F.mbps(liveDevice.upSpeedBps), tint: Aurora.coral)
                infoChip(title: "إجمالي اليوم", value: F.bytes(liveDevice.bytesToday + liveDevice.bytesUpToday), tint: Aurora.violet)
            }

            if let rationale = liveDevice.aiRationaleAr, !rationale.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "sparkles")
                        .foregroundStyle(Aurora.violet)
                    Text(rationale)
                        .font(.caption)
                        .foregroundStyle(Aurora.inkSecondary)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private func infoChip(title: String, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(Aurora.inkMuted)
            Text(value)
                .font(.caption.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .environment(\.layoutDirection, .leftToRight)
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var usageChartCard: some View {
        AuroraCard(accent: Aurora.violet) {
            HStack {
                AuroraSectionHeader(title: "منحنى استهلاك الجهاز", icon: "chart.xyaxis.line", tint: Aurora.violet)
                Picker("المدى", selection: $chartRange) {
                    Text("اليوم").tag("today")
                    Text("7 أيام").tag("week")
                    Text("30 يوم").tag("month")
                }
                .pickerStyle(.segmented)
                .frame(width: 170)
            }

            let points = detail?.traffic ?? []
            if points.isEmpty {
                Text("لا توجد بيانات كافية لهذه الفترة.")
                    .font(.caption)
                    .foregroundStyle(Aurora.inkMuted)
                    .frame(maxWidth: .infinity, minHeight: 110)
            } else {
                Chart(points) { pt in
                    BarMark(
                        x: .value("الوقت", pt.date),
                        y: .value("التحميل", F.gb(pt.bytesDown))
                    )
                    .foregroundStyle(Aurora.mint.gradient)
                    .cornerRadius(4)

                    BarMark(
                        x: .value("الوقت", pt.date),
                        y: .value("الرفع", F.gb(pt.bytesUp))
                    )
                    .foregroundStyle(Aurora.coral.opacity(0.85))
                    .cornerRadius(4)
                }
                .frame(height: 150)
                .environment(\.layoutDirection, .leftToRight)
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { v in
                        AxisGridLine().foregroundStyle(Aurora.border)
                        AxisValueLabel {
                            if let gb = v.as(Double.self) {
                                Text("\(F.num(gb, digits: 1))G")
                                    .font(.caption2)
                                    .monospacedDigit()
                                    .foregroundStyle(Aurora.inkMuted)
                            }
                        }
                    }
                }
            }
        }
    }

    private var blockAndSpeedCard: some View {
        AuroraCard(accent: isBlocked ? Aurora.coral : Aurora.amber) {
            AuroraSectionHeader(title: "التحكم في الحظر والسرعة", icon: "slider.horizontal.3", tint: Aurora.coral)

            // Live Block / Unblock Toggle
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(isBlocked ? "الجهاز محظور حالياً" : "حظر اتصال الجهاز")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(isBlocked ? Aurora.coral : Aurora.ink)
                    Text("يفرض تقييداً فورياً على الراوتر لمنع تصفح الإنترنت")
                        .font(.caption2)
                        .foregroundStyle(Aurora.inkMuted)
                }
                Spacer()
                Toggle("", isOn: Binding(
                    get: { isBlocked },
                    set: { nextVal in
                        isBlocked = nextVal
                        Task {
                            busy = true
                            let ok = await store.controlDevice(mac: initialDevice.mac, action: nextVal ? "block" : "unblock")
                            if !ok { isBlocked.toggle() }
                            busy = false
                        }
                    }
                ))
                .labelsHidden()
                .tint(Aurora.coral)
                .disabled(busy)
            }
            .padding(12)
            .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

            // Speed Cap Picker (5 / 10 / 15 / 25 Mbps / مفتوح)
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("سقف سرعة التحميل (QoS)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Aurora.inkSecondary)
                    Spacer()
                    StatusPill(
                        text: F.speedLimitKbs(liveDevice.downloadLimitKbs),
                        tint: liveDevice.isLimited ? Aurora.amber : Aurora.mint,
                        forceLTR: liveDevice.isLimited
                    )
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: 8)], spacing: 8) {
                    ForEach(capPresets) { preset in
                        let active = !isBlocked && selectedCapMbps == preset.mbps
                        Button {
                            let prevCap = selectedCapMbps
                            let prevBlocked = isBlocked
                            selectedCapMbps = preset.mbps
                            isBlocked = false
                            Task {
                                busy = true
                                let ok = await store.controlDevice(
                                    mac: initialDevice.mac,
                                    action: "speed_limit",
                                    downloadMbps: Double(preset.mbps)
                                )
                                if !ok {
                                    selectedCapMbps = prevCap
                                    isBlocked = prevBlocked
                                }
                                busy = false
                            }
                        } label: {
                            Text(preset.label)
                                .font(.caption.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(active ? .white : Aurora.inkSecondary)
                                .frame(maxWidth: .infinity, minHeight: 38)
                                .background(active ? Aurora.violet : Aurora.surface2, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                                        .strokeBorder(active ? Aurora.violet : Aurora.border, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                    }
                }
            }
        }
    }

    private var renameAndRoutingCard: some View {
        AuroraCard {
            AuroraSectionHeader(title: "الاسم والتوجيه", icon: "pencil.and.outline", tint: Aurora.mint)

            HStack(spacing: 8) {
                TextField("اسم الجهاز", text: $editName)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .foregroundStyle(Aurora.ink)

                Button("حفظ") {
                    Task {
                        busy = true
                        _ = await store.controlDevice(mac: initialDevice.mac, action: "rename", customLabel: editName)
                        busy = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Aurora.violet)
                .disabled(busy || editName.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            HStack {
                Text("تثبيت عنوان IP (DHCP)")
                    .font(.subheadline)
                    .foregroundStyle(Aurora.ink)
                Spacer()
                Toggle("", isOn: Binding(
                    get: { dhcpReserved },
                    set: { next in
                        dhcpReserved = next
                        Task {
                            busy = true
                            let ok = await store.controlDevice(mac: initialDevice.mac, action: "dhcp_reserve", dhcpReserved: next)
                            if !ok { dhcpReserved.toggle() }
                            busy = false
                        }
                    }
                ))
                .labelsHidden()
                .tint(Aurora.mint)
                .disabled(busy)
            }

            HStack {
                Text("خط الإنترنت (Multi-WAN)")
                    .font(.subheadline)
                    .foregroundStyle(Aurora.ink)
                Spacer()
                Picker("WAN", selection: Binding(
                    get: { selectedWan },
                    set: { newWan in
                        guard newWan != selectedWan else { return }
                        let previous = selectedWan
                        selectedWan = newWan
                        Task {
                            busy = true
                            let ok = await store.controlDevice(mac: initialDevice.mac, action: "wan_bind", wanPort: newWan)
                            if !ok { selectedWan = previous }
                            busy = false
                        }
                    }
                )) {
                    Text("تلقائي").tag("auto")
                    Text("WAN1").tag("WAN1")
                    Text("WAN2").tag("WAN2")
                }
                .pickerStyle(.segmented)
                .frame(width: 185)
                .disabled(busy)
            }
        }
    }

    private var connectionHistoryCard: some View {
        AuroraCard {
            AuroraSectionHeader(title: "سجل الجلسات والاتصال", icon: "clock.arrow.circlepath", tint: Aurora.ice)

            let sessions = detail?.sessions ?? []
            if sessions.isEmpty {
                Text("لا توجد جلسات اتصال مسجّلة بعد.")
                    .font(.caption)
                    .foregroundStyle(Aurora.inkMuted)
            } else {
                VStack(spacing: 8) {
                    ForEach(sessions.prefix(8)) { s in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(F.timestamp(s.startedAt))
                                    .font(.caption.weight(.semibold))
                                    .monospacedDigit()
                                    .foregroundStyle(Aurora.ink)
                                    .environment(\.layoutDirection, .leftToRight)
                                Text(s.endedAt == nil ? "جلسة نشطة الآن" : "انتهت \(F.timestamp(s.endedAt))")
                                    .font(.caption2)
                                    .foregroundStyle(s.endedAt == nil ? Aurora.mint : Aurora.inkMuted)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("↓ \(F.bytes(s.bytesDown))")
                                    .font(.caption.weight(.semibold))
                                    .monospacedDigit()
                                    .foregroundStyle(Aurora.mint)
                                Text("↑ \(F.bytes(s.bytesUp))")
                                    .font(.caption2)
                                    .monospacedDigit()
                                    .foregroundStyle(Aurora.coral)
                            }
                            .environment(\.layoutDirection, .leftToRight)
                        }
                        .padding(10)
                        .background(Aurora.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
            }
        }
    }
}
