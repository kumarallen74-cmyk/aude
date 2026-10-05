import ActivityKit
import Foundation

/// A charge under way, on the Lock Screen and in the Dynamic Island.
/// Target membership: the App (via modules/live-activity) AND the ChargingWidgets extension.
/// Keep the property names: the PlugSure backend sends them (content-state + attributes); times are Unix seconds.
struct ChargingAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var status: String          // "charging" or "finished"
        var energyWh: Int
        var powerW: Int?
        var socPercent: Int?
        var progressPct: Int?       // of a prepaid allowance
        var costIdr: Int?           // the final cost (minor units of `currency`), once rated
        var estimateIdr: Int?       // the cost so far while charging; nil once final
        var startedAt: Int
        var endedAt: Int?
        var currency: String?       // absent = IDR (wire contract)
    }
    var ref: String
    var site: String
    var connector: String
    var appName: String
    var accentHex: String
}

extension ChargingAttributes.ContentState {
    var started: Date { Date(timeIntervalSince1970: TimeInterval(startedAt)) }
    var ended: Date? { endedAt.map { Date(timeIntervalSince1970: TimeInterval($0)) } }
    var finished: Bool { status == "finished" }
    var energyText: String { String(format: "%.1f kWh", Double(energyWh) / 1000) }
    var powerText: String? { powerW.map { "\(Int((Double($0) / 1000).rounded())) kW" } }

    /// Money in the session's currency: IDR has no decimals in PlugSure minor units; MYR / SGD have two.
    static func money(_ minor: Int, _ currency: String?) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        switch currency ?? "IDR" {
        case "MYR":
            f.minimumFractionDigits = 2; f.maximumFractionDigits = 2
            return "RM " + (f.string(from: NSNumber(value: Double(minor) / 100)) ?? "\(minor)")
        case "SGD":
            f.minimumFractionDigits = 2; f.maximumFractionDigits = 2
            return "S$ " + (f.string(from: NSNumber(value: Double(minor) / 100)) ?? "\(minor)")
        default:
            f.locale = Locale(identifier: "id_ID")
            return "Rp " + (f.string(from: NSNumber(value: minor)) ?? "\(minor)")
        }
    }
    var costText: String? { costIdr.map { Self.money($0, currency) } }
    var estimateText: String? { estimateIdr.map { Self.money($0, currency) } }
}
