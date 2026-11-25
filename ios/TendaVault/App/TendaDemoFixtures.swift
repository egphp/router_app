import Foundation

/// 100% Offline Synthetic Demo Fixtures for TendaVault (`DEMO-2026` / `-demo` / `-UIFixtureMode`).
/// Zero real MACs, zero real IPs, zero customer data, zero network calls.
enum TendaDemoFixtures {
    private static let nowMs = Date().timeIntervalSince1970 * 1000.0
    private static let hourMs = 3_600_000.0
    private static let dayMs = 86_400_000.0

    static let wanPorts: [WanPortInfo] = [
        WanPortInfo(
            wanId: 1,
            wanName: "WAN1",
            status: "connected",
            wanIp: "198.51.100.14",
            publicIp: "198.51.100.14",
            downFluxBps: 7_850_000,
            upFluxBps: 1_240_000,
            pinnedDeviceCount: 2
        ),
        WanPortInfo(
            wanId: 2,
            wanName: "WAN2",
            status: "connected",
            wanIp: "203.0.113.42",
            publicIp: "203.0.113.42",
            downFluxBps: 3_120_000,
            upFluxBps: 480_000,
            pinnedDeviceCount: 1
        ),
    ]

    static func makeDevices() -> [TendaDevice] {
        [
            TendaDevice(
                mac: "02:00:00:10:00:01",
                label: "Apple TV 4K",
                hostname: "apple-tv-living",
                customLabel: "Apple TV 4K",
                routerRemark: "Living Room",
                vendor: "Apple Inc.",
                category: "tv",
                ip: "10.0.0.11",
                online: true,
                isNew: false,
                downSpeedBps: 4_820_000,
                upSpeedBps: 210_000,
                bytesToday: 18_400_000_000,
                bytesUpToday: 620_000_000,
                bytesTotal: 194_000_000_000,
                bytesUpTotal: 6_200_000_000,
                downloadLimitKbs: 0,
                uploadLimitKbs: 0,
                isBlocked: false,
                isLimited: false,
                qosKnown: true,
                reserved: true,
                reservedIp: "10.0.0.11",
                wanPort: "WAN1",
                wanGroupName: "living_tv",
                connectType: 2,
                connectionKind: "wired",
                wifiBand: nil,
                wifiRssiDbm: nil,
                wifiSignalPercent: nil,
                lastOnlineAt: nowMs,
                lastSeen: nowMs,
                firstSeen: nowMs - 28 * dayMs,
                aiTrustTier: "موثوق",
                aiRationaleAr: "بث فيديو 4K منتظم عبر كابل الشبكة على خط WAN1."
            ),
            TendaDevice(
                mac: "02:00:00:10:00:02",
                label: "Mac Studio",
                hostname: "mac-studio-desk",
                customLabel: "Mac Studio",
                routerRemark: "Office",
                vendor: "Apple Inc.",
                category: "computer",
                ip: "10.0.0.12",
                online: true,
                isNew: false,
                downSpeedBps: 2_640_000,
                upSpeedBps: 980_000,
                bytesToday: 11_200_000_000,
                bytesUpToday: 4_150_000_000,
                bytesTotal: 142_000_000_000,
                bytesUpTotal: 49_000_000_000,
                downloadLimitKbs: 0,
                uploadLimitKbs: 0,
                isBlocked: false,
                isLimited: false,
                qosKnown: true,
                reserved: true,
                reservedIp: "10.0.0.12",
                wanPort: "WAN1",
                wanGroupName: "studio_work",
                connectType: 2,
                connectionKind: "wired",
                wifiBand: nil,
                wifiRssiDbm: nil,
                wifiSignalPercent: nil,
                lastOnlineAt: nowMs,
                lastSeen: nowMs,
                firstSeen: nowMs - 60 * dayMs,
                aiTrustTier: "جهاز المالك",
                aiRationaleAr: "جهاز العمل الرئيسي — سرعة مفتوحة وحجز IP ثابت."
            ),
            TendaDevice(
                mac: "02:00:00:10:00:03",
                label: "iPhone 18 Pro",
                hostname: "iphone-pro",
                customLabel: "iPhone 18 Pro",
                routerRemark: "Mobile",
                vendor: "Apple Inc.",
                category: "phone",
                ip: "10.0.0.21",
                online: true,
                isNew: false,
                downSpeedBps: 1_450_000,
                upSpeedBps: 310_000,
                bytesToday: 4_850_000_000,
                bytesUpToday: 940_000_000,
                bytesTotal: 52_000_000_000,
                bytesUpTotal: 11_400_000_000,
                downloadLimitKbs: 0,
                uploadLimitKbs: 0,
                isBlocked: false,
                isLimited: false,
                qosKnown: true,
                reserved: true,
                reservedIp: "10.0.0.21",
                wanPort: nil,
                wanGroupName: nil,
                connectType: 4,
                connectionKind: "wifi",
                wifiBand: "5GHz",
                wifiRssiDbm: -46,
                wifiSignalPercent: 92,
                lastOnlineAt: nowMs,
                lastSeen: nowMs,
                firstSeen: nowMs - 45 * dayMs,
                aiTrustTier: "جهاز المالك",
                aiRationaleAr: "إشارة 5GHz قوية ومستقرة."
            ),
            TendaDevice(
                mac: "02:00:00:10:00:04",
                label: "PlayStation 5",
                hostname: "ps5-console",
                customLabel: "PlayStation 5",
                routerRemark: "Gaming",
                vendor: "Sony Interactive",
                category: "game",
                ip: "10.0.0.34",
                online: true,
                isNew: false,
                downSpeedBps: 1_890_000,
                upSpeedBps: 190_000,
                bytesToday: 9_600_000_000,
                bytesUpToday: 520_000_000,
                bytesTotal: 118_000_000_000,
                bytesUpTotal: 4_800_000_000,
                downloadLimitKbs: 1920, // 15 Mbps
                uploadLimitKbs: 640,
                isBlocked: false,
                isLimited: true,
                qosKnown: true,
                reserved: true,
                reservedIp: "10.0.0.34",
                wanPort: "WAN2",
                wanGroupName: "ps5_line",
                connectType: 4,
                connectionKind: "wifi",
                wifiBand: "5GHz",
                wifiRssiDbm: -54,
                wifiSignalPercent: 81,
                lastOnlineAt: nowMs,
                lastSeen: nowMs,
                firstSeen: nowMs - 20 * dayMs,
                aiTrustTier: "محدد السرعة",
                aiRationaleAr: "مقيّد بـ 15 Mbps لمنع استنزاف الباقة أثناء تحديث الألعاب."
            ),
            TendaDevice(
                mac: "02:00:00:10:00:05",
                label: "Smart TV",
                hostname: "bedroom-smart-tv",
                customLabel: "Smart TV",
                routerRemark: "Bedroom",
                vendor: "LG Electronics",
                category: "tv",
                ip: "10.0.0.45",
                online: true,
                isNew: false,
                downSpeedBps: 170_000,
                upSpeedBps: 30_000,
                bytesToday: 2_350_000_000,
                bytesUpToday: 110_000_000,
                bytesTotal: 39_500_000_000,
                bytesUpTotal: 1_900_000_000,
                downloadLimitKbs: 1280, // 10 Mbps
                uploadLimitKbs: 384,
                isBlocked: false,
                isLimited: true,
                qosKnown: true,
                reserved: false,
                reservedIp: nil,
                wanPort: nil,
                wanGroupName: nil,
                connectType: 3,
                connectionKind: "wifi",
                wifiBand: "2.4GHz",
                wifiRssiDbm: -63,
                wifiSignalPercent: 68,
                lastOnlineAt: nowMs,
                lastSeen: nowMs,
                firstSeen: nowMs - 14 * dayMs,
                aiTrustTier: "عائلي",
                aiRationaleAr: "سرعة 10 Mbps كافية لبث HD بسلاسة."
            ),
            TendaDevice(
                mac: "02:00:00:10:00:06",
                label: "جهاز ضيف غير معروف",
                hostname: "android-guest-9f",
                customLabel: nil,
                routerRemark: nil,
                vendor: "Generic",
                category: "phone",
                ip: "10.0.0.88",
                online: false,
                isNew: true,
                downSpeedBps: 0,
                upSpeedBps: 0,
                bytesToday: 185_000_000,
                bytesUpToday: 14_000_000,
                bytesTotal: 185_000_000,
                bytesUpTotal: 14_000_000,
                downloadLimitKbs: 1,
                uploadLimitKbs: 1,
                isBlocked: true,
                isLimited: false,
                qosKnown: true,
                reserved: false,
                reservedIp: nil,
                wanPort: nil,
                wanGroupName: nil,
                connectType: 3,
                connectionKind: "wifi",
                wifiBand: "2.4GHz",
                wifiRssiDbm: -74,
                wifiSignalPercent: 42,
                lastOnlineAt: nowMs - 2 * hourMs,
                lastSeen: nowMs - 2 * hourMs,
                firstSeen: nowMs - 3 * hourMs,
                aiTrustTier: "محظور",
                aiRationaleAr: "تم تقييد الجهاز بالكامل لحين التأكد من هويته."
            ),
        ]
    }

