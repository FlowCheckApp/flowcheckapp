import UIKit
import Capacitor

// ─────────────────────────────────────────────────────────────────────────────
// SceneDelegate — UIScene lifecycle for FlowCheck
//
// Adopting UIScene is required for future iOS versions and enables proper
// multi-window support, State Restoration, and better background task handling.
//
// Scene lifecycle replaces the AppDelegate methods:
//   applicationWillResignActive   → sceneWillResignActive
//   applicationDidBecomeActive    → sceneDidBecomeActive
//   applicationDidEnterBackground → sceneDidEnterBackground
//   applicationWillEnterForeground→ sceneWillEnterForeground
//
// AppDelegate retains: launch, push notifications, URL handling.
// ─────────────────────────────────────────────────────────────────────────────

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    // MARK: - Scene Connection

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        // The storyboard (Main.storyboard → CAPBridgeViewController) wires the
        // window automatically when `UIMainStoryboardFile` is set in Info.plist.
        // No manual window setup needed here.

        guard let windowScene = scene as? UIWindowScene else { return }

        // Match the app background to --fc-bg (#060e18) so UIWindow edges
        // never bleed white into safe-area gutters during sheet transitions.
        window?.backgroundColor = UIColor(red: 6/255, green: 14/255, blue: 24/255, alpha: 1)
        window?.windowScene = windowScene

        // Cold launch via URL (e.g. OAuth redirect reopening a killed app)
        if let urlContext = connectionOptions.urlContexts.first {
            ApplicationDelegateProxy.shared.application(UIApplication.shared, open: urlContext.url, options: [:])
        }
    }

    func sceneDidDisconnect(_ scene: UIScene) { }

    // MARK: - URL Handling
    // Scene lifecycle apps never receive AppDelegate's application(_:open:options:) —
    // iOS routes URL opens here instead. Required for Google/Apple Sign In OAuth redirects.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }
    func sceneDidBecomeActive(_ scene: UIScene) {
        // Delegate to AppDelegate's existing didBecomeActive logic
        appDelegate?.applicationDidBecomeActive(UIApplication.shared)
    }

    func sceneWillResignActive(_ scene: UIScene) {
        appDelegate?.applicationWillResignActive(UIApplication.shared)
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        appDelegate?.applicationWillEnterForeground(UIApplication.shared)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        appDelegate?.applicationDidEnterBackground(UIApplication.shared)
    }

    // MARK: - Helpers

    private var appDelegate: AppDelegate? {
        UIApplication.shared.delegate as? AppDelegate
    }
}
