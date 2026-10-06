import AVFoundation
import Combine
import CoreBluetooth
import Foundation
import UIKit
import WebKit

// MARK: - PairingBridge

/// Native bridge that handles QR scanning (AVFoundation) and BLE pairing (CoreBluetooth).
/// Exposes `window.__pairingBridge` to the React app via WKScriptMessageHandler.
///
/// FIRMWARE CONTRACT (confirmed with firmware engineer):
///   1. Device includes service UUID in primary advertisement → scanForPeripherals(withServices:) works.
///   2. Full name "LegacyTape-LT-XXXXXX" is in scan response → only available via peripheral.name
///      AFTER connect, not in didDiscover advertisementData.
///   3. App disconnects first after 0x03; device has 30s safety-net self-disconnect.
///   4. Device requests MTU 247; write confirmed safe as single ATT op for our ~170-byte payload.
///   5. No BLE bonding / encryption in v1.
@MainActor
final class PairingBridge: NSObject, WKScriptMessageHandler, ObservableObject {

    static let serviceUUID    = CBUUID(string: "1ec0de7a-7e2d-4f4f-9c1d-1ec0de7a0001")
    static let pairCharUUID   = CBUUID(string: "1ec0de7a-7e2d-4f4f-9c1d-1ec0de7a0002")
    static let statusCharUUID = CBUUID(string: "1ec0de7a-7e2d-4f4f-9c1d-1ec0de7a0003")
    // Phase 2 (requires firmware support): device scans WiFi networks while in pairing mode
    // and writes a JSON array [{"ssid":"...","rssi":-45},...] to this characteristic.
    static let wifiListCharUUID = CBUUID(string: "1ec0de7a-7e2d-4f4f-9c1d-1ec0de7a0004")

    private weak var webView: WKWebView?

    // Deep-link delivery gating: hold the URL until the webview has loaded.
    private var isWebViewReady = false
    private var pendingDeepLink: PairingURL?

    // BLE state
    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var pairChar: CBCharacteristic?
    private var statusChar: CBCharacteristic?
    private var wifiListChar: CBCharacteristic?
    private var wifiDelivered = false   // true once a non-empty list arrives → stop polling
    private var pendingPayload: Data?
    private var targetHardwareId: String?
    private var timeoutTask: Task<Void, Never>?
    /// When true the bridge connects and reads the WiFi list but does NOT write
    /// the payload until JS calls `pair()` with the chosen credentials.
    private var scanModeOnly = false

    func attach(to webView: WKWebView) {
        self.webView = webView
    }

    // MARK: - Deep link from system camera or cold start

    /// Called when a `legacytape://pair?...` URL arrives.
    /// If the webview isn't ready yet the URL is buffered and delivered in `webViewDidLoad()`.
    func handleDeepLink(_ parsed: PairingURL) {
        guard isWebViewReady else {
            pendingDeepLink = parsed
            return
        }
        deliverQRToJS(parsed)
    }

    /// Called by the WKNavigationDelegate once the app's initial page load completes.
    func webViewDidLoad() {
        isWebViewReady = true
        if let pending = pendingDeepLink {
            pendingDeepLink = nil
            deliverQRToJS(pending)
        }
    }

    private func deliverQRToJS(_ parsed: PairingURL) {
        sendToJS("""
        (function() {
            window.__pendingPairingQR = { hardwareId: "\(parsed.hardwareId)", token: "\(parsed.token)" };
            window.location.hash = '#/device-setup';
        })();
        """)
    }

    // MARK: - WKScriptMessageHandler (JS → Native)

