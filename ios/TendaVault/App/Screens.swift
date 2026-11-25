import SwiftUI
import UserNotifications

struct HomeView: View {
    @EnvironmentObject private var store: VaultStore
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if store.demo {
                        Text("معاينة مراجعة. ليست شبكتك.")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Ink.amber)
                    }
                    HStack {
                        LiveDot(on: store.connected)
                        Text(store.statusLine).font(.headline)
                        Spacer()
                        Text(store.uptime).foregroundStyle(Ink.mist)
                    }
                    let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
                    LazyVGrid(columns: typeSize.isAccessibilitySize ? [GridItem(.flexible())] : columns, spacing: 10) {
                        MetricTile(title: "تنزيل اليوم", value: store.bytesDown, tint: Ink.mint)
                        MetricTile(title: "رفع اليوم", value: store.bytesUp, tint: .white)
                        MetricTile(title: "المتصلون", value: store.online, tint: Ink.mint)
                        MetricTile(title: "تنبيهات", value: L.int(store.alertCount), tint: store.alertCount > 0 ? Ink.coral : .white)
                    }
                    VaultCard {
                        Text("السرعة").font(.headline)
                        SpeedBars(values: store.speeds)
                            .frame(height: 72)
                    }
                    if let top = store.devices.max(by: { $0.bytesToday < $1.bytesToday }) {
                        VaultCard {
                            Text("أعلى جهاز اليوم").font(.footnote).foregroundStyle(Ink.mist)
                            Text(top.label).font(.headline).lineLimit(2)
                            Text("\(top.ip)  \(L.bytes(top.bytesToday))").font(.subheadline).foregroundStyle(Ink.mist)
                        }
                    }
                    if let notice = store.notice {
                        Text(notice).font(.footnote).foregroundStyle(Ink.amber)
                    }
                }
                .padding(16)
            }
            .background(Ink.canvas)
            .navigationTitle("الشبكة")
            .refreshable { await store.refreshHome() }
        }
    }
}

struct SpeedBars: View {
    let values: [Double]
    var body: some View {
        let peak = max(values.max() ?? 1, 1)
        HStack(alignment: .bottom, spacing: 4) {
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                Capsule()
                    .fill(Ink.mint.opacity(0.85))
                    .frame(height: max(4, CGFloat(value / peak) * 72))
            }
        }
        .frame(maxWidth: .infinity, alignment: .bottom)
    }
}

struct DevicesView: View {
    @EnvironmentObject private var store: VaultStore
    @State private var query = ""

    var shown: [VaultDevice] {
        guard !query.isEmpty else { return store.devices }
        return store.devices.filter {
            $0.label.localizedCaseInsensitiveContains(query) || $0.ip.contains(query) || $0.mac.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List(shown) { device in
                NavigationLink(value: device.mac) {
                    DeviceRow(device: device)
                }
                .listRowBackground(Ink.card)
            }
            .scrollContentBackground(.hidden)
            .background(Ink.canvas)
            .navigationTitle("الأجهزة")
            .searchable(text: $query, prompt: "اسم أو عنوان")
            .navigationDestination(for: String.self) { mac in
                if let device = store.devices.first(where: { $0.mac == mac }) {
                    DeviceDetail(device: device)
                }
            }
            .refreshable { await store.refreshHome() }
            .overlay {
                if shown.isEmpty { Text("لا أجهزة").foregroundStyle(Ink.mist) }
            }
        }
    }
}

struct DeviceRow: View {
    let device: VaultDevice
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 6) {
                label
                meta
            }
        } else {
            HStack(alignment: .center, spacing: 12) {
                LiveDot(on: device.online)
                VStack(alignment: .leading, spacing: 4) {
                    label
                    meta
                }
            }
        }
    }

    private var label: some View {
        HStack {
            Text(device.label).font(.body.weight(.semibold)).lineLimit(2)
            if device.isNew {
                Text("جديد").font(.caption2.weight(.bold)).padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Ink.amber.opacity(0.2), in: Capsule())
            }
        }
    }

    private var meta: some View {
        Text("\(device.ip.isEmpty ? device.mac : device.ip)  ↓ \(L.speed(device.downBps))")
            .font(.footnote)
            .foregroundStyle(Ink.mist)
            .lineLimit(2)
    }
}

struct DeviceDetail: View {
    let device: VaultDevice
    @EnvironmentObject private var store: VaultStore
    @State private var label: String
    @State private var down: String
    @State private var up: String
    @State private var reserved: Bool
    @State private var busy = false

