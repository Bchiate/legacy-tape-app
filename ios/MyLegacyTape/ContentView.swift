import SwiftUI
import UIKit
import WebKit
import UniformTypeIdentifiers
import AuthenticationServices

private let callbackScheme = "fct.mylegacytape"

final class LocalFileSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        var filename = url.path
        if filename == "/" || filename.isEmpty { filename = "/index.html" }
        filename = String(filename.dropFirst())

        // Xcode flattens resources to the bundle root, so strip any directory prefix
        let basename = (filename as NSString).lastPathComponent

        guard let fileURL = Bundle.main.url(forResource: basename, withExtension: nil)
                ?? findBundleFile(named: basename)
                ?? Bundle.main.url(forResource: filename, withExtension: nil)
                ?? findBundleFile(named: filename) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        guard let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(URLError(.cannotOpenFile))
            return
        }

        let mimeType = Self.mimeType(for: filename)
        let response = URLResponse(url: url, mimeType: mimeType, expectedContentLength: data.count, textEncodingName: nil)
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}

    private func findBundleFile(named name: String) -> URL? {
        let parts = name.split(separator: ".", maxSplits: 1)
        guard parts.count == 2 else { return nil }
        return Bundle.main.url(forResource: String(parts[0]), withExtension: String(parts[1]))
    }

    private static func mimeType(for filename: String) -> String {
        let ext = (filename as NSString).pathExtension.lowercased()
        switch ext {
        case "html": return "text/html"
        case "css":  return "text/css"
        case "js":   return "application/javascript"
        case "json": return "application/json"
        case "svg":  return "image/svg+xml"
        case "png":  return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "ico":  return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf":  return "font/ttf"
        case "mp3":  return "audio/mpeg"
        case "m4a":  return "audio/mp4"
        case "wav":  return "audio/wav"
        default:
            if let utType = UTType(filenameExtension: ext), let mime = utType.preferredMIMEType {
                return mime
            }
            return "application/octet-stream"
        }
    }
}

struct WebView: UIViewRepresentable {
    let speechBridge = SpeechBridge()
    let pairingBridge: PairingBridge

    func makeCoordinator() -> Coordinator {
        Coordinator(pairingBridge: pairingBridge)
    }

