import ActivityKit
import ExpoModulesCore

/// JS ↔ ActivityKit: start / update / end the charging Live Activity and forward its APNs update token
/// (the backend pushes updates while the app is in the background: POST /d/v1/live-activities).
public class PlugSureLiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PlugSureLiveActivity")
    Events("onPushToken")

    Function("isSupported") { () -> Bool in
      if #available(iOS 16.2, *) { return ActivityAuthorizationInfo().areActivitiesEnabled }
      return false
    }

    AsyncFunction("start") { (attributes: [String: String], state: [String: Any]) -> String? in
      guard #available(iOS 16.2, *) else { return nil }
      let attrs = ChargingAttributes(
        ref: attributes["ref"] ?? "", site: attributes["site"] ?? "", connector: attributes["connector"] ?? "",
        appName: attributes["appName"] ?? "", accentHex: attributes["accentHex"] ?? "#2fd6a7")
      let content = ActivityContent(state: try Self.decode(state), staleDate: Date().addingTimeInterval(180))
      let activity = try Activity.request(attributes: attrs, content: content, pushType: .token)
      Task {
        for await data in activity.pushTokenUpdates {
          let token = data.map { String(format: "%02x", $0) }.joined()
          self.sendEvent("onPushToken", ["activityId": activity.id, "token": token])
        }
      }
      return activity.id
    }

    AsyncFunction("update") { (id: String, state: [String: Any], staleAfter: Double) in
      guard #available(iOS 16.2, *) else { return }
      guard let a = Activity<ChargingAttributes>.activities.first(where: { $0.id == id }) else { return }
      await a.update(ActivityContent(state: try Self.decode(state), staleDate: Date().addingTimeInterval(staleAfter)))
    }

    AsyncFunction("end") { (id: String, state: [String: Any], dismissAfter: Double) in
      guard #available(iOS 16.2, *) else { return }
      guard let a = Activity<ChargingAttributes>.activities.first(where: { $0.id == id }) else { return }
      await a.end(ActivityContent(state: try Self.decode(state), staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(dismissAfter)))
    }
  }

  static func decode(_ dict: [String: Any]) throws -> ChargingAttributes.ContentState {
    let clean = dict.filter { !($0.value is NSNull) }
    let data = try JSONSerialization.data(withJSONObject: clean)
    return try JSONDecoder().decode(ChargingAttributes.ContentState.self, from: data)
  }
}