    static let speedCurve24h: [SpeedPoint] = {
        let patternDownMbps: [Double] = [
            12, 18, 24, 15, 9, 6, 8, 19, 34, 48, 62, 55,
            42, 38, 51, 74, 88, 79, 65, 92, 84, 71, 86, 88
        ]
        let patternUpMbps: [Double] = [
            2.1, 3.0, 2.8, 1.9, 1.2, 0.9, 1.4, 3.2, 5.8, 7.4, 9.1, 8.2,
            6.5, 5.4, 7.9, 11.2, 13.4, 12.1, 9.6, 14.2, 12.8, 10.5, 13.1, 13.8
        ]
        return (0..<24).map { idx in
            let ts = nowMs - Double(23 - idx) * hourMs
            return SpeedPoint(
                ts: ts,
                downBps: patternDownMbps[idx] * 125_000.0,
                upBps: patternUpMbps[idx] * 125_000.0
            )
        }
    }()

    static let quotaForecast = QuotaForecast(
        usedBytes: 412_000_000_000,
        combinedQuotaBytes: 600_000_000_000,
        weightedDailyBurnBytes: 18_600_000_000,
        projectedCycleBytes: 560_800_000_000,
        daysElapsed: 22.0,
        daysRemainingInCycle: 8.0,
        daysUntilExhaustion: 10.1,
        willExhaustBeforeRenewal: false,
        renewalDay: 3,
        summaryAr: "معدل الاستهلاك الحالي آمن (18.6 GB/يوم) — الباقة تكفي حتى موعد التجديد مع فائض متوقع 39 GB."
    )

