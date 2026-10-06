import Foundation

/// Parses `legacytape://pair?d=LT-XXXXXX&t=<32hex>` emitted by the device QR code.
struct PairingURL: Equatable {
    /// Hardware identifier advertised by the device, e.g. "LT-A1B2C3".
    let hardwareId: String
    /// 32-character lowercase hex token that must be echoed back in the BLE payload.
    let token: String

    init?(from url: URL) {
        guard url.scheme?.lowercased() == "legacytape",
              url.host?.lowercased() == "pair" else { return nil }

        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let d = components.queryItems?.first(where: { $0.name == "d" })?.value,
              let t = components.queryItems?.first(where: { $0.name == "t" })?.value
        else { return nil }

        guard d.hasPrefix("LT-"), d.count >= 4,
              t.count == 32, t.allSatisfy(\.isHexDigit)
        else { return nil }

        self.hardwareId = d
        self.token = t.lowercased()
    }
}