    nonisolated func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        Task { @MainActor in
            switch action {
            case "startQRScan":
                self.startQRScan()

            case "connectBLE":
                // Step 1 of the two-step WiFi-list flow: connect to the device
                // and read available networks before asking the user for a password.
                guard let hwId = body["hardwareId"] as? String else { return }
                self.beginScan(hardwareId: hwId)

            case "pair":
                guard let hwId  = body["hardwareId"] as? String,
                      let token = body["token"] as? String,
                      let ssid  = body["ssid"] as? String,
                      let pw    = body["pw"] as? String,
                      let acct  = body["acct"] as? String
                else { return }
                let ssid2 = body["ssid2"] as? String
                let pw2   = body["pw2"] as? String

                // Build the payload dict.
                var dict: [String: Any] = ["token": token, "ssid": ssid, "pw": pw, "acct": acct]
                if let s2 = ssid2, let p2 = pw2, !s2.isEmpty, !p2.isEmpty {
                    dict["ssid2"] = s2; dict["pw2"] = p2
                }
                guard let data = try? JSONSerialization.data(withJSONObject: dict) else {
                    self.sendStatusByte(0xE2); return
                }

                if self.peripheral != nil, self.pairChar != nil {
                    // Already connected from a prior connectBLE call — write directly.
                    self.scanModeOnly = false
                    self.pendingPayload = data
                    self.writePayloadIfReady()
                } else {
                    // No existing connection — do the full scan + connect + write.
                    self.beginPairing(
                        hardwareId: hwId, token: token,
                        ssid: ssid, pw: pw, ssid2: ssid2, pw2: pw2,
                        acct: acct
                    )
                }

            case "cancel":
                self.teardown()

            default:
                break
            }
        }
    }

    // MARK: - QR Scanning (in-app camera)

    private func startQRScan() {
        guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let root = windowScene.windows.first?.rootViewController else { return }

        let vc = QRScannerViewController()

        vc.onResult = { [weak self] string in
            Task { @MainActor [weak self] in
                vc.dismiss(animated: true)
                guard let self else { return }
                if let url = URL(string: string), let parsed = PairingURL(from: url) {
                    self.sendToJS("""
                    window.__onQRResult && window.__onQRResult({
                        hardwareId: "\(parsed.hardwareId)",
                        token: "\(parsed.token)"
                    });
                    """)
                } else {
                    self.sendToJS(
                        "window.__onQRError && window.__onQRError('Invalid QR — expected legacytape://pair?...')"
                    )
                }
            }
        }

        vc.onCancel = { [weak self] in
            Task { @MainActor [weak self] in
                vc.dismiss(animated: true)
                self?.sendToJS("window.__onQRError && window.__onQRError('cancelled')")
            }
        }

        vc.modalPresentationStyle = .fullScreen
        root.present(vc, animated: true)
    }

    // MARK: - BLE Pairing

    private func beginPairing(
        hardwareId: String, token: String,
        ssid: String, pw: String,
        ssid2: String?, pw2: String?,
        acct: String
    ) {
        teardown()
        targetHardwareId = hardwareId

        // WiFi credentials are sent over BLE only — never persisted to Supabase.
        var dict: [String: Any] = ["token": token, "ssid": ssid, "pw": pw, "acct": acct]
        // Include secondary WiFi if both fields are present (gifted device auto-connects at recipient's home).
        if let s2 = ssid2, let p2 = pw2, !s2.isEmpty, !p2.isEmpty {
            dict["ssid2"] = s2
            dict["pw2"] = p2
        }
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else {
            sendStatusByte(0xE2)
            return
        }
        pendingPayload = data

        central = CBCentralManager(delegate: self, queue: .main)

        timeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.sendStatusByte(0xE4)
                self?.teardown()
            }
        }
    }

    /// Connects to the device and reads its WiFi scan list without writing a payload.
    /// Delivers `window.__onWifiList([...])` to JS when the list arrives.
    /// If the device doesn't have the WiFi-list characteristic, delivers `[]` so JS
    /// falls back to manual SSID entry.  A 15-second timeout does the same.
    private func beginScan(hardwareId: String) {
        teardown()
        scanModeOnly = true
        wifiDelivered = false
        targetHardwareId = hardwareId
        central = CBCentralManager(delegate: self, queue: .main)

        stage("scan_begin", hardwareId)

        timeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled else { return }
            await MainActor.run { [weak self] in
                guard let self, self.scanModeOnly else { return }
                self.stage("timeout", self.peripheral == nil ? "never_connected" : "connected_no_list")
                self.sendToJS("window.__onWifiListRaw && window.__onWifiListRaw('[]', 0)")
            }
        }
    }

    /// Writes `pendingPayload` to the pair characteristic.
    /// Assumes the peripheral is already connected; subscribes to status first if needed.
    private func writePayloadIfReady() {
        guard let peripheral,
              let pairChar,
              let payload = pendingPayload else { return }

        // Restart the 30-second payload-delivery timeout.
        timeoutTask?.cancel()
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.sendStatusByte(0xE4)
                self?.teardown()
            }
        }

        if statusChar?.isNotifying == true {
            let maxLen = peripheral.maximumWriteValueLength(for: .withResponse)
            guard payload.count <= maxLen else {
                sendStatusByte(0xE2); teardown(); return
            }
            peripheral.writeValue(payload, for: pairChar, type: .withResponse)
        } else if let sc = statusChar {
            // Subscribe; payload will be written in didUpdateNotificationStateFor.
            peripheral.setNotifyValue(true, for: sc)
        }
    }

    private func teardown() {
        timeoutTask?.cancel()
        timeoutTask = nil
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        central?.stopScan()
        central = nil
        peripheral = nil
        pairChar = nil
        statusChar = nil
        wifiListChar = nil
        pendingPayload = nil
        targetHardwareId = nil
        scanModeOnly = false
    }

    // MARK: - Helpers

    private func sendStatusByte(_ byte: UInt8) {
        sendToJS("window.__onPairingStatus && window.__onPairingStatus(\(byte))")
    }

    /// Reports which step of the BLE handshake we reached. JS (DeviceSetup, in
    /// Testing Mode) mirrors these to `debug_logs` so a failed pairing can be
    /// diagnosed server-side without a serial cable on the device. Purely
    /// observational — no behavior depends on it.
    private func stage(_ name: String, _ detail: String = "") {
        let d = detail
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        sendToJS("window.__onBleStage && window.__onBleStage('\(name)', '\(d)')")
    }

    /// Hand the raw WiFi-list bytes to JS as a string (JS does the JSON.parse so
    /// a truncated/invalid payload is caught instead of silently failing), plus
    /// the byte count for the admin debug readout.
    private func deliverWifiList(_ data: Data) {
        let raw = String(data: data, encoding: .utf8) ?? ""
        // A non-empty payload means the scan produced networks → stop polling.
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count > 2 && trimmed != "[]" {
            wifiDelivered = true
        }
        let escaped = raw
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
        sendToJS("window.__onWifiListRaw && window.__onWifiListRaw('\(escaped)', \(data.count))")
    }

    private func sendToJS(_ js: String) {
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }
}

