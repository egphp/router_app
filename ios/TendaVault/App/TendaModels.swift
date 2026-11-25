import Foundation

// MARK: - Core API Payloads

struct WanPortInfo: Codable, Identifiable, Hashable {
    var id: Int { wanId }
    let wanId: Int
    let wanName: String
    let status: String
    let wanIp: String?
    let publicIp: String?
    let downFluxBps: Double
    let upFluxBps: Double
    let pinnedDeviceCount: Int

    enum CodingKeys: String, CodingKey {
        case wanId = "wan_id"
        case wanName = "wan_name"
        case status
        case wanIp = "wan_ip"
        case publicIp = "public_ip"
        case downFluxBps = "down_flux_bps"
        case upFluxBps = "up_flux_bps"
        case pinnedDeviceCount = "pinned_device_count"
    }

    var isConnected: Bool {
        let s = status.lowercased()
        return s == "wired" || s == "connected" || s == "up"
    }
}

struct SpeedPoint: Codable, Identifiable, Hashable {
    var id: Double { ts }
    let ts: Double
    let downBps: Double
    let upBps: Double

    enum CodingKeys: String, CodingKey {
        case ts
        case downBps = "down_bps"
        case upBps = "up_bps"
    }

    var date: Date { Date(timeIntervalSince1970: ts / 1000.0) }
}

struct QuotaForecast: Codable, Hashable {
    let usedBytes: Double
    let combinedQuotaBytes: Double
    let weightedDailyBurnBytes: Double
    let projectedCycleBytes: Double
    let daysElapsed: Double
    let daysRemainingInCycle: Double
    let daysUntilExhaustion: Double?
    let willExhaustBeforeRenewal: Bool
    let renewalDay: Int
    let summaryAr: String

    enum CodingKeys: String, CodingKey {
        case usedBytes = "used_bytes"
        case combinedQuotaBytes = "combined_quota_bytes"
        case weightedDailyBurnBytes = "weighted_daily_burn_bytes"
        case projectedCycleBytes = "projected_cycle_bytes"
        case daysElapsed = "days_elapsed"
        case daysRemainingInCycle = "days_remaining_in_cycle"
        case daysUntilExhaustion = "days_until_exhaustion"
        case willExhaustBeforeRenewal = "will_exhaust_before_renewal"
        case renewalDay = "renewal_day"
        case summaryAr = "summary_ar"
    }

    var usageRatio: Double {
        guard combinedQuotaBytes > 0 else { return 0 }
        return min(1.0, max(0.0, usedBytes / combinedQuotaBytes))
    }
}

struct TendaDevice: Codable, Identifiable, Hashable {
    var id: String { mac }
    let mac: String
    var label: String
    let hostname: String?
    var customLabel: String?
    let routerRemark: String?
    let vendor: String?
    let category: String?
    let ip: String?
    let online: Bool
    var isNew: Bool
    let downSpeedBps: Double
    let upSpeedBps: Double
    let bytesToday: Double
    let bytesUpToday: Double
    let bytesTotal: Double
    let bytesUpTotal: Double
    var downloadLimitKbs: Int
    var uploadLimitKbs: Int
    var isBlocked: Bool
    var isLimited: Bool
    let qosKnown: Bool
    var reserved: Bool
    let reservedIp: String?
    var wanPort: String?
    let wanGroupName: String?
    let connectType: Int?
    let connectionKind: String?
    let wifiBand: String?
    let wifiRssiDbm: Double?
    let wifiSignalPercent: Double?
    let lastOnlineAt: Double?
    let lastSeen: Double?
    let firstSeen: Double?
    let aiTrustTier: String?
    let aiRationaleAr: String?

