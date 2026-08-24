import UIKit
import LocalAuthentication

// Full-screen native lock screen — shown on every app resume when biometric is enabled.
// Owns its own Face ID / Touch ID prompt via LAContext directly (no Capacitor bridge needed).
// On success: scale+fade dismiss. On failure: the screen states why and offers the
// two ways forward. "Use account password" keeps this gate opaque until the
// JavaScript layer explicitly confirms that Firebase signed out.
final class NativeLockScreenViewController: UIViewController {

    // MARK: - Callbacks
    var onUnlocked: (() -> Void)?
    var onSignOut:  (() -> Void)?

    // MARK: - State
    private var isAuthenticating = false
    private var isSigningOut = false
    private var hasAppeared = false

    // MARK: - Design tokens (FlowCheck design system)
    private let fcBg       = UIColor(red: 0.020, green: 0.055, blue: 0.094, alpha: 1) // #050e18
    private let fcAccent   = UIColor(red: 0.102, green: 0.769, blue: 0.941, alpha: 1) // #1ac4f0
    private let fcAccentInk = UIColor(red: 0.000, green: 0.102, blue: 0.141, alpha: 1) // #001a24
    private let fcElectric = UIColor(red: 0.145, green: 0.388, blue: 0.922, alpha: 1) // #2563eb
    private let fcSuccess  = UIColor(red: 0.204, green: 0.780, blue: 0.349, alpha: 1) // #34c759
    private let fcDanger   = UIColor(red: 1.000, green: 0.271, blue: 0.227, alpha: 1) // #ff453a