    init(device: VaultDevice) {
        self.device = device
        _label = State(initialValue: device.label)
        _down = State(initialValue: L.int(device.downloadLimit))
        _up = State(initialValue: L.int(device.uploadLimit))
        _reserved = State(initialValue: device.reserved)
    }

    var body: some View {
        Form {
            Section("الجهاز") {
                LabeledContent("العنوان", value: device.mac)
                LabeledContent("الشبكة", value: device.ip.isEmpty ? "—" : device.ip)
                LabeledContent("النوع", value: device.category.isEmpty ? "—" : device.category)
                LabeledContent("الشركة", value: device.vendor.isEmpty ? "—" : device.vendor)
                LabeledContent("اليوم", value: L.bytes(device.bytesToday))
                LabeledContent("الرفع", value: L.bytes(device.bytesUpToday))
                if !device.wan.isEmpty { LabeledContent("الخط", value: device.wan) }
                if !device.signal.isEmpty { LabeledContent("الإشارة", value: device.signal) }
                ForEach(Array(device.extras.enumerated()), id: \.offset) { _, pair in
                    Text(pair.1).font(.footnote)
                }
            }
            Section("الاسم") {
                TextField("الاسم", text: $label)
                    .multilineTextAlignment(.trailing)
                Button("حفظ الاسم") { Task { await saveLabel() } }
            }
            Section("حد السرعة كيلوبايت/ث") {
                TextField("التنزيل", text: $down)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
                TextField("الرفع", text: $up)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
                Button("تطبيق الحد") { Task { await saveQos() } }
            }
            Section("تثبيت العنوان") {
                Toggle("حجز DHCP", isOn: $reserved)
                Button("حفظ الحجز") { Task { await saveDhcp() } }
            }
            Section {
                Button("تعليم الجهاز معروف") { Task { await markKnown() } }
                Button("حذف من السجل", role: .destructive) { Task { await remove() } }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Ink.canvas)
        .navigationTitle(device.label)
        .disabled(busy)
    }

    private var devicePath: String {
        "/api/devices/\(device.mac.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? device.mac)"
    }

    private func saveLabel() async {
        busy = true
        _ = await store.mutate(devicePath, method: "PATCH", body: ["custom_label": label])
        await store.refreshHome()
        busy = false
    }

    private func saveQos() async {
        busy = true
        _ = await store.mutate("\(devicePath)/control", method: "POST", body: [
            "download_limit_kbs": Int(down) ?? 0,
            "upload_limit_kbs": Int(up) ?? 0,
        ])
        busy = false
    }

    private func saveDhcp() async {
        busy = true
        _ = await store.mutate("\(devicePath)/control", method: "POST", body: ["dhcp_reserved": reserved])
        busy = false
    }

    private func markKnown() async {
        _ = await store.mutate(devicePath, method: "PATCH", body: ["is_new": 0])
        await store.refreshHome()
    }

    private func remove() async {
        _ = await store.mutate(devicePath, method: "DELETE", body: [:])
        await store.refreshHome()
    }
}

struct AlertsView: View {
    @EnvironmentObject private var store: VaultStore

    var body: some View {
        NavigationStack {
            List(store.alerts) { alert in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(alert.title).font(.headline).lineLimit(2)
                        Spacer()
                        Text(alert.kind).font(.caption).foregroundStyle(Ink.mist)
                    }
                    Text(alert.detail).font(.footnote).foregroundStyle(Ink.mist).lineLimit(3)
                    Text(alert.when).font(.caption2).foregroundStyle(Ink.mist)
                    if alert.dismissed { Text("مغلق").font(.caption2).foregroundStyle(Ink.mint) }
                }
                .listRowBackground(Ink.card)
                .swipeActions {
                    Button("إغلاق") { Task { await dismiss(alert.id) } }.tint(Ink.coral)
                    Button("تجاهل لاحقاً") { Task { await ignore(alert.id) } }.tint(Ink.amber)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Ink.canvas)
            .navigationTitle("التنبيهات")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu("إجراءات") {
                        Button("إغلاق الكل") { Task { _ = await store.mutate("/api/alerts", method: "PATCH", body: ["action": "dismiss_all"]); await store.refreshAlerts() } }
                        Button("تعليم الجديد معروف") { Task { _ = await store.mutate("/api/alerts", method: "PATCH", body: ["action": "mark_all_known"]); await store.refreshHome() } }
                        Button("تنبيه تجريبي") { Task { await testPush() } }
                    }
                }
            }
            .refreshable { await store.refreshAlerts() }
            .task { await store.refreshAlerts() }
        }
    }

    private func dismiss(_ id: Int) async {
        _ = await store.mutate("/api/alerts", method: "PATCH", body: ["id": id])
        await store.refreshAlerts()
    }

    private func ignore(_ id: Int) async {
        _ = await store.mutate("/api/alerts", method: "PATCH", body: ["action": "ignore_future", "id": id])
        await store.refreshAlerts()
    }

    private func testPush() async {
        if store.demo {
            let content = UNMutableNotificationContent()
            content.title = "تنبيه تجريبي"
            content.body = "هذه معاينة. التنبيه الحقيقي يصل بعد البصمة."
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false))
            try? await UNUserNotificationCenter.current().add(request)
            return
        }
        _ = await store.mutate("/api/push/test", method: "POST", body: [:])
    }
}