    enum CodingKeys: String, CodingKey {
        case mac, label, hostname, vendor, category, ip, online, reserved
        case customLabel = "custom_label"
        case routerRemark = "router_remark"
        case isNew = "is_new"
        case downSpeedBps = "down_speed_bps"
        case upSpeedBps = "up_speed_bps"
        case bytesToday = "bytes_today"
        case bytesUpToday = "bytes_up_today"
        case bytesTotal = "bytes_total"
        case bytesUpTotal = "bytes_up_total"
        case downloadLimitKbs = "download_limit_kbs"
        case uploadLimitKbs = "upload_limit_kbs"
        case isBlocked = "is_blocked"
        case isLimited = "is_limited"
        case qosKnown = "qos_known"
        case reservedIp = "reserved_ip"
        case wanPort = "wan_port"
        case wanGroupName = "wan_group_name"
        case connectType = "connect_type"
        case connectionKind = "connection_kind"
        case wifiBand = "wifi_band"
        case wifiRssiDbm = "wifi_rssi_dbm"
        case wifiSignalPercent = "wifi_signal_percent"
        case lastOnlineAt = "last_online_at"
        case lastSeen = "last_seen"
        case firstSeen = "first_seen"
        case aiTrustTier = "ai_trust_tier"
        case aiRationaleAr = "ai_rationale_ar"
    }

    var bandLabel: String {
        if connectType == 2 || connectionKind == "wired" { return "سلكي LAN" }
        if connectType == 4 || wifiBand == "5GHz" { return "5GHz" }
        if connectType == 3 || wifiBand == "2.4GHz" { return "2.4GHz" }
        return online ? "Wi-Fi" : "غير متصل"
    }
}

struct TendaAlert: Codable, Identifiable, Hashable {
    let id: Int
    let kind: String
    let mac: String?
    let payload: String?
    let createdAt: Double
    var dismissedAt: Double?
    let deviceLabel: String?

    enum CodingKeys: String, CodingKey {
        case id, kind, mac, payload
        case createdAt = "created_at"
        case dismissedAt = "dismissed_at"
        case deviceLabel = "device_label"
    }

    var isDismissed: Bool { (dismissedAt ?? 0) > 0 }

    var kindArabic: String {
        switch kind {
        case "new_device": return "جهاز جديد"
        case "attack": return "هجوم شبكي"
        case "nsfw": return "فلتر المحتوى"
        case "outage": return "انقطاع اتصال"
        case "threshold": return "تجاوز الاستهلاك"
        case "anomaly": return "نشاط غير معتاد"
        default: return kind
        }
    }
}

struct AttackEntry: Codable, Identifiable, Hashable {
    var id: String { "\(routerId)-\(Int(ts))" }
    let routerId: Int
    let ts: Double
    let logType: Int
    let message: String
    let attackerIp: String?
    let attackerMac: String?
    let attackKind: String?
    let attackCount: Int?
    let deviceLabel: String?

    enum CodingKeys: String, CodingKey {
        case routerId = "router_id"
        case ts
        case logType = "log_type"
        case message
        case attackerIp = "attacker_ip"
        case attackerMac = "attacker_mac"
        case attackKind = "attack_kind"
        case attackCount = "attack_count"
        case deviceLabel = "device_label"
    }

    var isHighSeverity: Bool {
        let kind = (attackKind ?? message).lowercased()
        return kind.contains("ddos") || kind.contains("flood") || kind.contains("arp") || (attackCount ?? 0) >= 10
    }
}

// MARK: - Bootstrap

struct BootstrapPayload: Codable {
    struct RouterHealth: Codable {
        let connected: Bool
        let host: String
        let source: String
        let uptimeSec: Int
        let lastSampleTs: Double?
        let wanPorts: [WanPortInfo]

        enum CodingKeys: String, CodingKey {
            case connected, host, source
            case uptimeSec = "uptime_sec"
            case lastSampleTs = "last_sample_ts"
            case wanPorts = "wan_ports"
        }
    }

    struct Throughput: Codable {
        let downBps: Double
        let upBps: Double
        let bytesTodayDown: Double
        let bytesTodayUp: Double
        let speeds: [SpeedPoint]