    /* Never hardcode "Face ID". The policy used below is
       .deviceOwnerAuthentication, which resolves to Touch ID on a home-button
       device and to the passcode when no biometry is enrolled — so a button
       reading "Try Face ID again" would name a sensor the phone does not have.
       Resolved once, from the device. */
    private lazy var biometryName: String = {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID:  return "Face ID"
        case .touchID: return "Touch ID"
        default:       return "Passcode"
        }
    }()

    private lazy var biometrySymbol: String = {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID:  return "faceid"
        case .touchID: return "touchid"
        default:       return "lock.fill"
        }
    }()

    // MARK: - Views
    private let glowLayer     = CAGradientLayer()
    private let logoShadow    = UIView()
    private let logoContainer = UIView()
    private let appNameLabel  = UILabel()
    private let ringContainer = UIView()
    private let glyphView     = UIButton(type: .custom)
    private let titleLabel    = UILabel()
    private let statusLabel   = UILabel()
    private let hintLabel     = UILabel()
    private let retryBtn      = UIButton(type: .custom)
    private let passwordBtn   = UIButton(type: .custom)
    private let troubleBtn    = UIButton(type: .system)
    private let footerStack   = UIStackView()
    private var pulseLayers   = [CALayer]()

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = fcBg
        setupGlow()
        setupHeader()
        setupGlyph()
        setupCopy()
        setupActions()
        setupFooter()
        applyIdleState()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(nativeSignOutFinished(_:)),
            name: .fcNativeSignOutResult,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Presented alerts also trigger viewDidAppear when they close. Starting
        // authentication or replaying the entrance there could interrupt the
        // fail-closed password sign-out path.
        guard !hasAppeared else { return }
        hasAppeared = true
        startPulse()

        // Keep the full-screen background opaque. Only translate it into place;
        // fading this view while AppDelegate removes its privacy blur exposes
        // the authenticated WebView underneath before authentication.
        view.alpha     = 1
        view.transform = CGAffineTransform(translationX: 0, y: 14)
        UIView.animate(withDuration: 0.22, delay: 0,
                       usingSpringWithDamping: 0.88, initialSpringVelocity: 0.3,
                       options: []) {
            self.view.alpha     = 1
            self.view.transform = .identity
        }
        // Fire Face ID 95ms in — mid-animation, so the dialog appears as the
        // screen settles rather than after it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.095) { [weak self] in
            self?.authenticate()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        glowLayer.frame = view.bounds
        if let grad = logoContainer.layer.sublayers?.compactMap({ $0 as? CAGradientLayer }).first {
            grad.frame = logoContainer.bounds
        }
    }

    // MARK: - Chrome

    private func setupGlow() {
        glowLayer.colors     = [fcAccent.withAlphaComponent(0.10).cgColor, UIColor.clear.cgColor]
        glowLayer.startPoint = CGPoint(x: 0.5, y: 0.0)
        glowLayer.endPoint   = CGPoint(x: 0.5, y: 0.6)
        view.layer.insertSublayer(glowLayer, at: 0)

        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue    = 0.55
        pulse.toValue      = 1.0
        pulse.duration     = 3.4
        pulse.autoreverses = true
        pulse.repeatCount  = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glowLayer.add(pulse, forKey: "glow")
    }

    /* Icon and wordmark on one line at the top, the way the app's own header
       renders them. They used to stack — a 72pt tile with a 26pt heavy
       wordmark under it — which spent the top third of the screen restating
       which app you had just opened. */
    private func setupHeader() {
        logoContainer.translatesAutoresizingMaskIntoConstraints = false
        logoContainer.layer.cornerRadius = 10
        logoContainer.clipsToBounds      = true

        let grad = CAGradientLayer()
        grad.colors       = [fcAccent.cgColor, fcElectric.cgColor]
        grad.startPoint   = CGPoint(x: 0.2, y: 0.0)
        grad.endPoint     = CGPoint(x: 0.8, y: 1.0)
        grad.cornerRadius = 10
        logoContainer.layer.insertSublayer(grad, at: 0)

        logoShadow.translatesAutoresizingMaskIntoConstraints = false
        logoShadow.layer.shadowColor   = fcAccent.cgColor
        logoShadow.layer.shadowOffset  = CGSize(width: 0, height: 6)
        logoShadow.layer.shadowRadius  = 14
        logoShadow.layer.shadowOpacity = 0.35

        // The real app icon, so the lock screen shows real branding rather
        // than a generic SF Symbol. Falls back where the bundle has no icon.
        let appIcon: UIImage? = {
            if let icons = Bundle.main.infoDictionary?["CFBundleIcons"] as? [String: Any],
               let primary = icons["CFBundlePrimaryIcon"] as? [String: Any],
               let files = primary["CFBundleIconFiles"] as? [String],
               let name = files.last {
                return UIImage(named: name)
            }
            return nil
        }()

        let iconView: UIImageView
        if let appIcon = appIcon {
            iconView = UIImageView(image: appIcon)
            iconView.contentMode        = .scaleAspectFill
            iconView.layer.cornerRadius = 8
            iconView.clipsToBounds      = true
        } else {
            let cfg = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
            iconView = UIImageView(image: UIImage(systemName: "chart.line.uptrend.xyaxis",
                                                  withConfiguration: cfg))
            iconView.tintColor = .white
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false

        appNameLabel.text      = "FlowCheck"
        /* 20pt semibold, not 26 heavy. The app-wide weight scale reserves the
           heaviest weight for one display figure per surface; a wordmark that
           is not the subject of the screen is not it. */
        appNameLabel.font      = UIFont.systemFont(ofSize: 20, weight: .semibold)
        appNameLabel.textColor = .white
        appNameLabel.translatesAutoresizingMaskIntoConstraints = false

        logoContainer.addSubview(iconView)
        logoShadow.addSubview(logoContainer)

        let header = UIStackView(arrangedSubviews: [logoShadow, appNameLabel])
        header.axis      = .horizontal
        header.alignment = .center
        header.spacing   = 10
        header.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(header)

        NSLayoutConstraint.activate([
            header.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            header.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),

            logoShadow.widthAnchor.constraint(equalToConstant: 32),
            logoShadow.heightAnchor.constraint(equalToConstant: 32),
            logoContainer.topAnchor.constraint(equalTo: logoShadow.topAnchor),
            logoContainer.leadingAnchor.constraint(equalTo: logoShadow.leadingAnchor),
            logoContainer.trailingAnchor.constraint(equalTo: logoShadow.trailingAnchor),
            logoContainer.bottomAnchor.constraint(equalTo: logoShadow.bottomAnchor),
            iconView.centerXAnchor.constraint(equalTo: logoContainer.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: logoContainer.centerYAnchor),
            iconView.widthAnchor.constraint(equalTo: logoContainer.widthAnchor),
            iconView.heightAnchor.constraint(equalTo: logoContainer.heightAnchor),
        ])
    }

    /* The biometry glyph. Still tappable — retrying by pressing the thing the
       screen is about is the gesture people reach for first — but it is no
       longer the ONLY way to retry, which is why the explicit button below
       exists. */
    private func setupGlyph() {
        ringContainer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(ringContainer)

        glyphView.translatesAutoresizingMaskIntoConstraints = false
        glyphView.backgroundColor     = fcAccent.withAlphaComponent(0.08)
        glyphView.layer.cornerRadius  = 66
        glyphView.layer.borderWidth   = 1
        glyphView.layer.borderColor   = fcAccent.withAlphaComponent(0.22).cgColor
        glyphView.layer.masksToBounds = true
        glyphView.tintColor           = fcAccent
        glyphView.accessibilityLabel  = "Unlock with \(biometryName)"
        glyphView.setImage(UIImage(systemName: biometrySymbol,
                                   withConfiguration: UIImage.SymbolConfiguration(pointSize: 58,
                                                                                  weight: .ultraLight)),
                           for: .normal)
        glyphView.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)
        ringContainer.addSubview(glyphView)

        NSLayoutConstraint.activate([
            ringContainer.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            ringContainer.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 132),
            ringContainer.widthAnchor.constraint(equalToConstant: 176),
            ringContainer.heightAnchor.constraint(equalToConstant: 176),

            glyphView.centerXAnchor.constraint(equalTo: ringContainer.centerXAnchor),
            glyphView.centerYAnchor.constraint(equalTo: ringContainer.centerYAnchor),
            glyphView.widthAnchor.constraint(equalToConstant: 132),
            glyphView.heightAnchor.constraint(equalToConstant: 132),
        ])
    }

    private func setupCopy() {
        titleLabel.text          = "Unlock FlowCheck"
        titleLabel.font          = UIFont.systemFont(ofSize: 30, weight: .bold)
        titleLabel.textColor     = .white
        titleLabel.textAlignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.font          = UIFont.systemFont(ofSize: 16, weight: .regular)
        statusLabel.textColor     = UIColor.white.withAlphaComponent(0.62)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        hintLabel.font          = UIFont.systemFont(ofSize: 14, weight: .regular)
        hintLabel.textColor     = UIColor.white.withAlphaComponent(0.40)
        hintLabel.textAlignment = .center
        hintLabel.numberOfLines = 0
        hintLabel.translatesAutoresizingMaskIntoConstraints = false

        [titleLabel, statusLabel, hintLabel].forEach { view.addSubview($0) }

        NSLayoutConstraint.activate([
            titleLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            titleLabel.topAnchor.constraint(equalTo: ringContainer.bottomAnchor, constant: 18),
            titleLabel.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),

            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 10),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),

            hintLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            hintLabel.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 6),
            hintLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            hintLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
        ])
    }

    /* Two full-width controls and a text link, in that order of weight.
       Before this the only visible exit was a 30%-opacity line of text at the
       very bottom of the screen — the fallback everyone needs when Face ID
       fails was the least visible thing on the failure screen. */
    private func setupActions() {
        styleFilled(retryBtn, title: "Try \(biometryName) again", symbol: biometrySymbol)
        retryBtn.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)

        styleOutlined(passwordBtn, title: "Use account password", symbol: "lock.fill")
        passwordBtn.addTarget(self, action: #selector(passwordTapped), for: .touchUpInside)

        troubleBtn.setTitle("Having trouble?", for: .normal)
        troubleBtn.titleLabel?.font = UIFont.systemFont(ofSize: 14, weight: .medium)
        troubleBtn.setTitleColor(fcAccent, for: .normal)
        troubleBtn.translatesAutoresizingMaskIntoConstraints = false
        troubleBtn.addTarget(self, action: #selector(troubleTapped), for: .touchUpInside)

        [retryBtn, passwordBtn, troubleBtn].forEach { view.addSubview($0) }

        NSLayoutConstraint.activate([
            retryBtn.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            retryBtn.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            retryBtn.topAnchor.constraint(equalTo: hintLabel.bottomAnchor, constant: 28),
            retryBtn.heightAnchor.constraint(equalToConstant: 54),

            passwordBtn.leadingAnchor.constraint(equalTo: retryBtn.leadingAnchor),
            passwordBtn.trailingAnchor.constraint(equalTo: retryBtn.trailingAnchor),
            passwordBtn.topAnchor.constraint(equalTo: retryBtn.bottomAnchor, constant: 12),
            passwordBtn.heightAnchor.constraint(equalToConstant: 54),

            troubleBtn.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            troubleBtn.topAnchor.constraint(equalTo: passwordBtn.bottomAnchor, constant: 16),
            troubleBtn.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    private func setupFooter() {
        let cfg   = UIImage.SymbolConfiguration(pointSize: 12, weight: .medium)
        let shield = UIImageView(image: UIImage(systemName: "lock.shield.fill", withConfiguration: cfg))
        shield.tintColor = fcAccent.withAlphaComponent(0.55)
        shield.setContentHuggingPriority(.required, for: .horizontal)

        let note = UILabel()
        note.text      = "Your financial data stays private."
        note.font      = UIFont.systemFont(ofSize: 12, weight: .regular)
        note.textColor = UIColor.white.withAlphaComponent(0.38)

        footerStack.addArrangedSubview(shield)
        footerStack.addArrangedSubview(note)
        footerStack.axis      = .horizontal
        footerStack.alignment = .center
        footerStack.spacing   = 6
        footerStack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(footerStack)

        NSLayoutConstraint.activate([
            footerStack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            footerStack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20),
        ])
    }

    // MARK: - Button styling

    /* UIButton.Configuration, not imageEdgeInsets. The insets pair has been
       deprecated since iOS 15 — the project's own deployment target — and is
       ignored outright once a configuration is attached, so the icon/label
       spacing would have silently stopped applying. `imagePadding` is the
       supported way to say the same thing. */
    private func styleFilled(_ b: UIButton, title: String, symbol: String) {
        b.translatesAutoresizingMaskIntoConstraints = false
        var cfg = UIButton.Configuration.filled()
        cfg.baseBackgroundColor = fcAccent
        cfg.baseForegroundColor = fcAccentInk
        cfg.cornerStyle         = .fixed
        cfg.background.cornerRadius = 16
        cfg.image = UIImage(systemName: symbol,
                            withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))
        cfg.imagePadding = 8
        cfg.attributedTitle = AttributedString(
            title, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 16, weight: .semibold)]))
        b.configuration = cfg
    }

    private func styleOutlined(_ b: UIButton, title: String, symbol: String) {
        b.translatesAutoresizingMaskIntoConstraints = false
        var cfg = UIButton.Configuration.plain()
        cfg.baseForegroundColor = .white
        cfg.cornerStyle         = .fixed
        cfg.background.cornerRadius  = 16
        cfg.background.strokeColor   = fcAccent.withAlphaComponent(0.45)
        cfg.background.strokeWidth   = 1
        cfg.background.backgroundColor = .clear
        cfg.image = UIImage(systemName: symbol,
                            withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .medium))
        cfg.imagePadding = 8
        cfg.attributedTitle = AttributedString(
            title, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 16, weight: .medium)]))
        b.configuration = cfg
    }

    // MARK: - Screen states

    private func applyIdleState() {
        statusLabel.text      = "Your finances are locked"
        statusLabel.textColor = UIColor.white.withAlphaComponent(0.62)
        hintLabel.text        = "\(biometryName) will open the app."
    }

    private func applyScanningState() {
        statusLabel.text      = "Checking…"
        statusLabel.textColor = UIColor.white.withAlphaComponent(0.62)
        hintLabel.text        = " "
    }

    private func applyFailureState(cancelled: Bool) {
        statusLabel.text      = cancelled ? "\(biometryName) cancelled"
                                          : "\(biometryName) wasn't recognized"
        statusLabel.textColor = cancelled ? UIColor.white.withAlphaComponent(0.62) : fcDanger
        hintLabel.text        = "Try again or use your account password."
    }

    // MARK: - Pulse Rings

    private func startPulse() {
        pulseLayers.forEach { $0.removeFromSuperlayer() }
        pulseLayers = []

        // Centre and radii track ringContainer (176pt) and the 132pt glyph
        // inside it. They were hardcoded to the old 120pt container and would
        // have drawn off-centre here.
        let center = CGPoint(x: 88, y: 88)
        let configs: [(CGFloat, Double)] = [(78, 0.0), (68, 0.7)]

        for (radius, delay) in configs {
            let layer = CALayer()
            layer.bounds       = CGRect(x: 0, y: 0, width: radius * 2, height: radius * 2)
            layer.position     = center
            layer.cornerRadius = radius
            layer.borderWidth  = 1.5
            layer.borderColor  = fcAccent.withAlphaComponent(0.20).cgColor
            layer.opacity      = 0
            ringContainer.layer.insertSublayer(layer, at: 0)
            pulseLayers.append(layer)

            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 0.88
            scale.toValue   = 1.14

            let opacity = CAKeyframeAnimation(keyPath: "opacity")
            opacity.values   = [0, 1, 0]
            opacity.keyTimes = [0, 0.3, 1]

            let group = CAAnimationGroup()
            group.animations    = [scale, opacity]
            group.duration      = 2.4
            group.beginTime     = CACurrentMediaTime() + delay
            group.repeatCount   = .infinity
            group.timingFunction = CAMediaTimingFunction(name: .easeOut)
            layer.add(group, forKey: "pulse")
        }
    }

    // MARK: - Authentication

    @objc private func retryTapped() {
        impact(.light)
        authenticate()
    }

    private func authenticate() {
        guard !isAuthenticating, !isSigningOut else { return }
        isAuthenticating   = true
        glyphView.isEnabled = false
        retryBtn.isEnabled  = false
        retryBtn.alpha      = 0.6
        applyScanningState()

        let context = LAContext()
        context.localizedFallbackTitle = "Enter Account Password"
        context.evaluatePolicy(.deviceOwnerAuthentication,
                               localizedReason: "Unlock FlowCheck") { [weak self] success, error in
            DispatchQueue.main.async {
                self?.isAuthenticating = false
                if success {
                    self?.handleSuccess()
                } else {
                    self?.handleFailure(error: error as? LAError)
                }
            }
        }
    }

    /// Honours the app's "Haptic feedback" setting.
    ///
    /// The JS side gates every haptic behind FCApp.haptic(), which reads this
    /// preference. This screen is native, so it never went through that gate —
    /// three UIImpactFeedbackGenerator calls fired regardless of the setting,
    /// and because the lock screen only appears on resume and Face ID, they
    /// came back "here and there" after the user had switched haptics off.
    ///
    /// Capacitor's Preferences plugin writes to NSUserDefaults under the
    /// CapacitorStorage prefix, so the same value is readable from here.
    /// Absent means never set, which is on — the app's default.
    private func hapticsEnabled() -> Bool {
        let raw = UserDefaults.standard.string(forKey: "CapacitorStorage.fc_haptics_enabled")
        return raw != "false"
    }

    private func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        guard hapticsEnabled() else { return }
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }

    private func handleSuccess() {
        impact(.medium)

        UIView.animate(withDuration: 0.2) {
            self.glyphView.backgroundColor     = self.fcSuccess.withAlphaComponent(0.15)
            self.glyphView.layer.borderColor   = self.fcSuccess.withAlphaComponent(0.5).cgColor
            self.glyphView.tintColor           = self.fcSuccess
            self.retryBtn.alpha                = 0
            self.passwordBtn.alpha             = 0
            self.troubleBtn.alpha              = 0
        }
        let cfg = UIImage.SymbolConfiguration(pointSize: 52, weight: .light)
        glyphView.setImage(UIImage(systemName: "checkmark", withConfiguration: cfg), for: .normal)

        statusLabel.text      = "Unlocked"
        statusLabel.textColor = fcSuccess
        hintLabel.text        = " "

        UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.52,
                       initialSpringVelocity: 1.0, options: []) {
            self.glyphView.transform = CGAffineTransform(scaleX: 1.12, y: 1.12)
        } completion: { _ in
            UIView.animate(withDuration: 0.18) {
                self.glyphView.transform = .identity
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) { [weak self] in
            self?.dismissWithSuccess()
        }
    }

    private func handleFailure(error: LAError?) {
        impact(.heavy)

        let cancelled = error?.code == .userCancel  ||
                        error?.code == .appCancel   ||
                        error?.code == .systemCancel

        glyphView.isEnabled = true
        retryBtn.isEnabled  = true
        retryBtn.alpha      = 1
        applyFailureState(cancelled: cancelled)

        guard !cancelled else { return }

        UIView.animate(withDuration: 0.2) {
            self.glyphView.backgroundColor   = self.fcDanger.withAlphaComponent(0.12)
            self.glyphView.layer.borderColor = self.fcDanger.withAlphaComponent(0.40).cgColor
        }
        shakeGlyph()

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
            guard let self else { return }
            UIView.animate(withDuration: 0.25) {
                self.glyphView.backgroundColor   = self.fcAccent.withAlphaComponent(0.08)
                self.glyphView.layer.borderColor = self.fcAccent.withAlphaComponent(0.22).cgColor
            }
            self.statusLabel.textColor = UIColor.white.withAlphaComponent(0.62)
        }
    }

    private func shakeGlyph() {
        let anim = CAKeyframeAnimation(keyPath: "transform.translation.x")
        anim.timingFunction = CAMediaTimingFunction(name: .linear)
        anim.duration = 0.38
        anim.values   = [0, -9, 9, -6, 6, -3, 3, 0]
        glyphView.layer.add(anim, forKey: "shake")
    }

    private func dismissWithSuccess() {
        onUnlocked?()
        // Scale slightly down + fade — feels like the lock screen recedes to
        // reveal the app underneath, matching iOS system unlock behaviour.
        UIView.animate(withDuration: 0.32, delay: 0,
                       usingSpringWithDamping: 0.9, initialSpringVelocity: 0.3,
                       options: [.curveEaseIn]) {
            self.view.alpha     = 0
            self.view.transform = CGAffineTransform(scaleX: 0.94, y: 0.94)
        } completion: { _ in
            self.dismiss(animated: false) {
                self.view.alpha     = 1
                self.view.transform = .identity
            }
        }
    }

    @objc private func passwordTapped() {
        guard !isSigningOut else { return }
        impact(.light)
        guard let onSignOut else {
            showSignOutUnavailable()
            return
        }

        isSigningOut = true
        glyphView.isEnabled = false
        retryBtn.isEnabled = false
        passwordBtn.isEnabled = false
        troubleBtn.isEnabled = false
        statusLabel.text = "Opening secure sign-in…"
        statusLabel.textColor = UIColor.white.withAlphaComponent(0.72)
        hintLabel.text = "FlowCheck stays locked until this device signs out."
        onSignOut()
    }

    func showSignOutUnavailable() {
        finishSignOut(success: false)
    }

    @objc private func nativeSignOutFinished(_ notification: Notification) {
        guard isSigningOut else { return }
        finishSignOut(success: notification.userInfo?["success"] as? Bool ?? false)
    }

    private func finishSignOut(success: Bool) {
        if success {
            dismiss(animated: false)
            return
        }

        isSigningOut = false
        glyphView.isEnabled = true
        retryBtn.isEnabled = true
        passwordBtn.isEnabled = true
        troubleBtn.isEnabled = true
        statusLabel.text = "Could not open secure sign-in"
        statusLabel.textColor = fcDanger
        hintLabel.text = "FlowCheck is still locked. Try again or unlock this device."
    }

    /* A visible link needs a real destination. This explains the two things
       that actually cause a lock-out — biometry disabled in iOS Settings, and
       iOS demanding the passcode after repeated failures — and then offers
       the same escape hatch as the button above, so the sheet is never a
       dead end. */
    @objc private func troubleTapped() {
        impact(.light)
        let sheet = UIAlertController(
            title: "Can't unlock?",
            message: "\(biometryName) can be switched off for FlowCheck in iOS Settings, "
                   + "and iOS asks for your device passcode instead after several failed attempts.\n\n"
                   + "You can always sign in with your FlowCheck account password.",
            preferredStyle: .alert)
        sheet.addAction(UIAlertAction(title: "Use account password", style: .default) { [weak self] _ in
            self?.passwordTapped()
        })
        sheet.addAction(UIAlertAction(title: "Try again", style: .cancel) { [weak self] _ in
            self?.authenticate()
        })
        present(sheet, animated: true)
    }
}
