import SwiftUI

@main
struct MyLegacyTapeApp: App {
    @StateObject private var pendingPair = PendingPairingState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(pendingPair)
                .onOpenURL { url in
                    // Handles legacytape://pair?d=LT-XXXXXX&t=<32hex> arriving from the
                    // iOS system Camera app. Works whether the user is signed in or not:
                    // PendingPairingState holds the intent until login completes.
                    if let parsed = PairingURL(from: url) {
                        pendingPair.intent = parsed
                    }
                }
        }
    }
}
