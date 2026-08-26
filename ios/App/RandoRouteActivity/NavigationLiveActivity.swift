// Lock-screen and Dynamic Island rendering for the navigation Live
// Activity. Pure presentation: every string and symbol arrives resolved in
// the ContentState, so this stays in lockstep with the in-app banner
// without duplicating any guidance logic. The app process updates the
// activity from its background location stream (BridgeViewController);
// no push tokens are involved.
import SwiftUI
import WidgetKit

#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.2, *)
struct NavigationLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NavigationActivityAttributes.self) { context in
            // Lock screen / banner presentation.
            HStack(spacing: 14) {
                Image(systemName: context.state.arrowSymbol)
                    .font(.system(size: 34, weight: .bold))
                    .frame(width: 52, height: 52)
                    .background(Color(red: 0.09, green: 0.31, blue: 0.27).opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.state.headline)
                        .font(.title2.bold())
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(context.state.detail)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Text(context.state.meta)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .activityBackgroundTint(Color(red: 0.965, green: 1.0, blue: 0.984))
            .activitySystemActionForegroundColor(Color(red: 0.09, green: 0.31, blue: 0.27))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: context.state.arrowSymbol)
                        .font(.system(size: 28, weight: .bold))
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.headline)
                            .font(.headline.bold())
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                        Text(context.state.detail)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.meta)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            } compactLeading: {
                Image(systemName: context.state.arrowSymbol)
                    .font(.system(size: 15, weight: .bold))
            } compactTrailing: {
                // The shortest useful glance: just the distance figure from
                // the headline ("…in 500 feet" -> "500 ft").
                Text(compactDistance(context.state.headline))
                    .font(.caption2.bold())
            } minimal: {
                Image(systemName: context.state.arrowSymbol)
                    .font(.system(size: 13, weight: .bold))
            }
        }
    }
}

@available(iOS 16.2, *)
private func compactDistance(_ headline: String) -> String {
    guard let range = headline.range(of: " in ") else { return "Now" }
    return String(headline[range.upperBound...])
        .replacingOccurrences(of: " feet", with: " ft")
        .replacingOccurrences(of: " miles", with: " mi")
}
#endif
