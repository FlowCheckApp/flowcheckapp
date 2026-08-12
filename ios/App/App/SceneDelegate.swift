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

        // The window shows wherever the WebView does not, so its colour has to
        // follow the appearance rather than being pinned to one of them.
        //
        // This used to be hardcoded to the light background (#f2f4f8), on the
        // reasoning that it stopped dark navy bleeding into the safe-area
        // gutters during sheet transitions, and that dark-mode users would see
        // "a brief edge flash only during transitions".
        //
        // That underestimated it. capacitor.config.json sets the Keyboard
        // plugin to resize:"native", so whenever the keyboard is up the WebView
        // has shrunk away from the bottom of the screen and the window is
        // exposed around the keyboard's rounded corners for as long as it is
        // open — a permanent near-white frame on a dark app, not a flash.
        //
        // A dynamic colour keeps the original intent (no dark bleed in light
        // mode) and fixes the frame, and it re-resolves automatically when the
        // appearance changes. Values match the web layer's own backgrounds.
        window?.backgroundColor = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red:   6/255, green:  14/255, blue:  24/255, alpha: 1)  // #060e18
                : UIColor(red: 244/255, green: 247/255, blue: 251/255, alpha: 1)  // #f4f7fb
        }
        window?.windowScene = windowScene

        // Cold launch via URL (e.g. OAuth redirect reopening a killed app)
        if let urlContext = connectionOptions.urlContexts.first {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: urlContext.url, options: [:])
        }
    }

    func sceneDidDisconnect(_ scene: UIScene) { }

    // MARK: - URL Handling
    // Scene lifecycle apps never receive AppDelegate's application(_:open:options:) —
    // iOS routes URL opens here instead. Required for Google/Apple Sign In OAuth redirects.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
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