struct SecurityHub: View {
    @EnvironmentObject private var store: VaultStore
    @State private var page = 0

    var body: some View {
        NavigationStack {
            VStack {
                Picker("القسم", selection: $page) {
                    Text("السجل").tag(0)
                    Text("الهجمات").tag(1)
                    Text("المحتوى").tag(2)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                if page == 0 {
                    EndpointList(title: "سجل الراوتر", path: "/api/router-log?limit=200")
                } else if page == 1 {
                    EndpointList(title: "الهجمات", path: "/api/attack-log?limit=200&type=2")
                } else {
                    EndpointList(title: "آخر يوم", path: "/api/nsfw")
                }
            }
            .background(Ink.canvas)
            .navigationTitle("الحماية")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("استشارة") { page = 0 }
                }
            }
        }
    }
}

struct MoreView: View {
    var body: some View {
        NavigationStack {
            List {
                NavigationLink("الخريطة") { EndpointList(title: "الخريطة", path: "/api/devices?live=1") }
                NavigationLink("الاستهلاك") { EndpointList(title: "الاستهلاك", path: "/api/consumption") }
                NavigationLink("التقرير") { EndpointList(title: "التقرير", path: "/api/report?days=14") }
                NavigationLink("التحليلات") { AnalyticsView() }
                NavigationLink("الانقطاعات") { EndpointList(title: "الانقطاعات", path: "/api/outages") }
                NavigationLink("التصدير") { ExportView() }
                NavigationLink("المساعد") { CopilotView() }
                NavigationLink("الإعدادات") { SettingsView() }
            }
            .scrollContentBackground(.hidden)
            .background(Ink.canvas)
            .navigationTitle("المزيد")
        }
    }
}

struct EndpointList: View {
    let title: String
    let path: String
    @EnvironmentObject private var store: VaultStore
    @State private var rows: [DisplayRow] = []

    var body: some View {
        List(rows) { row in
            VStack(alignment: .leading, spacing: 4) {
                Text(row.title).font(.headline).lineLimit(2)
                if !row.subtitle.isEmpty {
                    Text(row.subtitle).font(.footnote).foregroundStyle(Ink.mist).lineLimit(2)
                }
                ForEach(Array(row.fields.prefix(6).enumerated()), id: \.offset) { _, field in
                    Text("\(field.0): \(field.1)")
                        .font(.caption)
                        .foregroundStyle(Ink.mist)
                        .lineLimit(2)
                }
            }
            .listRowBackground(Ink.card)
        }
        .scrollContentBackground(.hidden)
        .background(Ink.canvas)
        .navigationTitle(title)
        .refreshable { rows = await store.load(path) }
        .task { rows = await store.load(path) }
    }
}

struct AnalyticsView: View {
    @State private var kind = "top"
    private let kinds = ["top", "categories", "anomalies", "concurrent", "heatmap", "uptime"]

    var body: some View {
        VStack {
            Picker("النوع", selection: $kind) {
                ForEach(kinds, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.menu)
            EndpointList(title: "التحليلات", path: "/api/analytics?kind=\(kind)")
                .id(kind)
        }
        .background(Ink.canvas)
    }
}

struct ExportView: View {
    @EnvironmentObject private var store: VaultStore
    private let kinds = ["consumption", "daily", "attacks", "syslog", "outages"]

