import Foundation
import Combine

/// Stores a QR-derived pairing intent that arrived before the user was authenticated
/// or before the WKWebView had finished loading. Shared via SwiftUI environment.
@MainActor
final class PendingPairingState: ObservableObject {
    @Published var intent: PairingURL?
}
