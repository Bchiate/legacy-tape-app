import Foundation
import AVFoundation
import Speech
import WebKit

@MainActor
final class SpeechBridge: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let synthesizer = AVSpeechSynthesizer()
    private var isPaused = false
    private var ttsDelegate: TTSDelegate?

    func attach(to webView: WKWebView) {
        self.webView = webView
    }

    nonisolated func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        Task { @MainActor in
            switch action {
            case "start":  self.startRecording()
            case "pause":  self.pauseRecording()
            case "resume": self.resumeRecording()
            case "stop":   self.stopRecording()
            case "speak":
                if let text = body["text"] as? String {
                    self.speakText(text)
                }
            case "transcribeFile":
                if let urlStr = body["url"] as? String,
                   let recordingId = body["recordingId"] as? String,
                   let url = URL(string: urlStr) {
                    self.transcribeFile(url: url, recordingId: recordingId)
                }
            default: break
            }
        }
    }

    private func transcribeFile(url: URL, recordingId: String) {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor in
                guard let self else { return }
                guard status == .authorized else {
                    self.sendFileTranscribeError(recordingId: recordingId, message: "Speech recognition not authorized")
                    return
                }
                self.downloadAndRecognize(url: url, recordingId: recordingId)
            }
        }
    }

    private func downloadAndRecognize(url: URL, recordingId: String) {
        let task = URLSession.shared.downloadTask(with: url) { [weak self] tempURL, response, error in
            // URLSession deletes `tempURL` the instant this closure RETURNS. Everything
            // that touches the file has to happen synchronously here — hopping to the
            // main actor first (the old code) raced the cleanup and lost often enough
            // to produce "Could not stage WAV: …CFNetworkDownload_….tmp couldn't be
            // moved" on short recordings. Only the JS callbacks need the main actor.
            let staged: Result<URL, StageError>
            if let error {
                staged = .failure(StageError("Download failed: \(error.localizedDescription)"))
            } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                // A signed URL that 404s/expires still "succeeds" as a download —
                // the body is an error payload, not a WAV.
                staged = .failure(StageError("Download HTTP \(http.statusCode)"))
            } else if let tempURL {
                let attrs = try? FileManager.default.attributesOfItem(atPath: tempURL.path)
                let size = (attrs?[.size] as? Int) ?? 0
                if size <= 44 { // 44-byte WAV header with no actual audio
                    staged = .failure(StageError("Downloaded WAV too small (\(size) bytes)"))
                } else {
                    // Unique per attempt, not per recording — two attempts for the same
                    // id must never share a path (the second would delete the first's
                    // file out from under an in-flight recognition).
                    let dest = FileManager.default.temporaryDirectory
                        .appendingPathComponent("\(recordingId)-\(UUID().uuidString).wav")
                    do {
                        try FileManager.default.moveItem(at: tempURL, to: dest)
                        staged = .success(dest)
                    } catch {
                        staged = .failure(StageError("Could not stage WAV: \(error.localizedDescription)"))
                    }
                }
            } else {
                staged = .failure(StageError("Download produced no file"))
            }

            Task { @MainActor in
                guard let self else { return }
                switch staged {
                case .success(let dest):
                    self.runFileRecognition(fileURL: dest, recordingId: recordingId)
                case .failure(let err):
                    self.sendFileTranscribeError(recordingId: recordingId, message: err.message)
                }
            }
        }
        task.resume()
    }

    private func runFileRecognition(fileURL: URL, recordingId: String) {
        guard let recognizer = speechRecognizer, recognizer.isAvailable else {
            sendFileTranscribeError(recordingId: recordingId, message: "Recognizer unavailable")
            try? FileManager.default.removeItem(at: fileURL)
            return
        }

        let request = SFSpeechURLRecognitionRequest(url: fileURL)
        request.shouldReportPartialResults = false
        if #available(iOS 16, *) {
            request.addsPunctuation = true
        }

        recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    // Include domain + code — Apple STT errors are otherwise vague.
                    // e.g. kAFAssistantErrorDomain 1101 = no speech detected,
                    // 203 = retry/service, 1700 = not authorized.
                    let ns = error as NSError
                    self.sendFileTranscribeError(
                        recordingId: recordingId,
                        message: "\(ns.domain) \(ns.code): \(ns.localizedDescription)")
                    try? FileManager.default.removeItem(at: fileURL)
                    return
                }
                guard let result, result.isFinal else { return }
                let text = result.bestTranscription.formattedString
                if text.isEmpty {
                    self.sendFileTranscribeError(recordingId: recordingId, message: "Empty transcript (no speech recognized)")
                } else {
                    self.sendFileTranscribed(recordingId: recordingId, text: text)
                }
                try? FileManager.default.removeItem(at: fileURL)
            }
        }
    }

    private func sendFileTranscribed(recordingId: String, text: String) {
        let escapedId = jsEscape(recordingId)
        let escapedText = jsEscape(text)
        sendToJS("window.__onFileTranscribed && window.__onFileTranscribed('\(escapedId)', '\(escapedText)')")
    }

    private func sendFileTranscribeError(recordingId: String, message: String) {
        let escapedId = jsEscape(recordingId)
        let escapedMsg = jsEscape(message)
        sendToJS("window.__onFileTranscribeError && window.__onFileTranscribeError('\(escapedId)', '\(escapedMsg)')")
    }

    private func jsEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
         .replacingOccurrences(of: "'", with: "\\'")
         .replacingOccurrences(of: "\n", with: "\\n")
         .replacingOccurrences(of: "\r", with: "\\r")
    }

    private func startRecording() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            Task { @MainActor in
                guard status == .authorized else {
                    self?.sendToJS("window.__onSpeechError && window.__onSpeechError('Speech recognition not authorized')")
                    return
                }
                self?.beginAudioSession()
            }
        }
    }

    private func beginAudioSession() {
        recognitionTask?.cancel()
        recognitionTask = nil

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            sendToJS("window.__onSpeechError && window.__onSpeechError('Audio session error')")
            return
        }

        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest else { return }
        recognitionRequest.shouldReportPartialResults = true

        if #available(iOS 16, *) {
            recognitionRequest.addsPunctuation = true
        }

        recognitionTask = speechRecognizer?.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            Task { @MainActor in
                if let result {
                    let text = result.bestTranscription.formattedString
                    let escaped = text
                        .replacingOccurrences(of: "\\", with: "\\\\")
                        .replacingOccurrences(of: "'", with: "\\'")
                        .replacingOccurrences(of: "\n", with: "\\n")
                    self?.sendToJS("window.__onTranscript && window.__onTranscript('\(escaped)')")
                }
                if error != nil || (result?.isFinal ?? false) {
                    self?.audioEngine.stop()
                    self?.audioEngine.inputNode.removeTap(onBus: 0)
                    self?.recognitionRequest = nil
                    self?.recognitionTask = nil
                }
            }
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)

            let channelData = buffer.floatChannelData?[0]
            let frameLength = Int(buffer.frameLength)
            guard let channelData, frameLength > 0 else { return }

            var sum: Float = 0
            for i in 0..<frameLength {
                sum += abs(channelData[i])
            }
            let avg = sum / Float(frameLength)
            let level = min(Double(avg) * 5.0, 1.0)

            Task { @MainActor in
                self?.sendToJS("window.__onVolumeLevel && window.__onVolumeLevel(\(level))")
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
            isPaused = false
            sendToJS("window.__onRecordingStarted && window.__onRecordingStarted()")
        } catch {
            sendToJS("window.__onSpeechError && window.__onSpeechError('Could not start audio engine')")
        }
    }

    private func pauseRecording() {
        if audioEngine.isRunning {
            audioEngine.pause()
            isPaused = true
        }
    }

    private func resumeRecording() {
        if isPaused {
            try? audioEngine.start()
            isPaused = false
        }
    }

    private func stopRecording() {
        synthesizer.stopSpeaking(at: .immediate)
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        isPaused = false

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        sendToJS("window.__onRecordingStopped && window.__onRecordingStopped()")
    }

    private func speakText(_ text: String) {
        let wasRunning = audioEngine.isRunning
        if wasRunning {
            audioEngine.pause()
        }

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.9
        utterance.pitchMultiplier = 1.0
        utterance.preUtteranceDelay = 0.3
        utterance.postUtteranceDelay = 0.5

        let delegate = TTSDelegate { [weak self] in
            Task { @MainActor in
                if wasRunning {
                    try? self?.audioEngine.start()
                    self?.isPaused = false
                }
                self?.sendToJS("window.__onSpeakFinished && window.__onSpeakFinished()")
            }
        }
        ttsDelegate = delegate
        synthesizer.delegate = delegate
        synthesizer.speak(utterance)
    }

    private func sendToJS(_ js: String) {
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }
}

private final class TTSDelegate: NSObject, AVSpeechSynthesizerDelegate {
    private let onFinish: () -> Void

    init(onFinish: @escaping () -> Void) {
        self.onFinish = onFinish
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onFinish()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onFinish()
    }
}

/// Plain-string failure for the download→stage step (Result needs an Error type).
private struct StageError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}