        enum CodingKeys: String, CodingKey {
            case downBps = "down_bps"
            case upBps = "up_bps"
            case bytesTodayDown = "bytes_today_down"
            case bytesTodayUp = "bytes_today_up"
            case speeds
        }
    }

    struct Counts: Codable {
        let online: Int
        let totalDevices: Int
        let blocked: Int
        let limited: Int
        let alertsUndismissed: Int
        let outagesToday: Int
        let activeAttacks24h: Int

        enum CodingKeys: String, CodingKey {
            case online, blocked, limited
            case totalDevices = "total_devices"
            case alertsUndismissed = "alerts_undismissed"
            case outagesToday = "outages_today"
            case activeAttacks24h = "active_attacks_24h"
        }
    }

    let ok: Bool
    let ts: Double
    let deviceId: String?
    let router: RouterHealth
    let throughput: Throughput
    let counts: Counts
    let quota: QuotaForecast
    let topHogs: [TendaDevice]
    let recentAlerts: [TendaAlert]
    let recentAttacks: [AttackEntry]

    enum CodingKeys: String, CodingKey {
        case ok, ts, router, throughput, counts, quota
        case deviceId = "device_id"
        case topHogs = "top_hogs"
        case recentAlerts = "recent_alerts"
        case recentAttacks = "recent_attacks"
    }
}

// MARK: - Devices & Detail

struct DevicesPayload: Codable {
    let ok: Bool
    let liveTs: Double?
    let wanPorts: [WanPortInfo]
    let devices: [TendaDevice]

    enum CodingKeys: String, CodingKey {
        case ok, devices
        case liveTs = "live_ts"
        case wanPorts = "wan_ports"
    }
}

struct TrafficBucketPoint: Codable, Identifiable, Hashable {
    var id: Double { bucketTs }
    let bucketTs: Double
    let bytesDown: Double
    let bytesUp: Double

    enum CodingKeys: String, CodingKey {
        case bucketTs = "bucket_ts"
        case bytesDown = "bytes_down"
        case bytesUp = "bytes_up"
    }

    var date: Date { Date(timeIntervalSince1970: bucketTs / 1000.0) }
}

struct DeviceSessionRow: Codable, Identifiable, Hashable {
    var id: Double { startedAt }
    let startedAt: Double
    let endedAt: Double?
    let bytesDown: Double
    let bytesUp: Double

    enum CodingKeys: String, CodingKey {
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case bytesDown = "bytes_down"
        case bytesUp = "bytes_up"
    }
}

struct DeviceDetailPayload: Codable {
    struct Stats: Codable {
        let bytesDown: Double
        let bytesUp: Double
        let peakDownBps: Double
        let peakUpBps: Double

        enum CodingKeys: String, CodingKey {
            case bytesDown = "bytes_down"
            case bytesUp = "bytes_up"
            case peakDownBps = "peak_down_bps"
            case peakUpBps = "peak_up_bps"
        }
    }

    let ok: Bool
    let device: TendaDevice
    let stats: Stats
    let range: String
    let traffic: [TrafficBucketPoint]
    let sessions: [DeviceSessionRow]
}

// MARK: - Security

struct SecurityPayload: Codable {
    struct AttackBlock: Codable {
        struct Totals: Codable {
            let total: Int
            let attacks: Int?
            let system: Int?
        }
        let entries: [AttackEntry]
        let stats: AttackStatsBlock
    }

    struct AttackStatsBlock: Codable {
        let totals: AttackBlock.Totals
    }

    struct NsfwBlock: Codable {
        struct Last24h: Codable {
            let hits: Int
            let devices: Int
        }
        struct DomainRow: Codable, Identifiable, Hashable {
            var id: String { domain }
            let domain: String
            let category: String
            let hits: Int
            let lastTs: Double