    var body: some View {
        List(kinds, id: \.self) { kind in
            NavigationLink(kind) {
                EndpointList(title: kind, path: "/api/export?kind=\(kind)&format=json")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Ink.canvas)
        .navigationTitle("التصدير")
    }
}

struct CopilotView: View {
    @EnvironmentObject private var store: VaultStore
    @State private var text = ""
    @State private var reply = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView {
                Text(reply.isEmpty ? "اسأل عن الشبكة. الاقتراحات لا تُنفذ إلا بعد تأكيدك." : reply)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            TextField("السؤال", text: $text, axis: .vertical)
                .lineLimit(1...3)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal)
            Button(busy ? "يفكر" : "إرسال") {
                Task { await ask() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy || text.trimmingCharacters(in: .whitespaces).isEmpty)
            .padding(.horizontal)
        }
        .background(Ink.canvas)
        .navigationTitle("المساعد")
    }

    private func ask() async {
        busy = true
        if store.demo {
            reply = "هذه معاينة. المساعد الحقيقي يعمل بعد البصمة وعلى شبكتك فقط."
            busy = false
            return
        }
        do {
            let data = try await store.api.sendJSON("/api/ai/copilot", method: "POST", body: [
                "message": text,
                "pageContext": ["pathname": "/"],
            ])
            let obj = JSONRows.object(data)
            reply = (obj["replyAr"] as? String) ?? "لا رد"
            text = ""
        } catch {
            reply = error.localizedDescription
        }
        busy = false
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: VaultStore
    @State private var types: [(String, String, Bool)] = []
    @State private var nsfw = true
    @State private var host = ""
    @State private var password = ""
    @State private var schedules: [DisplayRow] = []
    @State private var loaded = false

    var body: some View {
        Form {
            Section("التنبيهات") {
                ForEach(types.indices, id: \.self) { index in
                    Toggle(types[index].1, isOn: binding(index))
                }
                Toggle("رصد المحتوى", isOn: Binding(
                    get: { nsfw },
                    set: { value in
                        nsfw = value
                        Task { _ = await store.mutate("/api/nsfw", method: "PATCH", body: ["enabled": value]) }
                    }
                ))
            }
            Section("جداول السرعة") {
                ForEach(schedules) { row in
                    VStack(alignment: .leading) {
                        Text(row.title)
                        Text(row.subtitle).font(.caption).foregroundStyle(Ink.mist)
                    }
                }
            }
            Section("الراوتر") {
                TextField("عنوان الراوتر", text: $host)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .multilineTextAlignment(.trailing)
                SecureField("كلمة مرور الراوتر", text: $password)
                    .multilineTextAlignment(.trailing)
                Button("اختبار") { Task { await router("test") } }
                Button("حفظ") { Task { await router("save") } }
            }
            Section {
                Button("قفل") { store.lock() }
                Button("نسيان هذا الهاتف", role: .destructive) { Task { await store.forget() } }
            }
            if let notice = store.notice {
                Section { Text(notice).foregroundStyle(Ink.amber) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Ink.canvas)
        .navigationTitle("الإعدادات")
        .task { await load() }
    }

    private func binding(_ index: Int) -> Binding<Bool> {
        Binding(
            get: { types[index].2 },
            set: { value in
                types[index].2 = value
                let key = types[index].0
                Task {
                    _ = await store.mutate("/api/notification-settings", method: "PATCH", body: [
                        "action": "set_type", "type": key, "enabled": value,
                    ])
                }
            }
        )
    }

    private func load() async {
        if store.demo {
            types = [("new_device", "جهاز جديد", true), ("attack", "هجمات", true), ("outage", "انقطاع", true)]
            schedules = [DisplayRow(title: "دوام العينة", subtitle: "09:00 - 17:00", fields: [])]
            host = "192.168.0.1"
            return
        }
        let data = (try? await store.api.get("/api/notification-settings")) ?? Data()
        let obj = JSONRows.object(data)
        let list = (obj["types"] as? [[String: Any]]) ?? []
        types = list.compactMap { item in
            guard let key = item["key"] as? String else { return nil }
            let label = (item["label"] as? String) ?? key
            let enabled = (item["enabled"] as? Bool) ?? true
            return (key, label, enabled)
        }
        if let nsfwData = try? await store.api.get("/api/nsfw") {
            nsfw = (JSONRows.object(nsfwData)["enabled"] as? Bool) ?? true
        }
        if let settings = try? await store.api.get("/api/settings") {
            host = (JSONRows.object(settings)["routerHost"] as? String) ?? ""
        }
        schedules = await store.load("/api/ai/schedules")
        loaded = true
    }

    private func router(_ action: String) async {
        _ = await store.mutate("/api/settings", method: "POST", body: [
            "action": action, "host": host, "password": password,
        ])
        password = ""
    }
}
