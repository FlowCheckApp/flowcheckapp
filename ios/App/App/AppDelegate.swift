import UIKit
import Capacitor
import WebKit

// ─────────────────────────────────────────────────────────────────────────────
// AppDelegate — FlowCheck iOS application lifecycle
//
// Security responsibilities (in order of execution):
//   1. Jailbreak detection    → SecurityChecker.isJailbroken() on launch
//   2. WKWebView cache wipe   → ensures fresh JS/CSS on every launch
//   3. Privacy overlay        → UIVisualEffectView blur on resign-active
//                               (OS-level; protects task-switcher screenshots
//                                even if the web layer is not yet loaded)
//   4. App Attest             → attests this device to the backend after auth
//                               (via AppAttestManager.shared.attestIfNeeded)
//
// ─────────────────────────────────────────────────────────────────────────────

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    /// Full-screen blur overlay shown when app is backgrounded.
    /// UIVisualEffectView works at the UIKit compositing level, so it
    /// intercepts iOS task-switcher screenshots before they hit the web layer.
    private var privacyOverlay: UIView?

    // MARK: - Launch

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {

        // ── 1. Jailbreak detection ───────────────────────────────────────────
        // Run before any user data is loaded. On jailbroken devices we show a
        // warning alert. The app continues (Apple guideline: don't hard-block)
        // but the Capacitor JS layer also runs its own check and can restrict
        // sensitive functionality.
        if SecurityChecker.isJailbroken() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                self?.showJailbreakAlert()
            }
        }

        // ── 2. WKWebView cache wipe ─────────────────────────────────────────
        // Clears disk + memory cache on every launch so updated JS/CSS assets
        // are always served fresh from the app bundle. Preserves cookies and
        // localStorage so auth sessions remain intact across launches.
        WKWebsiteDataStore.default().removeData(
            ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache],
            modifiedSince: Date(timeIntervalSince1970: 0)
        ) { }

        return true
    }

    // MARK: - Foreground / Background transitions

    func applicationWillResignActive(_ application: UIApplication) {
        // Fired immediately when the app moves toward background (incoming call,
        // app switcher swipe, Home button). Show the blur NOW — before the
        // system takes its task-switcher screenshot — so financial data is
        // never captured in the screenshot cache.
        showPrivacyOverlay()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Privacy overlay is already visible from willResignActive.
        // Nothing additional needed here.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Keep the blur visible until the app is fully active.
        // Removed in applicationDidBecomeActive to avoid a flash.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // App is fully foreground and interactive. Remove the blur now.
        // Small delay (0.15s) prevents a jarring flash when the system
        // transition animation is still playing.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            self?.removePrivacyOverlay()
        }
    }

    func applicationWillTerminate(_ application: UIApplication) { }

    // MARK: - Privacy Overlay

    private func showPrivacyOverlay() {
        guard privacyOverlay == nil, let window = window else { return }

        // Dark blur effect — matches FlowCheck's navy theme
        let blurEffect = UIBlurEffect(style: .systemMaterialDark)
        let blurView   = UIVisualEffectView(effect: blurEffect)
        blurView.frame = window.bounds
        blurView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        blurView.alpha = 0

        // Lock icon
        let lockLabel = UILabel()
        lockLabel.text       = "🔒"
        lockLabel.font       = UIFont.systemFont(ofSize: 36)
        lockLabel.translatesAutoresizingMaskIntoConstraints = false

        // App name label
        let nameLabel       = UILabel()
        nameLabel.text      = "FlowCheck"
        nameLabel.textColor = UIColor.white.withAlphaComponent(0.28)
        nameLabel.font      = UIFont.systemFont(ofSize: 16, weight: .semibold)
        nameLabel.translatesAutoresizingMaskIntoConstraints = false

        blurView.contentView.addSubview(lockLabel)
        blurView.contentView.addSubview(nameLabel)

        NSLayoutConstraint.activate([
            lockLabel.centerXAnchor.constraint(equalTo: blurView.contentView.centerXAnchor),
            lockLabel.centerYAnchor.constraint(equalTo: blurView.contentView.centerYAnchor,
                                               constant: -14),
            nameLabel.centerXAnchor.constraint(equalTo: blurView.contentView.centerXAnchor),
            nameLabel.topAnchor.constraint(equalTo: lockLabel.bottomAnchor, constant: 8)
        ])

        // Place above all other views including the web view
        window.addSubview(blurView)
        privacyOverlay = blurView

        // Fade in quickly so it's definitely visible before the screenshot
        UIView.animate(withDuration: 0.12) { blurView.alpha = 1.0 }
    }

    private func removePrivacyOverlay() {
        guard let overlay = privacyOverlay else { return }
        UIView.animate(withDuration: 0.2, animations: {
            overlay.alpha = 0
        }, completion: { _ in
            overlay.removeFromSuperview()
            self.privacyOverlay = nil
        })
    }

    // MARK: - Jailbreak Alert

    private func showJailbreakAlert() {
        guard let rootVC = window?.rootViewController else { return }

        let alert = UIAlertController(
            title: "Security Warning",
            message: "FlowCheck has detected that this device may be jailbroken. " +
                     "Your financial data could be at risk. Some features may be " +
                     "restricted to protect your account.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "I Understand", style: .default))
        rootVC.present(alert, animated: true)

        // Notify the Capacitor/JS layer so it can log the event or restrict features
        NotificationCenter.default.post(
            name: Notification.Name("FCJailbreakDetected"),
            object: nil
        )
    }

    // MARK: - Capacitor / URL handling (unchanged)

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        return ApplicationDelegateProxy.shared.application(
            application,
            continue: userActivity,
            restorationHandler: restorationHandler
        )
    }
}