    static func makeAlerts() -> [TendaAlert] {
        [
            TendaAlert(
                id: 901,
                kind: "new_device",
                mac: "02:00:00:10:00:06",
                payload: "انضم جهاز جديد (android-guest-9f) وتم وضعه في الحظر المؤقت.",
                createdAt: nowMs - 2.5 * hourMs,
                dismissedAt: nil,
                deviceLabel: "جهاز ضيف غير معروف"
            ),
            TendaAlert(
                id: 902,
                kind: "attack",
                mac: "02:00:00:10:00:04",
                payload: "تم صد محاولة فحص منافذ TCP Port Scan من خارج الشبكة (14 محاولة).",
                createdAt: nowMs - 5 * hourMs,
                dismissedAt: nil,
                deviceLabel: "جدار الحماية"
            ),
            TendaAlert(
                id: 903,
                kind: "threshold",
                mac: "02:00:00:10:00:01",
                payload: "تجاوز Apple TV 4K حاجز 15 GB اليوم بسبب بث 4K HDR.",
                createdAt: nowMs - 8 * hourMs,
                dismissedAt: nowMs - 6 * hourMs,
                deviceLabel: "Apple TV 4K"
            ),
        ]
    }

    static let attacks: [AttackEntry] = [
        AttackEntry(
            routerId: 5001,
            ts: nowMs - 3.2 * hourMs,
            logType: 2,
            message: "SYN Flood attack detected and dropped by router firewall",
            attackerIp: "198.51.100.77",
            attackerMac: nil,
            attackKind: "SYN Flood",
            attackCount: 24,
            deviceLabel: "WAN1 Firewall"
        ),
        AttackEntry(
            routerId: 5002,
            ts: nowMs - 9.5 * hourMs,
            logType: 2,
            message: "ARP Spoofing probe blocked on LAN interface",
            attackerIp: "10.0.0.88",
            attackerMac: "02:00:00:10:00:06",
            attackKind: "ARP Probe",
            attackCount: 6,
            deviceLabel: "جهاز ضيف غير معروف"
        ),
    ]

