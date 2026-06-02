import Capacitor
import LocalAuthentication

/**
 * BiometricAuthNative — custom Face ID / Touch ID plugin
 * Registered via packageClassList in capacitor.config.json
 * JS name: "BiometricAuth" (matches fc-auth.js Cap().BiometricAuth)
 */
@objc(BiometricAuthNative)
public class BiometricAuthNative: CAPPlugin, CAPBridgedPlugin {
    public let identifier    = "BiometricAuthNative"
    public let jsName        = "BiometricAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkBiometry",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lock",           returnType: CAPPluginReturnPromise),
    ]

    /// Called by the JS idle timer (5-min inactivity) to show the native lock screen.
    @objc func lock(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: Notification.Name("FCShowNativeLockScreen"),
                object: nil
            )
            call.resolve()
        }
    }

    /// Check whether biometrics are enrolled and available on this device.
    @objc func checkBiometry(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let enrolled = context.canEvaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics, error: &error)

        var biometryType = "none"
        if enrolled {
            switch context.biometryType {
            case .faceID:  biometryType = "faceId"
            case .touchID: biometryType = "touchId"
            default:       biometryType = "none"
            }
        }

        call.resolve([
            "isAvailable":  enrolled,
            "biometryType": biometryType,
            "reason":       error?.localizedDescription ?? ""
        ])
    }

    /// Prompt Face ID / Touch ID and resolve on success.
    @objc func authenticate(_ call: CAPPluginCall) {
        let reason  = call.getString("reason") ?? "Unlock FlowCheck"
        let context = LAContext()

        context.evaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            localizedReason: reason
        ) { success, error in
            DispatchQueue.main.async {
                if success {
                    call.resolve(["verified": true])
                    return
                }
                guard let err = error as? LAError else {
                    call.reject("Authentication failed", "AUTH_FAILED", error)
                    return
                }
                switch err.code {
                case .userCancel, .appCancel, .systemCancel:
                    call.reject("Cancelled", "CANCELLED", err)
                case .userFallback:
                    call.reject("User chose fallback", "FALLBACK", err)
                case .biometryNotEnrolled:
                    call.reject("No biometrics enrolled", "NOT_ENROLLED", err)
                case .biometryLockout:
                    call.reject("Biometry locked out", "LOCKED_OUT", err)
                default:
                    call.reject(err.localizedDescription, "AUTH_FAILED", err)
                }
            }
        }
    }
}
