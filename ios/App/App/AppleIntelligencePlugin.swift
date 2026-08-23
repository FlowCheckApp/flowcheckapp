import Capacitor
#if canImport(FoundationModels)
import FoundationModels
#endif

/**
 * OnDeviceCoachNative — Apple's on-device language model as FlowCheck's coach.
 * Registered via packageClassList in capacitor.config.json.
 * JS name: "OnDeviceCoach"
 *
 * WHY THIS EXISTS
 * Apple ships a language model with the OS from iOS 26. Using it means the
 * coach costs nothing to run at any number of users, and — the part that
 * matters more for a finance app — the user's figures never leave the phone
 * at all. No endpoint, no API key, no third-party processor to declare, no
 * privacy policy change, and it works in airplane mode.
 *
 * Not every device has it: it needs Apple Intelligence, which means iPhone
 * 15 Pro or newer with the feature switched on. `availability` reports
 * exactly why it is unavailable so the JS side can fall back rather than
 * guess — to the backend Claude route if a key is configured, and to the
 * deterministic answers if not. Those deterministic answers work on every
 * device and are what most questions hit anyway.
 *
 * THE MODEL DOES NOT DO ARITHMETIC. Same rule as the server route: FCCore
 * computes every figure and passes the RESULT; this only turns it into a
 * sentence. A ~3B on-device model is more prone to inventing a number than
 * a frontier one, not less, so the rule matters more here, not less.
 */
@objc(OnDeviceCoachNative)
public class OnDeviceCoachNative: CAPPlugin, CAPBridgedPlugin {
    public let identifier    = "OnDeviceCoachNative"
    public let jsName        = "OnDeviceCoach"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "availability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ask",          returnType: CAPPluginReturnPromise),
    ]

    /// Is there a usable on-device model, and if not, why not?
    @objc func availability(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                call.resolve(["available": true, "reason": ""])
            case .unavailable(let reason):
                let why: String
                switch reason {
                case .deviceNotEligible:          why = "device_not_eligible"
                case .appleIntelligenceNotEnabled: why = "not_enabled"
                case .modelNotReady:              why = "model_not_ready"
                @unknown default:                 why = "unavailable"
                }
                call.resolve(["available": false, "reason": why])
            @unknown default:
                call.resolve(["available": false, "reason": "unavailable"])
            }
            return
        }
        #endif
        // Below iOS 26, or built against an SDK without the framework.
        call.resolve(["available": false, "reason": "os_too_old"])
    }

    @objc func ask(_ call: CAPPluginCall) {
        let prompt = call.getString("prompt") ?? ""
        let system = call.getString("system") ?? ""
        guard !prompt.isEmpty else {
            call.reject("A prompt is required.")
            return
        }

        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else {
                call.reject("On-device model unavailable.", "unavailable")
                return
            }
            Task {
                do {
                    /* A fresh session per question. The coach answers one
                       question at a time from a supplied FACTS block, so
                       there is no conversation to carry — and carrying one
                       would let an earlier answer's wording contaminate the
                       next set of figures. */
                    let session = LanguageModelSession(instructions: system)
                    /* temperature 0.3: this is phrasing a fixed answer, not
                       writing prose. Low sampling keeps it close to the
                       facts it was given. The token cap is a guardrail
                       against a small model rambling past the answer. */
                    let options = GenerationOptions(temperature: 0.3, maximumResponseTokens: 220)
                    let response = try await session.respond(to: prompt, options: options)
                    let text = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
                    if text.isEmpty {
                        call.reject("No answer was produced.", "empty")
                    } else {
                        call.resolve(["answer": text, "source": "on-device"])
                    }
                } catch let err as LanguageModelSession.GenerationError {
                    /* Distinguish the recoverable failures. Context overflow
                       in particular is not a dead end: the JS side retries
                       with a smaller snapshot rather than giving up, so it
                       has to be able to tell that case from a guardrail
                       refusal it must not retry. */
                    let code: String
                    switch err {
                    case .exceededContextWindowSize: code = "context_too_large"
                    case .guardrailViolation:        code = "guardrail"
                    case .rateLimited:               code = "rate_limited"
                    case .concurrentRequests:        code = "busy"
                    case .assetsUnavailable:         code = "model_not_ready"
                    case .refusal:                   code = "refused"
                    default:                         code = "failed"
                    }
                    call.reject("On-device coach failed.", code, err)
                } catch {
                    call.reject("On-device coach failed.", "failed", error)
                }
            }
            return
        }
        #endif
        call.reject("On-device model unavailable.", "unavailable")
    }
}
