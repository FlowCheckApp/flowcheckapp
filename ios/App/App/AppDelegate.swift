import UIKit
import Capacitor
import WebKit
import UserNotifications

// ─────────────────────────────────────────────────────────────────────────────
// AppDelegate — FlowCheck iOS application lifecycle
//
// Security responsibilities (in order of execution):
//   1. Jailbreak detection    → SecurityChecker.isJailbroken() on launch
//   2. WKWebView cache wipe   → ensures fresh JS/CSS on every launch
//   3. Privacy overlay        → UIVisualEffectView blur on resign-active
//                               (OS-level; fires before task-switcher screenshot)
//   4. Native lock screen     → NativeLockScreenViewController on become-active
//                               (Face ID via LAContext; no web layer involved)
//   5. App Attest             → attests device to backend after auth
//
// Lock screen key in Capacitor Preferences (UserDefaults):
//   "CapacitorStorage.biometric_enabled" = "true" | "false"
//
// ─────────────────────────────────────────────────────────────────────────────

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    /// Full-screen blur overlay shown immediately on resign-active.
    /// Fires before the OS takes its task-switcher screenshot.
    private var privacyOverlay: UIView?

    /// Timestamp of the last successful biometric unlock.
    /// Prevents re-locking when the OS dismisses the Face ID dialog
    /// (which briefly backgrounds and re-foregrounds the app).
    private let lastUnlockKey = "fc_native_last_unlock"

    // MARK: - Launch

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {

        // ── 1. UNUserNotificationCenter delegate ────────────────────────────
        // Must be set before the app finishes launching so we receive the
        // willPresent callback for foreground pushes.
        UNUserNotificationCenter.current().delegate = self

        // ── 2. Jailbreak detection ───────────────────────────────────────────
        if SecurityChecker.isJailbroken() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                self?.showJailbreakAlert()
            }
        }

        // ── 2. WKWebView cache wipe (on version upgrade only) ───────────────
        // Wiping on every launch forces Firebase/CDN scripts to re-download,
        // making the splash screen linger. Only wipe when the app version changes.
        let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        let lastVersion    = UserDefaults.standard.string(forKey: "fc_last_launch_version") ?? ""
        if currentVersion != lastVersion {
            WKWebsiteDataStore.default().removeData(
                ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache],
                modifiedSince: Date(timeIntervalSince1970: 0)
            ) { }
            UserDefaults.standard.set(currentVersion, forKey: "fc_last_launch_version")
        }

        // ── 3. Idle-lock listener (posted by BiometricPlugin.lock()) ────────
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleShowLockScreen),
            name: Notification.Name("FCShowNativeLockScreen"),
            object: nil
        )

        return true
    }

    // MARK: - Foreground / Background transitions

    func applicationWillResignActive(_ application: UIApplication) {
        // Show the blur NOW — before the OS takes its task-switcher screenshot.
        // This fires on: Home button, app switcher swipe, incoming call overlay.
        showPrivacyOverlay()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Blur is already visible from willResignActive — nothing extra needed.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Keep blur visible until didBecomeActive — avoids a flash.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Decide: show native lock screen OR just lift the blur.
        let biometricEnabled = isBiometricEnabled()
        let justUnlocked     = Date().timeIntervalSince1970 -
                               UserDefaults.standard.double(forKey: lastUnlockKey) < 8.0

        // Clear delivered notifications + badge when app comes to foreground.
        // Resets the red badge dot and removes stale banners from Notification Center.
        clearBadgeAndDelivered()

        if biometricEnabled && !justUnlocked {
            // Present the native lock screen. It sits on top of the blur so the
            // transition is seamless — user sees blur → lock screen → Face ID.
            presentNativeLockScreen()
        } else {
            // No lock needed — just lift the blur with a short delay so the
            // system transition animation has finished first.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
                self?.removePrivacyOverlay()
            }
        }
    }

    func applicationWillTerminate(_ application: UIApplication) { }

    // MARK: - Native Lock Screen

    @objc private func handleShowLockScreen() {
        // Fired by the JS idle timer via BiometricPlugin.lock()
        guard isBiometricEnabled() else { return }
        showPrivacyOverlay()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.presentNativeLockScreen()
        }
    }

    private func presentNativeLockScreen() {
        guard let rootVC = window?.rootViewController else { return }

        // Don't stack lock screens if one is already on screen.
        // Still remove the privacy overlay — the lock VC underneath handles auth.
        if rootVC.presentedViewController is NativeLockScreenViewController {
            removePrivacyOverlay()
            return
        }
        // Walk the presented chain in case something else is on top
        var top: UIViewController = rootVC
        while let presented = top.presentedViewController { top = presented }
        if top is NativeLockScreenViewController {
            removePrivacyOverlay()
            return
        }

        let lockVC = NativeLockScreenViewController()
        lockVC.modalPresentationStyle = .overFullScreen
        lockVC.modalTransitionStyle   = .crossDissolve  // instant — blur is already covering

        lockVC.onUnlocked = { [weak self] in
            // Record unlock time so the next appStateChange (Face ID dialog dismiss)
            // doesn't re-lock within 8 seconds.
            UserDefaults.standard.set(Date().timeIntervalSince1970,
                                      forKey: self?.lastUnlockKey ?? "fc_native_last_unlock")
            self?.removePrivacyOverlay()
        }

        lockVC.onSignOut = {
            // Tell the Capacitor / JS layer to sign out.
            // The JS listener in fc-app.js calls FCAuth.signOut() on this event.
            NotificationCenter.default.post(
                name: Notification.Name("FCSignOutRequested"),
                object: nil
            )
        }

        // Present instantly (blur is covering — no visual gap).
        // Remove the blur once the lock VC is fully on screen.
        top.present(lockVC, animated: false) { [weak self] in
            self?.removePrivacyOverlay()
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Called when a push arrives while the app is in the foreground.
    /// Without this, iOS silences foreground pushes entirely.
    /// We show the banner + play sound so the user sees it even in-app.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Show banner + sound + badge update in foreground (iOS 14+)
        if #available(iOS 14.0, *) {
            completionHandler([.banner, .sound, .badge])
        } else {
            completionHandler([.alert, .sound, .badge])
        }
    }

    /// Called when the user taps a notification (foreground or background).
    /// Capacitor's ApplicationDelegateProxy automatically forwards this to the
    /// PushNotifications plugin, which fires pushNotificationActionPerformed in JS.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        completionHandler()
    }

    // MARK: - Badge Management

    /// Clears the app icon badge and removes all delivered notifications
    /// from Notification Center. Called on every foreground transition.
    private func clearBadgeAndDelivered() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        // Setting applicationIconBadgeNumber to 0 clears the red dot.
        // Deprecated in iOS 17 but still required for backward compat.
        UIApplication.shared.applicationIconBadgeNumber = 0
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(0) { _ in }
        }
    }

    // MARK: - Privacy Overlay

    private func showPrivacyOverlay() {
        guard privacyOverlay == nil, let window = window else { return }

        let blurEffect = UIBlurEffect(style: .systemMaterialDark)
        let blurView   = UIVisualEffectView(effect: blurEffect)
        blurView.frame            = window.bounds
        blurView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        blurView.alpha            = 0

        // Subtle lock + wordmark centered in the blur
        let lockCfg  = UIImage.SymbolConfiguration(pointSize: 28, weight: .light)
        let lockImg  = UIImage(systemName: "lock.fill", withConfiguration: lockCfg)
        let lockView = UIImageView(image: lockImg)
        lockView.tintColor = UIColor.white.withAlphaComponent(0.20)
        lockView.translatesAutoresizingMaskIntoConstraints = false

        let nameLabel       = UILabel()
        nameLabel.text      = "FlowCheck"
        nameLabel.textColor = UIColor.white.withAlphaComponent(0.20)
        nameLabel.font      = UIFont.systemFont(ofSize: 15, weight: .semibold)
        nameLabel.translatesAutoresizingMaskIntoConstraints = false

        blurView.contentView.addSubview(lockView)
        blurView.contentView.addSubview(nameLabel)

        NSLayoutConstraint.activate([
            lockView.centerXAnchor.constraint(equalTo: blurView.contentView.centerXAnchor),
            lockView.centerYAnchor.constraint(equalTo: blurView.contentView.centerYAnchor,
                                              constant: -14),
            nameLabel.centerXAnchor.constraint(equalTo: blurView.contentView.centerXAnchor),
            nameLabel.topAnchor.constraint(equalTo: lockView.bottomAnchor, constant: 8),
        ])

        window.addSubview(blurView)
        privacyOverlay = blurView

        UIView.animate(withDuration: 0.10) { blurView.alpha = 1.0 }
    }

    private func removePrivacyOverlay() {
        guard let overlay = privacyOverlay else { return }
        privacyOverlay = nil  // nil before animation so re-entrant calls are no-ops
        UIView.animate(withDuration: 0.18, animations: {
            overlay.alpha = 0
        }, completion: { _ in
            overlay.removeFromSuperview()
        })
    }

    // MARK: - Helpers

    /// Reads the biometric preference written by Capacitor Preferences JS.
    /// Capacitor stores values as JSON strings under "CapacitorStorage.<key>".
    private func isBiometricEnabled() -> Bool {
        let raw = UserDefaults.standard.string(forKey: "CapacitorStorage.biometric_enabled")
        return raw == "true"
    }

    // MARK: - Jailbreak Alert

    private func showJailbreakAlert() {
        guard let rootVC = window?.rootViewController else { return }
        let alert = UIAlertController(
            title:   "Security Warning",
            message: "FlowCheck has detected that this device may be jailbroken. " +
                     "Your financial data could be at risk. Some features may be " +
                     "restricted to protect your account.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "I Understand", style: .default))
        rootVC.present(alert, animated: true)
        NotificationCenter.default.post(name: Notification.Name("FCJailbreakDetected"), object: nil)
    }

    // MARK: - Capacitor / URL handling

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
