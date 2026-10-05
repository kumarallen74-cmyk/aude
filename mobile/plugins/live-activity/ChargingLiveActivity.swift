import ActivityKit
import SwiftUI
import WidgetKit

/// The ChargingWidgets extension's only widget: the Live Activity of a charge (iOS 16.2+).
@main
struct ChargingWidgets: WidgetBundle {
    var body: some Widget { ChargingLiveActivity() }
}

struct ChargingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ChargingAttributes.self) { context in
            LockScreenView(attributes: context.attributes, state: context.state, stale: context.isStale)
                .activityBackgroundTint(Color.black.opacity(0.85))
                .activitySystemActionForegroundColor(Color(hex: context.attributes.accentHex))
        } dynamicIsland: { context in
            let accent = Color(hex: context.attributes.accentHex)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.state.energyText, systemImage: "bolt.fill").font(.headline).foregroundStyle(accent)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.finished ? (context.state.costText ?? "") : (context.state.powerText ?? "")).font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Text(context.attributes.site).lineLimit(1)
                        Spacer()
                        if let e = context.state.estimateText, !context.state.finished { Text(e).monospacedDigit() }
                    }.font(.caption).foregroundStyle(.secondary)
                }
            } compactLeading: {
                Image(systemName: context.state.finished ? "checkmark.circle.fill" : "bolt.fill").foregroundStyle(accent)
            } compactTrailing: {
                Text(context.state.energyText).font(.caption2).monospacedDigit()
            } minimal: {
                Image(systemName: "bolt.fill").foregroundStyle(accent)
            }
            .keylineTint(accent)
        }
    }
}

struct LockScreenView: View {
    let attributes: ChargingAttributes
    let state: ChargingAttributes.ContentState
    let stale: Bool
    var body: some View {
        let accent = Color(hex: attributes.accentHex)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "bolt.fill").foregroundStyle(accent)
                Text(attributes.site).font(.headline).lineLimit(1)
                Spacer()
                if stale { Image(systemName: "exclamationmark.arrow.triangle.2.circlepath").foregroundStyle(.secondary) }
            }
            HStack(alignment: .firstTextBaseline) {
                Text(state.energyText).font(.system(size: 30, weight: .bold, design: .rounded)).monospacedDigit()
                Spacer()
                VStack(alignment: .trailing) {
                    if let p = state.powerText, !state.finished { Text(p).font(.headline) }
                    if let c = state.finished ? state.costText : state.estimateText { Text(c).font(.subheadline).foregroundStyle(.secondary) }
                }
            }
            if let pct = state.progressPct ?? state.socPercent {
                ProgressView(value: Double(pct), total: 100).tint(accent)
            }
        }
        .padding()
        .foregroundStyle(.white)
    }
}

extension Color {
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}
