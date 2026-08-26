// The one shared type between the app and the RandoRouteActivity widget
// extension: what a navigation Live Activity displays. This file MUST have
// target membership in BOTH the App target and the RandoRouteActivity
// extension target, or ActivityKit sees two unrelated attribute types and
// the lock-screen card never renders. See docs/IOS-HANDOFF.md §Live
// Activity for the one-time Xcode setup.
import Foundation

#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.2, *)
struct NavigationActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// The glance: "Left turn in 0.2 miles" / "Now: Left turn" —
        /// the same words the in-app banner headline shows.
        var headline: String
        /// The full instruction sentence ("Turn left onto Fremont Ave N").
        var detail: String
        /// SF Symbol name for the maneuver arrow, resolved app-side so the
        /// widget stays a dumb renderer.
        var arrowSymbol: String
        /// Trip line: remaining distance to the destination.
        var meta: String
        /// Arrived renders the card in its terminal state before dismissal.
        var arrived: Bool
    }

    /// Fixed for the ride.
    var destinationName: String
}
#endif