    func makeUIView(context: Context) -> WKWebView {
        let handler = LocalFileSchemeHandler()

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(handler, forURLScheme: "app")
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        config.userContentController.add(speechBridge, name: "speechBridge")
        config.userContentController.add(pairingBridge, name: "pairingBridge")

        let bridgeJS = WKUserScript(
            source: """
            window.__nativeSpeechBridge = true;
            window.__speechBridge = {
                start:  function() { window.webkit.messageHandlers.speechBridge.postMessage({action: "start"}); },
                pause:  function() { window.webkit.messageHandlers.speechBridge.postMessage({action: "pause"}); },
                resume: function() { window.webkit.messageHandlers.speechBridge.postMessage({action: "resume"}); },
                stop:   function() { window.webkit.messageHandlers.speechBridge.postMessage({action: "stop"}); },
                speak:  function(text) { window.webkit.messageHandlers.speechBridge.postMessage({action: "speak", text: text}); },
                transcribeFile: function(url, recordingId) {
                    window.webkit.messageHandlers.speechBridge.postMessage({
                        action: "transcribeFile",
                        url: url,
                        recordingId: recordingId
                    });
                }
            };

            window.__nativePairingBridge = true;
            window.__pairingBridge = {
                startQRScan: function() {
                    window.webkit.messageHandlers.pairingBridge.postMessage({action: "startQRScan"});
                },
                connectBLE: function(opts) {
                    window.webkit.messageHandlers.pairingBridge.postMessage({
                        action:     "connectBLE",
                        hardwareId: opts.hardwareId
                    });
                },
                pair: function(opts) {
                    var msg = {
                        action:     "pair",
                        hardwareId: opts.hardwareId,
                        token:      opts.token,
                        ssid:       opts.ssid,
                        pw:         opts.pw,
                        acct:       opts.acct
                    };
                    if (opts.ssid2) { msg.ssid2 = opts.ssid2; }
                    if (opts.pw2)   { msg.pw2   = opts.pw2;   }
                    window.webkit.messageHandlers.pairingBridge.postMessage(msg);
                },
                cancel: function() {
                    window.webkit.messageHandlers.pairingBridge.postMessage({action: "cancel"});
                }
            };
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(bridgeJS)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator

        speechBridge.attach(to: webView)
        pairingBridge.attach(to: webView)
        context.coordinator.webView = webView

        #if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif

        if let url = URL(string: "app://localhost/index.html") {
            webView.load(URLRequest(url: url))
        }

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, ASWebAuthenticationPresentationContextProviding {
        weak var webView: WKWebView?
        private let pairingBridge: PairingBridge

        init(pairingBridge: PairingBridge) {
            self.pairingBridge = pairingBridge
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Notify the bridge that JS is ready; delivers any buffered deep-link URL.
            pairingBridge.webViewDidLoad()
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            // Social sign-in: hand Supabase's authorize URL to the system browser sheet.
            let isSupabaseAuth = (url.host?.hasSuffix(".supabase.co") ?? false)
                && url.path.contains("/auth/v1/authorize")

            if isSupabaseAuth {
                decisionHandler(.cancel)
                startOAuthSession(url: url)
                return
            }

            // Allow our custom scheme and data loads
            if url.scheme == "app" || url.scheme == "about" {
                decisionHandler(.allow)
                return
            }

            // For any other external HTTPS navigations (e.g. "Buy Device" link), open in Safari
            if url.scheme == "https" || url.scheme == "http" {
                decisionHandler(.cancel)
                UIApplication.shared.open(url)
                return
            }

            decisionHandler(.allow)
        }

        private func startOAuthSession(url: URL) {
            // Rewrite the redirect_to parameter to use our custom callback scheme
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            var queryItems = components?.queryItems ?? []
            queryItems.removeAll { $0.name == "redirect_to" }
            queryItems.append(URLQueryItem(name: "redirect_to", value: "\(callbackScheme)://callback"))
            components?.queryItems = queryItems

            guard let authURL = components?.url else { return }

            let session = ASWebAuthenticationSession(
                url: authURL,
                callbackURLScheme: callbackScheme
            ) { [weak self] callbackURL, error in
                guard let callbackURL, error == nil else { return }

                // The callback URL contains tokens as a fragment:
                // fct.mylegacytape://callback#access_token=...&refresh_token=...
                // We need to extract them and pass to Supabase in the WebView
                let fragment = callbackURL.fragment ?? ""
                if !fragment.isEmpty {
                    let js = """
                    (function() {
                        var params = new URLSearchParams('\(fragment)');
                        var accessToken = params.get('access_token');
                        var refreshToken = params.get('refresh_token');
                        if (accessToken && refreshToken) {
                            // Use the Supabase client's internal method to set the session
                            window.__supabaseSetSession && window.__supabaseSetSession(accessToken, refreshToken);
                        }
                    })();
                    """
                    Task { @MainActor in
                        self?.webView?.evaluateJavaScript(js, completionHandler: nil)
                    }
                }
            }

            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            session.start()
        }

        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let window = scene.windows.first else {
                return ASPresentationAnchor()
            }
            return window
        }
    }
}

struct ContentView: View {
    @StateObject private var pairingBridge = PairingBridge()
    @EnvironmentObject private var pendingPair: PendingPairingState

    var body: some View {
        WebView(pairingBridge: pairingBridge)
            .ignoresSafeArea()
            .onChange(of: pendingPair.intent) { _, intent in
                guard let intent else { return }
                pendingPair.intent = nil
                // handleDeepLink buffers internally if the webview isn't ready yet.
                pairingBridge.handleDeepLink(intent)
            }
    }
}

#Preview {
    ContentView()
}