    static func makeDailyPoints(days: Int) -> [DailyTrafficPoint] {
        let sampleGb: [Double] = [14.2, 22.8, 19.5, 27.4, 16.9, 31.2, 24.6, 18.1, 21.4, 15.8]
        return (0..<days).map { i in
            let ts = nowMs - Double(days - 1 - i) * dayMs
            let gb = sampleGb[i % sampleGb.count]
            let down = gb * 1_073_741_824.0
            let up = down * 0.16
            return DailyTrafficPoint(dayTs: ts, bytesDown: down, bytesUp: up)
        }
    }

    static func makeBootstrap(devices: [TendaDevice], alerts: [TendaAlert]) -> BootstrapPayload {
        let online = devices.filter(\.online).count
        let blocked = devices.filter(\.isBlocked).count
        let limited = devices.filter(\.isLimited).count
        let undismissed = alerts.filter { !$0.isDismissed }.count
        let downBps = devices.reduce(0.0) { $0 + $1.downSpeedBps }
        let upBps = devices.reduce(0.0) { $0 + $1.upSpeedBps }
        let todayDown = devices.reduce(0.0) { $0 + $1.bytesToday }
        let todayUp = devices.reduce(0.0) { $0 + $1.bytesUpToday }

        return BootstrapPayload(
            ok: true,
            ts: nowMs,
            deviceId: "DEMO-SECURE-ENCLAVE-V2",
            router: .init(
                connected: true,
                host: "10.0.0.1",
                source: "demo-offline",
                uptimeSec: 1_248_600,
                lastSampleTs: nowMs,
                wanPorts: wanPorts
            ),
            throughput: .init(
                downBps: downBps,
                upBps: upBps,
                bytesTodayDown: todayDown,
                bytesTodayUp: todayUp,
                speeds: speedCurve24h
            ),
            counts: .init(
                online: online,
                totalDevices: devices.count,
                blocked: blocked,
                limited: limited,
                alertsUndismissed: undismissed,
                outagesToday: 0,
                activeAttacks24h: attacks.count
            ),
            quota: quotaForecast,
            topHogs: devices.sorted { ($0.bytesToday + $0.bytesUpToday) > ($1.bytesToday + $1.bytesUpToday) },
            recentAlerts: alerts.filter { !$0.isDismissed },
            recentAttacks: attacks
        )
    }

