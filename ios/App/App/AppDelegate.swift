import UIKit
import Capacitor
import WebKit
import UserNotifications
import FirebaseCore
import FirebaseMessaging

// ─────────────────────────────────────────────────────────────────────────────
// AppDelegate — FlowCheck iOS application lifecycle
//
// Security responsibilities (in order of execution):
//   1. Jailbreak detection    → SecurityChecker.isJailbroken() on launch
//   2. WKWebView cache wipe   → ensures fresh JS/CSS on every launch
//   3. Privacy overlay        → UIVisualEffectView blur on resign-active
//                               (OS-level; fires before task-switcher screenshot)
//   4. Native lock screen     → NativeLockScreenViewController on become-active
//                               (Face ID via LAContext; no web layer involved).
//                               Suppressed while isOnboardingActive() is true so
//                               permission dialogs / Plaid Link don't trigger an
//                               unrelated Face ID prompt mid-onboarding.
//   5. App Attest             → attests device to backend after auth
//
// Keychain keys (service "cap_sec", written by JS via capacitor-secure-storage-plugin):
//   "biometric_enabled"  = "true" | "false"  (legacy fallback: CapacitorStorage.biometric_enabled)
//   "onboarding_active"  = "true" | "false"  (no legacy fallback — defaults to false)
//
// ─────────────────────────────────────────────────────────────────────────────

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    // window is owned by SceneDelegate in UIScene lifecycle.
    // Keep the property for Capacitor compatibility — returns the active scene's window.
    var window: UIWindow? {
        get {
            (UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes
                    .compactMap { $0 as? UIWindowScene }
                    .first)
                .flatMap { ($0.delegate as? SceneDelegate)?.window }
        }
        set { /* no-op: SceneDelegate owns the window */ }
    }

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

        // ── 1a. Firebase initialization ─────────────────────────────────────
        // Must be called before any Firebase service is used. Reads credentials
        // from GoogleService-Info.plist. FirebaseMessaging then swizzles
        // didRegisterForRemoteNotificationsWithDeviceToken so Capacitor's
        // push plugin receives FCM registration tokens instead of raw APNs tokens.
        FirebaseApp.configure()
        Messaging.messaging().delegate = self

        // ── 1b. Window background — matches --fc-bg (#060e18) so the native
        //        UIWindow never bleeds white/light into the safe-area edges.
        window?.backgroundColor = UIColor(red: 6/255, green: 14/255, blue: 24/255, alpha: 1)

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

        if biometricEnabled && !justUnlocked && !isOnboardingActive() {
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
        guard isBiometricEnabled(), !isOnboardingActive() else { return }
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
    /// Only show the banner when there is actual alert content — silent data
    /// pushes (content-available only) should not pop a banner.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let hasAlert = notification.request.content.title.isEmpty == false ||
                       notification.request.content.body.isEmpty  == false
        guard hasAlert else {
            completionHandler([])  // silent push — no banner, no sound
            return
        }
        if #available(iOS 14.0, *) {
            completionHandler([.banner, .sound, .badge])
        } else {
            completionHandler([.alert, .sound, .badge])
        }
    }

    // NOTE: Do NOT implement userNotificationCenter:didReceive:withCompletionHandler here.
    // Capacitor's PushNotificationsPlugin intercepts this via method swizzling to fire
    // pushNotificationActionPerformed in JavaScript. Explicitly implementing it in
    // AppDelegate overrides the swizzle and silently breaks notification tap routing.

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

    /// Reads the biometric preference.
    /// Phase 4 migrated storage from Capacitor Preferences (NSUserDefaults) to
    /// capacitor-secure-storage-plugin (Keychain, service "cap_sec"). We check
    /// Keychain first, then fall back to the old NSUserDefaults location so
    /// existing installs that haven't re-launched since migration still work.
    private func isBiometricEnabled() -> Bool {
        // Primary: Keychain (capacitor-secure-storage-plugin, service "cap_sec")
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: "cap_sec",
            kSecAttrAccount as String: "biometric_enabled",
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne,
        ]
        var item: AnyObject?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
           let data = item as? Data,
           let str  = String(data: data, encoding: .utf8) {
            return str == "true"
        }
        // Fallback: legacy Capacitor Preferences / NSUserDefaults location
        let legacy = UserDefaults.standard.string(forKey: "CapacitorStorage.biometric_enabled")
        return legacy == "true"
    }

    /// True while a new user is moving through the post-signup setup sequence
    /// (Face ID + notifications screens, or resuming unfinished onboarding).
    /// Written from JS in fc-app.js's auth router and cleared in
    /// _markOnboardingComplete(). Without this, system permission dialogs and
    /// Plaid Link's in-app browser — both of which trigger this same
    /// become-active callback — would surface an unrelated Face ID lock
    /// screen in the middle of onboarding.
    private func isOnboardingActive() -> Bool {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: "cap_sec",
            kSecAttrAccount as String: "onboarding_active",
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne,
        ]
        var item: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let str  = String(data: data, encoding: .utf8) else { return false }
        return str == "true"
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

    // MARK: - UIScene configuration

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    func application(
        _ application: UIApplication,
        didDiscardSceneSessions sceneSessions: Set<UISceneSession>
    ) { }

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

// MARK: - MessagingDelegate
// Called when the FCM registration token is refreshed. Capacitor's push plugin
// also receives this token via the registration event, but this delegate fires
// immediately on launch when a token is already available — catching the case
// where the plugin listener isn't attached yet.
extension AppDelegate: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let token = fcmToken else { return }
        // Forward to Capacitor so the JS `registration` event fires with the
        // real FCM token (not the raw APNs hex string).
        NotificationCenter.default.post(
            name: Notification.Name("FCMToken"),
            object: nil,
            userInfo: ["token": token]
        )
    }
}
