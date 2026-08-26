// Widget bundle entry point for the RandoRouteActivity extension target.
// Replaces the Xcode template's generated bundle; this extension ships the
// navigation Live Activity and nothing else (no home-screen widgets).
import SwiftUI
import WidgetKit

@main
struct RandoRouteActivityBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 16.2, *) {
            NavigationLiveActivity()
        }
    }
}