    static func makeSecurity(nsfwEnabled: Bool, alerts: [TendaAlert]) -> SecurityPayload {
        SecurityPayload(
            ok: true,
            attacks: .init(
                entries: attacks,
                stats: .init(totals: .init(total: 148, attacks: attacks.count, system: 146))
            ),
            nsfw: .init(
                enabled: nsfwEnabled,
                last24h: .init(hits: 3, devices: 1),
                topDomains: [
                    .init(domain: "blocked-sample-1.example", category: "adult", hits: 2, lastTs: nowMs - 4 * hourMs),
                    .init(domain: "blocked-sample-2.example", category: "gambling", hits: 1, lastTs: nowMs - 7 * hourMs),
                ],
                byDevice: [
                    .init(sourceMac: "02:00:00:10:00:06", sourceIp: "10.0.0.88", hits: 3, lastTs: nowMs - 4 * hourMs, label: "جهاز ضيف غير معروف"),
                ]
            ),
            alerts: alerts
        )
    }

    static func makeConsumption(devices: [TendaDevice]) -> ConsumptionPayload {
        let rows = devices.map { d in
            ConsumptionDeviceRow(
                mac: d.mac,
                label: d.label,
                category: d.category,
                online: d.online ? 1 : 0,
                todayDown: d.bytesToday,
                todayUp: d.bytesUpToday,
                weekDown: d.bytesToday * 5.2,
                weekUp: d.bytesUpToday * 4.8,
                monthDown: d.bytesTotal * 0.72,
                monthUp: d.bytesUpTotal * 0.72,
                totalDown: d.bytesTotal,
                totalUp: d.bytesUpTotal
            )
        }
        return ConsumptionPayload(
            ok: true,
            quota: quotaForecast,
            daily7d: makeDailyPoints(days: 7),
            daily30d: makeDailyPoints(days: 30),
            devices: rows
        )
    }

    static let outages = OutagesPayload(
        ok: true,
        currentUptimeSec: 1_248_600,
        outagesToday: 0,
        uptimePct7d: 99.94,
        uptimePct30d: 99.87,
        totalDowntimeSec30d: 264,
        outages: [
            OutageEntry(
                startedAt: nowMs - 4 * dayMs,
                endedAt: nowMs - 4 * dayMs + 264_000,
                durationSec: 264,
                reason: "إعادة مزامنة خط WAN1 مع مزود الخدمة",
                notes: "تحوّل الاتصال تلقائياً على WAN2 بدون توقف"
            ),
        ]
    )

    static func makeMap(devices: [TendaDevice]) -> NetworkMapPayload {
        NetworkMapPayload(
            ok: true,
            router: .init(host: "10.0.0.1", connected: true, uptimeSec: 1_248_600, wanPorts: wanPorts),
            groups: .init(
                wired: devices.filter { $0.online && !$0.isBlocked && ($0.connectType == 2 || $0.connectionKind == "wired") },
                wifi5g: devices.filter { $0.online && !$0.isBlocked && ($0.connectType == 4 || $0.wifiBand == "5GHz") },
                wifi24g: devices.filter { $0.online && !$0.isBlocked && ($0.connectType == 3 || $0.wifiBand == "2.4GHz") },
                blocked: devices.filter(\.isBlocked),
                offline: devices.filter { !$0.online && !$0.isBlocked }
            ),
            devices: devices
        )
    }

    static func makeReport(days: Int, devices: [TendaDevice]) -> ReportPayload {
        let daily = makeDailyPoints(days: days)
        let totalDown = daily.reduce(0.0) { $0 + $1.bytesDown }
        let totalUp = daily.reduce(0.0) { $0 + $1.bytesUp }
        let total = totalDown + totalUp
        let top = devices.prefix(5).map { d in
            ReportPayload.TopDevice(
                mac: d.mac,
                label: d.label,
                category: d.category,
                totalDown: d.bytesToday * Double(days) * 0.7,
                totalUp: d.bytesUpToday * Double(days) * 0.7,
                totalBytes: (d.bytesToday + d.bytesUpToday) * Double(days) * 0.7
            )
        }
        return ReportPayload(
            ok: true,
            days: days,
            generatedAt: nowMs,
            summary: .init(
                totalDown: totalDown,
                totalUp: totalUp,
                totalBytes: total,
                avgDailyBytes: total / Double(max(1, days)),
                outagesCount: 1,
                attacksCount: attacks.count
            ),
            daily: daily,
            topDevices: top,
            shareTextAr: "تقرير شبكة تندا التجريبي (آخر \(days) أيام)\nإجمالي الاستهلاك: \(F.bytes(total))\nالانقطاعات: 1 · الهجمات المحجوبة: \(attacks.count)"
        )
    }