            enum CodingKeys: String, CodingKey {
                case domain, category, hits
                case lastTs = "last_ts"
            }
        }
        struct DeviceHitRow: Codable, Identifiable, Hashable {
            var id: String { sourceMac }
            let sourceMac: String
            let sourceIp: String?
            let hits: Int
            let lastTs: Double
            let label: String

            enum CodingKeys: String, CodingKey {
                case hits, label
                case sourceMac = "source_mac"
                case sourceIp = "source_ip"
                case lastTs = "last_ts"
            }
        }
        var enabled: Bool
        let last24h: Last24h
        let topDomains: [DomainRow]
        let byDevice: [DeviceHitRow]

        enum CodingKeys: String, CodingKey {
            case enabled
            case last24h = "last_24h"
            case topDomains = "top_domains"
            case byDevice = "by_device"
        }
    }

    let ok: Bool
    let attacks: AttackBlock
    var nsfw: NsfwBlock
    var alerts: [TendaAlert]
}

// MARK: - Analytics (Consumption, Map, Outages, Report)

struct DailyTrafficPoint: Codable, Identifiable, Hashable {
    var id: Double { dayTs }
    let dayTs: Double
    let bytesDown: Double
    let bytesUp: Double

    enum CodingKeys: String, CodingKey {
        case dayTs = "day_ts"
        case bytesDown = "bytes_down"
        case bytesUp = "bytes_up"
    }

    var date: Date { Date(timeIntervalSince1970: dayTs / 1000.0) }
    var totalBytes: Double { bytesDown + bytesUp }
}

struct ConsumptionDeviceRow: Codable, Identifiable, Hashable {
    var id: String { mac }
    let mac: String
    let label: String
    let category: String?
    let online: Int
    let todayDown: Double
    let todayUp: Double
    let weekDown: Double
    let weekUp: Double
    let monthDown: Double
    let monthUp: Double
    let totalDown: Double
    let totalUp: Double

    enum CodingKeys: String, CodingKey {
        case mac, label, category, online
        case todayDown = "today_down"
        case todayUp = "today_up"
        case weekDown = "week_down"
        case weekUp = "week_up"
        case monthDown = "month_down"
        case monthUp = "month_up"
        case totalDown = "total_down"
        case totalUp = "total_up"
    }
}

struct ConsumptionPayload: Codable {
    let ok: Bool
    let quota: QuotaForecast
    let daily7d: [DailyTrafficPoint]
    let daily30d: [DailyTrafficPoint]
    let devices: [ConsumptionDeviceRow]

    enum CodingKeys: String, CodingKey {
        case ok, quota, devices
        case daily7d = "daily_7d"
        case daily30d = "daily_30d"
    }
}

struct OutageEntry: Codable, Identifiable, Hashable {
    var id: Double { startedAt }
    let startedAt: Double
    let endedAt: Double?
    let durationSec: Int?
    let reason: String
    let notes: String?

    enum CodingKeys: String, CodingKey {
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case durationSec = "duration_sec"
        case reason, notes
    }
}

struct OutagesPayload: Codable {
    let ok: Bool
    let currentUptimeSec: Int
    let outagesToday: Int
    let uptimePct7d: Double
    let uptimePct30d: Double
    let totalDowntimeSec30d: Int
    let outages: [OutageEntry]

    enum CodingKeys: String, CodingKey {
        case ok, outages
        case currentUptimeSec = "current_uptime_sec"
        case outagesToday = "outages_today"
        case uptimePct7d = "uptime_pct_7d"
        case uptimePct30d = "uptime_pct_30d"
        case totalDowntimeSec30d = "total_downtime_sec_30d"
    }
}

struct NetworkMapPayload: Codable {
    struct RouterNode: Codable {
        let host: String
        let connected: Bool
        let uptimeSec: Int
        let wanPorts: [WanPortInfo]

        enum CodingKeys: String, CodingKey {
            case host, connected
            case uptimeSec = "uptime_sec"
            case wanPorts = "wan_ports"
        }
    }

