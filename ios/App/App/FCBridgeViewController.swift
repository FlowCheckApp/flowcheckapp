import Capacitor

/// Subclass of CAPBridgeViewController that hides the WKWebView loading
/// progress bar. The default teal/blue bar appears briefly on every launch
/// and pushes content down, causing layout shifts on the signup screen.
class FCBridgeViewController: CAPBridgeViewController {
    override func webViewConfiguration(for bridgeDelegate: CAPBridgeDelegate) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: bridgeDelegate)
        return config
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        hideProgressBar()
    }

    private func hideProgressBar() {
        // CAPBridgeViewController adds a UIProgressView as a subview of its view.
        // Walk the view hierarchy and hide it.
        for subview in view.subviews {
            if let progress = subview as? UIProgressView {
                progress.isHidden = true
                progress.removeFromSuperview()
                return
            }
        }
    }
}
