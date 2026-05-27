import Foundation
import DeviceCheck
import CryptoKit
import Security

// ─────────────────────────────────────────────────────────────────────────────
// AppAttestManager — Apple App Attest integration
//
// App Attest cryptographically proves to your backend that an API request
// originated from a genuine, unmodified copy of FlowCheck running on a real
// Apple device. It defeats:
//   • Jailbroken devices running modified app binaries
//   • API abuse from reverse-engineered endpoint clients
//   • Emulators and simulator-based automation
//
// Flow (one-time per fresh install):
//   1. generateAndAttestKey()  →  creates a hardware-bound key via Secure Enclave
//   2. Your backend provides a challenge (GET /attest/challenge)
//   3. App calls DCAppAttestService.attestKey(keyId, clientDataHash: hash)
//   4. Apple returns an attestation certificate chain
//   5. Backend verifies the chain against Apple's App Attest Root CA
//   6. Backend marks this device as attested; future requests include assertions
//
// Per-request assertions (after attestation):
//   generateAssertion(for:)  →  signs a request hash with the attested key
//   Include the returned base64 assertion in the X-App-Assertion header
//
// Requirements:
//   • Entitlement: com.apple.developer.devicecheck.appattest-environment
//   • Deployment target: iOS 14+
//   • Device: must be a real device (not simulator)
//
// Reference: https://developer.apple.com/documentation/devicecheck/establishing_your_app_s_integrity
// ─────────────────────────────────────────────────────────────────────────────

@available(iOS 14.0, *)
final class AppAttestManager {

    static let shared = AppAttestManager()
    private init() {}

    // MARK: - Constants

    private let service = DCAppAttestService.shared

    /// Keychain key where the attested key ID is stored.
    private static let keychainKeyID      = "com.flowcheck.appattest.keyid"
    /// Keychain key where the attestation receipt is cached.
    private static let keychainAttestedAt = "com.flowcheck.appattest.attested_at"

    /// Backend base URL — mirrors FC_CONFIG in the web layer.
    private var backendURL: String {
        ProcessInfo.processInfo.environment["FC_BACKEND_URL"]
            ?? "https://flowcheck-backend-production.up.railway.app"
    }

    // MARK: - Public API

    /// Returns `true` if this device + install has already been attested.
    var isAttested: Bool {
        return loadKeyIDFromKeychain() != nil
    }

    /// Returns `true` if App Attest is supported on this device.
    var isSupported: Bool {
        return service.isSupported
    }

    /// Full attestation flow. Call once after the user first authenticates.
    /// Safe to call repeatedly — returns early if already attested.
    ///
    /// - Parameter idToken: Firebase ID token for authenticating the backend request.
    func attestIfNeeded(idToken: String) async {
        guard service.isSupported else { return }
        guard !isAttested else { return }

        do {
            let keyID = try await generateKey()
            let challenge = try await fetchChallenge(idToken: idToken)
            let attestation = try await attestKey(keyID: keyID, challenge: challenge)
            try await submitAttestation(keyID: keyID,
                                        attestation: attestation,
                                        challenge: challenge,
                                        idToken: idToken)
            saveKeyIDToKeychain(keyID)
            print("[AppAttest] ✅ Device attested successfully")
        } catch {
            // Non-fatal — app still works, just without App Attest protection.
            // Retry on next launch.
            print("[AppAttest] Attestation failed (will retry next launch): \(error)")
        }
    }

    /// Generate a signed assertion for a specific request.
    /// Include the returned value in the `X-App-Assertion` request header.
    ///
    /// - Parameter requestData: Canonical bytes of the request (e.g. JSON body).
    /// - Returns: Base64-encoded assertion, or nil if not yet attested / unsupported.
    func generateAssertion(for requestData: Data) async -> String? {
        guard service.isSupported, let keyID = loadKeyIDFromKeychain() else { return nil }

        do {
            let hash = Data(SHA256.hash(data: requestData))
            let assertion = try await service.generateAssertion(keyID, clientDataHash: hash)
            return assertion.base64EncodedString()
        } catch {
            print("[AppAttest] Assertion generation failed: \(error)")
            return nil
        }
    }

    // MARK: - Private helpers

    private func generateKey() async throws -> String {
        return try await withCheckedThrowingContinuation { continuation in
            service.generateKey { keyID, error in
                if let error = error {
                    continuation.resume(throwing: error)
                } else if let keyID = keyID {
                    continuation.resume(returning: keyID)
                } else {
                    continuation.resume(throwing: AttestError.keyGenerationFailed)
                }
            }
        }
    }

    private func fetchChallenge(idToken: String) async throws -> String {
        guard let url = URL(string: "\(backendURL)/attest/challenge") else {
            throw AttestError.invalidURL
        }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw AttestError.challengeFetchFailed
        }
        let json = try JSONDecoder().decode([String: String].self, from: data)
        guard let challenge = json["challenge"] else {
            throw AttestError.challengeFetchFailed
        }
        return challenge
    }

    private func attestKey(keyID: String, challenge: String) async throws -> Data {
        guard let challengeData = challenge.data(using: .utf8) else {
            throw AttestError.invalidChallenge
        }
        // clientDataHash must be SHA-256 of the challenge
        let clientDataHash = Data(SHA256.hash(data: challengeData))

        return try await withCheckedThrowingContinuation { continuation in
            service.attestKey(keyID, clientDataHash: clientDataHash) { attestation, error in
                if let error = error {
                    continuation.resume(throwing: error)
                } else if let attestation = attestation {
                    continuation.resume(returning: attestation)
                } else {
                    continuation.resume(throwing: AttestError.attestationFailed)
                }
            }
        }
    }

    private func submitAttestation(keyID: String,
                                   attestation: Data,
                                   challenge: String,
                                   idToken: String) async throws {
        guard let url = URL(string: "\(backendURL)/attest/verify") else {
            throw AttestError.invalidURL
        }
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")

        let body: [String: String] = [
            "key_id":      keyID,
            "attestation": attestation.base64EncodedString(),
            "challenge":   challenge
        ]
        req.httpBody = try JSONEncoder().encode(body)

        let (_, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw AttestError.verificationFailed
        }
    }

    // MARK: - Keychain storage

    /// Store the attested key ID in the Keychain so it survives app restarts.
    /// Uses `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` —
    /// accessible once unlocked, not backed up to iCloud, non-migratable.
    private func saveKeyIDToKeychain(_ keyID: String) {
        guard let data = keyID.data(using: .utf8) else { return }

        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: AppAttestManager.keychainKeyID,
            kSecAttrAccount as String: "keyid",
            kSecValueData as String:   data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        SecItemDelete(query as CFDictionary) // remove any old value first
        SecItemAdd(query as CFDictionary, nil)
    }

    private func loadKeyIDFromKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: AppAttestManager.keychainKeyID,
            kSecAttrAccount as String: "keyid",
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let keyID = String(data: data, encoding: .utf8) else {
            return nil
        }
        return keyID
    }

    // MARK: - Errors

    enum AttestError: LocalizedError {
        case keyGenerationFailed
        case challengeFetchFailed
        case attestationFailed
        case verificationFailed
        case invalidURL
        case invalidChallenge

        var errorDescription: String? {
            switch self {
            case .keyGenerationFailed:  return "App Attest key generation failed"
            case .challengeFetchFailed: return "Failed to fetch attestation challenge from server"
            case .attestationFailed:    return "Apple attestation call failed"
            case .verificationFailed:   return "Backend rejected attestation"
            case .invalidURL:           return "Invalid backend URL"
            case .invalidChallenge:     return "Invalid challenge data"
            }
        }
    }
}
