import ActivityKit
import ExpoModulesCore

/// JS ↔ ActivityKit: start / update / end the charging Live Activity and forward its APNs update token
/// (the backend pushes updates while the app is in the background: POST /d/v1/live-sessions).
///
/// - Every `onPushToken` event carries the activity's `ref` (attributes.ref) as well as its id, so JS can register a
///   token that arrives before `start` resolved.
/// - Activities outlive the app process: `start` reuses a running activity of the same `ref` (no duplicate after a
///   kill + relaunch), and `list` returns the running ones so JS can adopt them at launch (it also re-subscribes to
///   their token updates).
/// The pod's (and the app's) deployment target is iOS 16.4, so ActivityKit 16.2 APIs need no availability checks.
public class PlugSureLiveActivityModule: Module {
  /// Activity ids whose pushTokenUpdates are already observed (one observer per activity per process).
  private var observed = Set<String>()
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("PlugSureLiveActivity")
    Events("onPushToken")

    Function("isSupported") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// The running (active or stale) charging activities: [{ id, ref }]. Starts forwarding their tokens.
    AsyncFunction("list") { () -> [[String: String]] in
      return Self.running().map { (a: Activity<ChargingAttributes>) -> [String: String] in
        self.observeTokens(a)
        return ["id": a.id, "ref": a.attributes.ref]
      }
    }

    AsyncFunction("start") { (attributes: [String: String], state: [String: Any]) -> String? in
      let ref = attributes["ref"] ?? ""
      let decoded = try Self.decode(state)
      // Already on the Lock Screen (started before the app was killed, or pushed-to-start): adopt and update it.
      if !ref.isEmpty, let existing = Self.running().first(where: { $0.attributes.ref == ref }) {
        self.observeTokens(existing)
        await existing.update(ActivityContent(state: decoded, staleDate: Date().addingTimeInterval(180)))
        return existing.id
      }
      let attrs = ChargingAttributes(
        ref: ref, site: attributes["site"] ?? "", connector: attributes["connector"] ?? "",
        appName: attributes["appName"] ?? "", accentHex: attributes["accentHex"] ?? "#2fd6a7")
      let content = ActivityContent(state: decoded, staleDate: Date().addingTimeInterval(180))
      let activity = try Activity.request(attributes: attrs, content: content, pushType: .token)
      self.observeTokens(activity)
      return activity.id
    }

    AsyncFunction("update") { (id: String, state: [String: Any], staleAfter: Double) in
      guard let a = Activity<ChargingAttributes>.activities.first(where: { $0.id == id }) else { return }
      await a.update(ActivityContent(state: try Self.decode(state), staleDate: Date().addingTimeInterval(staleAfter)))
    }

    AsyncFunction("end") { (id: String, state: [String: Any], dismissAfter: Double) in
      guard let a = Activity<ChargingAttributes>.activities.first(where: { $0.id == id }) else { return }
      await a.end(ActivityContent(state: try Self.decode(state), staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(dismissAfter)))
    }
  }

  static func running() -> [Activity<ChargingAttributes>] {
    Activity<ChargingAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
  }

  /// Forward the activity's current token (if any) and every later one, once per activity.
  private func observeTokens(_ activity: Activity<ChargingAttributes>) {
    lock.lock()
    let isNew = observed.insert(activity.id).inserted
    lock.unlock()
    let ref = activity.attributes.ref
    if let current = activity.pushToken {
      sendEvent("onPushToken", ["activityId": activity.id, "ref": ref, "token": Self.hex(current)])
    }
    guard isNew else { return }
    Task { [weak self] in
      for await data in activity.pushTokenUpdates {
        self?.sendEvent("onPushToken", ["activityId": activity.id, "ref": ref, "token": Self.hex(data)])
      }
      self?.lock.lock()
      self?.observed.remove(activity.id)
      self?.lock.unlock()
    }
  }

  static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }

  static func decode(_ dict: [String: Any]) throws -> ChargingAttributes.ContentState {
    let clean = dict.filter { !($0.value is NSNull) }
    let data = try JSONSerialization.data(withJSONObject: clean)
    return try JSONDecoder().decode(ChargingAttributes.ContentState.self, from: data)
  }
}