    static func makeSettings(nsfwEnabled: Bool, guestWifi: Bool) -> RouterSettingsPayload {
        RouterSettingsPayload(
            ok: true,
            router: .init(
                host: "10.0.0.1",
                model: "Tenda W30E (معاينة)",
                firmware: "V16.01.0.22",
                cpuPercent: 18,
                memPercent: 41,
                guestWifiEnabled: guestWifi,
                uptimeSec: 1_248_600,
                pollIntervalMs: 5000,
                daemonRunning: true,
                wanPorts: wanPorts
            ),
            nsfwEnabled: nsfwEnabled,
            notificationTypes: [
                .init(key: "new_device", label: "جهاز جديد على الشبكة", description: "إشعار فوري عند اتصال جهاز غير معروف", enabled: true),
                .init(key: "attack", label: "الهجمات وجدار الحماية", description: "تنبيهات ARP و SYN Flood وفحص المنافذ", enabled: true),
                .init(key: "outage", label: "انقطاع الإنترنت", description: "تنبيه عند هبوط خط WAN أو إعادة تشغيل الراوتر", enabled: true),
                .init(key: "threshold", label: "تجاوز حد الاستهلاك", description: "تحذير عند اقتراب استنفاد الباقة الشهرية", enabled: true),
            ],
            thresholds: .init(
                totalEnabled: true,
                totalLimitBytes: 500_000_000_000,
                totalPeriod: "month",
                deviceEnabled: true,
                deviceDefaultLimitBytes: 25_000_000_000,
                deviceDefaultPeriod: "day"
            ),
            deviceAuth: .init(
                ok: true,
                state: "active",
                bound: true,
                deviceId: "DEMO-SECURE-ENCLAVE-KEY-V2",
                boundAt: nowMs - 14 * dayMs,
                lastSeenAt: nowMs,
                attested: true,
                sessionActive: true
            )
        )
    }

    static func makeDeviceDetail(device: TendaDevice, range: String) -> DeviceDetailPayload {
        let count = range == "month" ? 14 : (range == "week" ? 7 : 12)
        let stepMs = range == "today" ? hourMs : dayMs
        let buckets = (0..<count).map { i in
            let ts = nowMs - Double(count - 1 - i) * stepMs
            let factor = 0.6 + Double((i * 37) % 10) * 0.12
            let down = max(40_000_000, (device.bytesToday / Double(count)) * factor)
            return TrafficBucketPoint(bucketTs: ts, bytesDown: down, bytesUp: down * 0.15)
        }
        let sessions = [
            DeviceSessionRow(startedAt: nowMs - 5 * hourMs, endedAt: nil, bytesDown: device.bytesToday * 0.65, bytesUp: device.bytesUpToday * 0.65),
            DeviceSessionRow(startedAt: nowMs - 22 * hourMs, endedAt: nowMs - 14 * hourMs, bytesDown: device.bytesToday * 0.8, bytesUp: device.bytesUpToday * 0.7),
            DeviceSessionRow(startedAt: nowMs - 48 * hourMs, endedAt: nowMs - 39 * hourMs, bytesDown: device.bytesToday * 0.9, bytesUp: device.bytesUpToday * 0.5),
        ]
        return DeviceDetailPayload(
            ok: true,
            device: device,
            stats: .init(
                bytesDown: device.bytesTotal,
                bytesUp: device.bytesUpTotal,
                peakDownBps: max(device.downSpeedBps * 2.1, 2_500_000),
                peakUpBps: max(device.upSpeedBps * 1.8, 450_000)
            ),
            range: range,
            traffic: buckets,
            sessions: sessions
        )
    }
}