// MARK: - CBCentralManagerDelegate

extension PairingBridge: CBCentralManagerDelegate {

    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { @MainActor in
            switch central.state {
            case .poweredOn:
                self.stage("bt_powered_on")
                // Firmware advertises the service UUID in its primary packet.
                central.scanForPeripherals(withServices: [PairingBridge.serviceUUID])
            case .poweredOff, .unauthorized, .unsupported:
                self.stage("bt_unavailable", "\(central.state.rawValue)")
                self.sendStatusByte(0xE4)
                self.teardown()
            default:
                // .unknown / .resetting — typically the permission prompt is still
                // pending on a fresh install. Nothing scans until it resolves.
                self.stage("bt_pending", "\(central.state.rawValue)")
            }
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        Task { @MainActor in
            // Service UUID match is sufficient here. Full device name "LegacyTape-LT-XXXXXX"
            // lives in the scan response and is available via peripheral.name AFTER connecting.
            // Hardware-ID verification happens in centralManager(_:didConnect:).
            guard self.targetHardwareId != nil, self.peripheral == nil else { return }
            self.stage("discovered", "rssi=\(RSSI.intValue) name=\(peripheral.name ?? "nil")")
            self.peripheral = peripheral
            central.stopScan()
            central.connect(peripheral)
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager, didConnect peripheral: CBPeripheral
    ) {
        Task { @MainActor in
            guard let hwId = self.targetHardwareId else { return }

            // Scan response is now resolved — peripheral.name is the full name.
            let expectedName = "LegacyTape-\(hwId)"
            guard peripheral.name == expectedName else {
                // Wrong device connected (shouldn't happen in practice, but be safe).
                // This loops silently — the stage log is the only way to see it.
                self.stage("name_mismatch", "got=\(peripheral.name ?? "nil") want=\(expectedName)")
                central.cancelPeripheralConnection(peripheral)
                self.peripheral = nil
                central.scanForPeripherals(withServices: [PairingBridge.serviceUUID])
                return
            }

            self.stage("connected", expectedName)
            peripheral.delegate = self
            peripheral.discoverServices([PairingBridge.serviceUUID])
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        Task { @MainActor in
            self.stage("connect_failed", error?.localizedDescription ?? "")
            self.sendStatusByte(0xE4)
            self.teardown()
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        // Expected after app calls cancelPeripheralConnection on success.
        // Device has a 30s safety-net self-disconnect if app fails to disconnect.
        // An UNEXPECTED drop mid-scan is otherwise invisible (it just rides out
        // the timeout), so record it.
        Task { @MainActor in
            self.stage("disconnected", error?.localizedDescription ?? "clean")
        }
    }
}

// MARK: - CBPeripheralDelegate

extension PairingBridge: CBPeripheralDelegate {

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        Task { @MainActor in
            guard error == nil,
                  let service = peripheral.services?.first(where: {
                      $0.uuid == PairingBridge.serviceUUID
                  })
            else {
                self.stage("services_failed", error?.localizedDescription ?? "service not found")
                self.sendStatusByte(0xE4)
                self.teardown()
                return
            }
            self.stage("services_ok")
            peripheral.discoverCharacteristics(
                [PairingBridge.pairCharUUID,
                 PairingBridge.statusCharUUID,
                 PairingBridge.wifiListCharUUID],
                for: service
            )
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        Task { @MainActor in
            guard error == nil, let chars = service.characteristics else {
                self.stage("chars_failed", error?.localizedDescription ?? "")
                self.sendStatusByte(0xE4)
                self.teardown()
                return
            }
            let found = chars.map { $0.uuid.uuidString.suffix(4) }.joined(separator: ",")
            self.stage("chars_ok", found)
            for char in chars {
                switch char.uuid {
                case PairingBridge.statusCharUUID:
                    self.statusChar = char
                    // Subscribing triggers didUpdateNotificationStateFor once confirmed.
                    // The payload write happens there, after MTU negotiation is settled.
                    peripheral.setNotifyValue(true, for: char)
                case PairingBridge.pairCharUUID:
                    self.pairChar = char
                case PairingBridge.wifiListCharUUID:
                    // Phase 2: the device scans nearby WiFi (~3s) and NOTIFIES the
                    // JSON array when the scan finishes. Subscribe for the
                    // notification — do NOT do a one-shot read: an immediate read
                    // returns the initial empty list before the scan completes (and
                    // would prematurely show "No networks found"). Staying subscribed
                    // also means a later/rescan result updates the list automatically.
                    self.wifiListChar = char
                    peripheral.setNotifyValue(true, for: char)
                default:
                    break
                }
            }
        }
    }

    /// Fires once the status-characteristic subscription is confirmed by the device.
    /// MTU negotiation is complete at this point.
    nonisolated func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        Task { @MainActor in
            if let error, characteristic.uuid == PairingBridge.statusCharUUID {
                // Subscribe refused → reads are never issued → rides out the timeout.
                self.stage("subscribe_failed", error.localizedDescription)
            }
            guard error == nil,
                  characteristic.uuid == PairingBridge.statusCharUUID,
                  characteristic.isNotifying
            else { return }

            self.stage("subscribed_0003")
            if self.scanModeOnly {
                // WiFi-list flow: connection is ready.
                guard let wlc = self.wifiListChar else {
                    // Device has no WiFi-list characteristic — nothing to show.
                    self.stage("no_wifi_char")
                    self.timeoutTask?.cancel()
                    self.sendToJS("window.__onWifiListRaw && window.__onWifiListRaw('[]', 0)")
                    return
                }
                // We subscribed to notify in didDiscoverCharacteristics. As the
                // primary, reliable path, also READ the characteristic a few
                // times while the device's ~3s scan completes — reads
                // auto-reassemble long values (no notify truncation) and work
                // even if the device doesn't push a notification. Whichever
                // delivery has the populated list wins; polling stops once a
                // non-empty list arrives (wifiDelivered).
                self.stage("read_issued", "t=0")
                peripheral.readValue(for: wlc)
                for delay in [2.0, 3.5, 5.0, 7.0, 10.0] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                        guard let self, self.scanModeOnly, !self.wifiDelivered,
                              let p = self.peripheral else { return }
                        self.stage("read_issued", "t=\(delay)")
                        p.readValue(for: wlc)
                    }
                }
                return
            }

            // Normal pair mode — write payload.
            guard let pairChar = self.pairChar,
                  let payload = self.pendingPayload else { return }

            let maxLen = peripheral.maximumWriteValueLength(for: .withResponse)
            guard payload.count <= maxLen else {
                self.sendStatusByte(0xE2)
                self.teardown()
                return
            }
            peripheral.writeValue(payload, for: pairChar, type: .withResponse)
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        Task { @MainActor in
            if let error, characteristic.uuid == PairingBridge.wifiListCharUUID {
                self.stage("read_failed", error.localizedDescription)
            }
            guard error == nil, let data = characteristic.value else { return }

            switch characteristic.uuid {

            case PairingBridge.wifiListCharUUID:
                // Deliver the raw WiFi-list payload to JS, which parses it safely
                // (a truncated/invalid notify can't silently become "no networks"),
                // and reports the byte count for the admin debug readout.
                self.stage("read_value", "bytes=\(data.count)")
                self.timeoutTask?.cancel()
                self.deliverWifiList(data)

            case PairingBridge.statusCharUUID:
                guard let byte = data.first else { return }
                self.sendStatusByte(byte)
                switch byte {
                case 0x03:
                    // Success — app disconnects; device stays connected up to its 30s safety net.
                    self.timeoutTask?.cancel()
                    self.central?.cancelPeripheralConnection(peripheral)
                    self.teardown()
                case 0xE0...:
                    self.timeoutTask?.cancel()
                    self.teardown()
                default:
                    break
                }

            default:
                break
            }
        }
    }

    nonisolated func peripheral(
        _ peripheral: CBPeripheral,
        didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        Task { @MainActor in
            if error != nil {
                self.sendStatusByte(0xE4)
                self.teardown()
            }
        }
    }
}

// MARK: - QRScannerViewController

private final class QRScannerViewController: UIViewController,
    AVCaptureMetadataOutputObjectsDelegate
{
    var onResult: ((String) -> Void)?
    var onCancel: (() -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "lt.qr.session")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasDelivered = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupCapture()
        setupOverlay()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        sessionQueue.async { [weak self] in self?.session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [weak self] in self?.session.stopRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    private func setupCapture() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return }

        session.beginConfiguration()
        if session.canAddInput(input) { session.addInput(input) }

        let output = AVCaptureMetadataOutput()
        if session.canAddOutput(output) {
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
        }
        session.commitConfiguration()

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.insertSublayer(preview, at: 0)
        previewLayer = preview
    }

