//
//  MyLegacyTapeTests.swift
//  MyLegacyTapeTests
//
//  Created by Brett Chiate on 4/15/26.
//

import Foundation
import Testing
@testable import MyLegacyTape

/// The QR code on the device's pairing screen: legacytape://pair?d=<hardware id>&t=<token>.
@MainActor
struct PairingURLTests {

    @Test func readsTheDeviceQRCode() throws {
        let url = try #require(URL(string: "legacytape://pair?d=LT-A1B2C3&t=8C4A7B9E6F1D2A3B5C4D6E7F8A9B0C1D"))
        let parsed = try #require(PairingURL(from: url))
        #expect(parsed.hardwareId == "LT-A1B2C3")
        #expect(parsed.token == "8c4a7b9e6f1d2a3b5c4d6e7f8a9b0c1d")
    }

    @Test(arguments: [
        "https://example.com/pair?d=LT-A1B2C3&t=8c4a7b9e6f1d2a3b5c4d6e7f8a9b0c1d",
        "legacytape://setup?d=LT-A1B2C3&t=8c4a7b9e6f1d2a3b5c4d6e7f8a9b0c1d",
        "legacytape://pair?d=XX-A1B2C3&t=8c4a7b9e6f1d2a3b5c4d6e7f8a9b0c1d",
        "legacytape://pair?d=LT-A1B2C3&t=8c4a7b9e",
        "legacytape://pair?d=LT-A1B2C3&t=zz4a7b9e6f1d2a3b5c4d6e7f8a9b0c1d",
        "legacytape://pair?d=LT-A1B2C3",
    ])
    func ignoresOtherCodes(_ text: String) throws {
        let url = try #require(URL(string: text))
        #expect(PairingURL(from: url) == nil)
    }
}