    struct Groups: Codable {
        let wired: [TendaDevice]
        let wifi5g: [TendaDevice]
        let wifi24g: [TendaDevice]
        let blocked: [TendaDevice]
        let offline: [TendaDevice]

        enum CodingKeys: String, CodingKey {
            case wired, blocked, offline
            case wifi5g = "wifi_5g"
            case wifi24g = "wifi_24g"
        }
    }

    let ok: Bool
    let router: RouterNode
    let groups: Groups
    let devices: [TendaDevice]
}

struct ReportPayload: Codable {
    struct Summary: Codable {
        let totalDown: Double
        let totalUp: Double
        let totalBytes: Double
        let avgDailyBytes: Double
        let outagesCount: Int
        let attacksCount: Int

        enum CodingKeys: String, CodingKey {
            case totalDown = "total_down"
            case totalUp = "total_up"
            case totalBytes = "total_bytes"
            case avgDailyBytes = "avg_daily_bytes"
            case outagesCount = "outages_count"
            case attacksCount = "attacks_count"
        }
    }

    struct TopDevice: Codable, Identifiable, Hashable {
        var id: String { mac }
        let mac: String
        let label: String
        let category: String?
        let totalDown: Double
        let totalUp: Double
        let totalBytes: Double

        enum CodingKeys: String, CodingKey {
            case mac, label, category
            case totalDown = "total_down"
            case totalUp = "total_up"
            case totalBytes = "total_bytes"
        }
    }

    let ok: Bool
    let days: Int
    let generatedAt: Double
    let summary: Summary
    let daily: [DailyTrafficPoint]
    let topDevices: [TopDevice]
    let shareTextAr: String

    enum CodingKeys: String, CodingKey {
        case ok, days, summary, daily
        case generatedAt = "generated_at"
        case topDevices = "top_devices"
        case shareTextAr = "share_text_ar"
    }
}

// MARK: - Settings

struct NotificationTypeRow: Codable, Identifiable, Hashable {
    var id: String { key }
    let key: String
    let label: String
    let description: String
    var enabled: Bool
}

struct ThresholdConfigPayload: Codable {
    var totalEnabled: Bool
    var totalLimitBytes: Double
    var totalPeriod: String
    var deviceEnabled: Bool
    var deviceDefaultLimitBytes: Double
    var deviceDefaultPeriod: String
}

struct DeviceAuthStatusPayload: Codable {
    let ok: Bool
    let state: String
    let bound: Bool
    let deviceId: String
    let boundAt: Double
    let lastSeenAt: Double
    let attested: Bool
    let sessionActive: Bool
}

struct RouterSettingsPayload: Codable {
    struct RouterInfo: Codable {
        let host: String
        let model: String
        let firmware: String?
        let cpuPercent: Double?
        let memPercent: Double?
        var guestWifiEnabled: Bool?
        let uptimeSec: Int
        let pollIntervalMs: Int
        let daemonRunning: Bool
        let wanPorts: [WanPortInfo]

        enum CodingKeys: String, CodingKey {
            case host, model, firmware
            case cpuPercent = "cpu_percent"
            case memPercent = "mem_percent"
            case guestWifiEnabled = "guest_wifi_enabled"
            case uptimeSec = "uptime_sec"
            case pollIntervalMs = "poll_interval_ms"
            case daemonRunning = "daemon_running"
            case wanPorts = "wan_ports"
        }
    }

    let ok: Bool
    var router: RouterInfo
    var nsfwEnabled: Bool
    var notificationTypes: [NotificationTypeRow]
    var thresholds: ThresholdConfigPayload
    let deviceAuth: DeviceAuthStatusPayload

    enum CodingKeys: String, CodingKey {
        case ok, router, thresholds
        case nsfwEnabled = "nsfw_enabled"
        case notificationTypes = "notification_types"
        case deviceAuth = "device_auth"
    }
}