    private func setupOverlay() {
        let size: CGFloat = 240
        let cx = view.bounds.midX
        let cy = view.bounds.height * 0.44
        let finderRect = CGRect(x: cx - size / 2, y: cy - size / 2, width: size, height: size)

        let overlay = UIView(frame: view.bounds)
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        view.addSubview(overlay)

        let maskPath = UIBezierPath(rect: view.bounds)
        maskPath.append(UIBezierPath(roundedRect: finderRect, cornerRadius: 16).reversing())
        let maskLayer = CAShapeLayer()
        maskLayer.path = maskPath.cgPath
        overlay.layer.mask = maskLayer

        let border = UIView(frame: finderRect)
        border.layer.borderColor = UIColor.white.withAlphaComponent(0.85).cgColor
        border.layer.borderWidth = 1.5
        border.layer.cornerRadius = 16
        view.addSubview(border)

        addCornerBrackets(around: finderRect)

        let label = UILabel()
        label.text = "Scan the QR code on your\nLegacyTape device"
        label.textColor = .white
        label.font = .systemFont(ofSize: 16, weight: .semibold)
        label.textAlignment = .center
        label.numberOfLines = 2
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.bottomAnchor.constraint(equalTo: border.topAnchor, constant: -20),
        ])

        let cancelBtn = UIButton(type: .system)
        cancelBtn.setTitle("Cancel", for: .normal)
        cancelBtn.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
        cancelBtn.tintColor = .white
        cancelBtn.translatesAutoresizingMaskIntoConstraints = false
        cancelBtn.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        view.addSubview(cancelBtn)
        NSLayoutConstraint.activate([
            cancelBtn.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancelBtn.topAnchor.constraint(equalTo: border.bottomAnchor, constant: 28),
        ])
    }

    private func addCornerBrackets(around rect: CGRect) {
        let len: CGFloat = 22
        let thick: CGFloat = 3
        let corners: [(x: CGFloat, y: CGFloat, xDir: CGFloat, yDir: CGFloat)] = [
            (rect.minX, rect.minY,  1,  1),
            (rect.maxX, rect.minY, -1,  1),
            (rect.minX, rect.maxY,  1, -1),
            (rect.maxX, rect.maxY, -1, -1),
        ]
        for c in corners {
            let h = UIView(frame: CGRect(
                x: c.xDir > 0 ? c.x : c.x - len, y: c.y - thick / 2,
                width: len, height: thick
            ))
            h.backgroundColor = .white
            let v = UIView(frame: CGRect(
                x: c.x - thick / 2, y: c.yDir > 0 ? c.y : c.y - len,
                width: thick, height: len
            ))
            v.backgroundColor = .white
            view.addSubview(h)
            view.addSubview(v)
        }
    }

    @objc private func cancelTapped() { onCancel?() }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !hasDelivered,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let string = obj.stringValue
        else { return }
        hasDelivered = true
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onResult?(string)
    }
}
