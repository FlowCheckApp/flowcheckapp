import Foundation
import Capacitor
import GoogleSignIn

@objc(CapacitorGoogleAuth)
public class CapacitorGoogleAuth: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CapacitorGoogleAuth"
    public let jsName = "GoogleAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initialize",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signIn",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refresh",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut",     returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleOpenUrl(_:)),
            name: Notification.Name(Notification.Name.capacitorOpenURL.rawValue),
            object: nil
        )
        configureIfNeeded(clientId: nil, serverClientId: nil)
    }

    @objc func initialize(_ call: CAPPluginCall) {
        configureIfNeeded(
            clientId: call.getString("clientId"),
            serverClientId: call.getString("serverClientId")
        )
        call.resolve()
    }

    @objc func signIn(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // Always present the interactive Google sheet for an explicit button
            // tap — never silently restorePreviousSignIn() here. That path skips
            // all UI when GIDSignIn's keychain has a cached session (e.g. from a
            // prior login), which makes the auth step look bypassed and blocks
            // switching to a different Google account on a shared device.
            guard let vc = self.bridge?.viewController else {
                call.reject("No view controller"); return
            }
            let gid = GIDSignIn.sharedInstance
            gid.signIn(withPresenting: vc) { result, error in
                if let error = error {
                    call.reject(error.localizedDescription, "\((error as NSError).code)"); return
                }
                if let user = result?.user {
                    self.resolve(user: user, serverAuthCode: result?.serverAuthCode, call: call)
                }
            }
        }
    }

    @objc func refresh(_ call: CAPPluginCall) {
        guard let user = GIDSignIn.sharedInstance.currentUser else {
            call.reject("User not logged in."); return
        }
        user.refreshTokensIfNeeded { refreshed, error in
            if let error = error { call.reject(error.localizedDescription); return }
            guard let u = refreshed else { return }
            call.resolve([
                "accessToken": u.accessToken.tokenString,
                "idToken":     u.idToken?.tokenString ?? NSNull(),
                "refreshToken": u.refreshToken.tokenString,
            ])
        }
    }

    @objc func signOut(_ call: CAPPluginCall) {
        DispatchQueue.main.async { GIDSignIn.sharedInstance.signOut() }
        call.resolve()
    }

    // MARK: - Private

    private func configureIfNeeded(clientId: String?, serverClientId: String?) {
        let cid = clientId
            ?? getConfig().getString("iosClientId")
            ?? getConfig().getString("clientId")
            ?? clientIdFromPlist()
        guard let cid = cid else { return }

        let sid = serverClientId ?? getConfig().getString("serverClientId")
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(
            clientID: cid,
            serverClientID: sid
        )
    }

    private func clientIdFromPlist() -> String? {
        guard let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
              let dict = NSDictionary(contentsOfFile: path) as? [String: AnyObject] else { return nil }
        return dict["CLIENT_ID"] as? String
    }

    @objc private func handleOpenUrl(_ notification: Notification) {
        guard let obj = notification.object as? [String: Any],
              let url = obj["url"] as? URL else { return }
        GIDSignIn.sharedInstance.handle(url)
    }

    private func resolve(user: GIDGoogleUser, serverAuthCode: String?, call: CAPPluginCall) {
        var data: [String: Any] = [
            "authentication": [
                "accessToken":  user.accessToken.tokenString,
                "idToken":      user.idToken?.tokenString ?? NSNull(),
                "refreshToken": user.refreshToken.tokenString,
            ],
            "serverAuthCode": serverAuthCode ?? NSNull(),
            "email":          user.profile?.email      ?? NSNull(),
            "familyName":     user.profile?.familyName ?? NSNull(),
            "givenName":      user.profile?.givenName  ?? NSNull(),
            "id":             user.userID              ?? NSNull(),
            "name":           user.profile?.name       ?? NSNull(),
        ]
        if let img = user.profile?.imageURL(withDimension: 100)?.absoluteString {
            data["imageUrl"] = img
        }
        call.resolve(data)
    }
}
