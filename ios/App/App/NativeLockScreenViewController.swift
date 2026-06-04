import UIKit
import LocalAuthentication

// Full-screen native lock screen — shown on every app resume when biometric is enabled.
// Owns its own Face ID / Touch ID prompt via LAContext directly (no Capacitor bridge needed).
// On success: scale+fade dismiss. On failure: shake + retry.
// "Use Password Instead" posts FCSignOutRequested so the JS layer signs out.
final class NativeLockScreenViewController: UIViewController {

    // MARK: - Callbacks
    var onUnlocked: (() -> Void)?
    var onSignOut:  (() -> Void)?

    // MARK: - State
    private var isAuthenticating = false

    // MARK: - Design tokens (FlowCheck design system)
    private let fcBg       = UIColor(red: 0.020, green: 0.055, blue: 0.094, alpha: 1) // #050e18
    private let fcAccent   = UIColor(red: 0.102, green: 0.769, blue: 0.941, alpha: 1) // #1ac4f0
    private let fcElectric = UIColor(red: 0.145, green: 0.388, blue: 0.922, alpha: 1) // #2563eb
    private let fcSuccess  = UIColor(red: 0.204, green: 0.780, blue: 0.349, alpha: 1) // #34c759
    private let fcDanger   = UIColor(red: 1.000, green: 0.271, blue: 0.227, alpha: 1) // #ff453a

    // MARK: - Views
    private let glowLayer     = CAGradientLayer()
    private let logoContainer = UIView()
    private let appNameLabel  = UILabel()
    private let subtitleLabel = UILabel()
    private let ringContainer = UIView()
    private let faceIDButton  = UIButton(type: .custom)
    private let statusLabel   = UILabel()
    private let passwordBtn   = UIButton(type: .system)
    private var pulseLayers   = [CALayer]()

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = fcBg
        setupGlow()
        setupLogo()
        setupLabels()
        setupRingAndButton()
        setupStatusLabel()
        setupPasswordButton()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        startPulse()
        // Small pause so the VC is fully on-screen before the system Face ID dialog appears
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            self?.authenticate()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        glowLayer.frame = view.bounds
        // Keep logo gradient in sync with its frame
        logoContainer.layer.sublayers?
            .compactMap { $0 as? CAGradientLayer }
            .first?.frame = logoContainer.bounds
    }

    override var prefersStatusBarHidden: Bool { true }

    // MARK: - UI Setup

    private func setupGlow() {
        glowLayer.type   = .radial
        glowLayer.colors = [fcAccent.withAlphaComponent(0.10).cgColor, UIColor.clear.cgColor]
        glowLayer.startPoint = CGPoint(x: 0.5, y: 0.38)
        glowLayer.endPoint   = CGPoint(x: 1.0, y: 1.0)
        glowLayer.frame      = view.bounds
        view.layer.insertSublayer(glowLayer, at: 0)

        // Breathe animation on the glow
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue    = 0.5
        pulse.toValue      = 1.0
        pulse.duration     = 3.0
        pulse.autoreverses = true
        pulse.repeatCount  = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glowLayer.add(pulse, forKey: "glow")
    }

    private func setupLogo() {
        logoContainer.translatesAutoresizingMaskIntoConstraints = false
        logoContainer.layer.cornerRadius = 22
        logoContainer.clipsToBounds      = true

        // Gradient fill
        let grad = CAGradientLayer()
        grad.colors      = [fcAccent.cgColor, fcElectric.cgColor]
        grad.startPoint  = CGPoint(x: 0.2, y: 0.0)
        grad.endPoint    = CGPoint(x: 0.8, y: 1.0)
        grad.cornerRadius = 22
        logoContainer.layer.insertSublayer(grad, at: 0)

        // Drop shadow (applied to wrapper since clipsToBounds hides shadow on logoContainer)
        let shadowWrap = UIView()
        shadowWrap.translatesAutoresizingMaskIntoConstraints = false
        shadowWrap.layer.shadowColor   = fcAccent.cgColor
        shadowWrap.layer.shadowOffset  = CGSize(width: 0, height: 10)
        shadowWrap.layer.shadowRadius  = 24
        shadowWrap.layer.shadowOpacity = 0.40

        // App icon — load the actual FlowCheck icon from the bundle so the lock
        // screen shows real branding, not a generic SF Symbol.
        // Falls back to the chart symbol if the icon can't be loaded (e.g. simulator).
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
            iconView.contentMode   = .scaleAspectFill
            iconView.layer.cornerRadius = 14
            iconView.clipsToBounds = true
        } else {
            let cfg  = UIImage.SymbolConfiguration(pointSize: 28, weight: .medium)
            let sym  = UIImage(systemName: "chart.line.uptrend.xyaxis", withConfiguration: cfg)
                    ?? UIImage(systemName: "dollarsign.circle.fill", withConfiguration: cfg)
            iconView = UIImageView(image: sym)
            iconView.tintColor = .white
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false
        logoContainer.addSubview(iconView)

        shadowWrap.addSubview(logoContainer)
        view.addSubview(shadowWrap)

        NSLayoutConstraint.activate([
            shadowWrap.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            shadowWrap.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 72),
            shadowWrap.widthAnchor.constraint(equalToConstant: 72),
            shadowWrap.heightAnchor.constraint(equalToConstant: 72),

            logoContainer.topAnchor.constraint(equalTo: shadowWrap.topAnchor),
            logoContainer.leadingAnchor.constraint(equalTo: shadowWrap.leadingAnchor),
            logoContainer.trailingAnchor.constraint(equalTo: shadowWrap.trailingAnchor),
            logoContainer.bottomAnchor.constraint(equalTo: shadowWrap.bottomAnchor),

            iconView.centerXAnchor.constraint(equalTo: logoContainer.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: logoContainer.centerYAnchor),
        ])
    }

    private func setupLabels() {
        appNameLabel.text          = "FlowCheck"
        appNameLabel.font          = UIFont.systemFont(ofSize: 26, weight: .heavy)
        appNameLabel.textColor     = .white
        appNameLabel.textAlignment = .center
        appNameLabel.translatesAutoresizingMaskIntoConstraints = false

        subtitleLabel.text          = "Your finances are locked"
        subtitleLabel.font          = UIFont.systemFont(ofSize: 13, weight: .regular)
        subtitleLabel.textColor     = UIColor.white.withAlphaComponent(0.45)
        subtitleLabel.textAlignment = .center
        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(appNameLabel)
        view.addSubview(subtitleLabel)

        // Find the shadow wrapper (last added view before these labels)
        let logoWrapper = view.subviews.last(where: { $0.layer.shadowOpacity > 0 })!

        NSLayoutConstraint.activate([
            appNameLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            appNameLabel.topAnchor.constraint(equalTo: logoWrapper.bottomAnchor, constant: 22),

            subtitleLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            subtitleLabel.topAnchor.constraint(equalTo: appNameLabel.bottomAnchor, constant: 6),
        ])
    }

    private func setupRingAndButton() {
        ringContainer.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(ringContainer)

        NSLayoutConstraint.activate([
            ringContainer.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            ringContainer.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: 24),
            ringContainer.widthAnchor.constraint(equalToConstant: 120),
            ringContainer.heightAnchor.constraint(equalToConstant: 120),
        ])

        faceIDButton.translatesAutoresizingMaskIntoConstraints = false
        faceIDButton.backgroundColor    = fcAccent.withAlphaComponent(0.08)
        faceIDButton.layer.cornerRadius = 44
        faceIDButton.layer.borderWidth  = 1.5
        faceIDButton.layer.borderColor  = fcAccent.withAlphaComponent(0.35).cgColor
        faceIDButton.layer.masksToBounds = true

        let cfg      = UIImage.SymbolConfiguration(pointSize: 38, weight: .ultraLight)
        let faceIcon = UIImage(systemName: "faceid", withConfiguration: cfg)
        faceIDButton.setImage(faceIcon, for: .normal)
        faceIDButton.tintColor = fcAccent
        faceIDButton.addTarget(self, action: #selector(faceIDTapped), for: .touchUpInside)

        ringContainer.addSubview(faceIDButton)

        NSLayoutConstraint.activate([
            faceIDButton.centerXAnchor.constraint(equalTo: ringContainer.centerXAnchor),
            faceIDButton.centerYAnchor.constraint(equalTo: ringContainer.centerYAnchor),
            faceIDButton.widthAnchor.constraint(equalToConstant: 88),
            faceIDButton.heightAnchor.constraint(equalToConstant: 88),
        ])
    }

    private func setupStatusLabel() {
        statusLabel.text          = ""
        statusLabel.font          = UIFont.systemFont(ofSize: 14, weight: .medium)
        statusLabel.textColor     = UIColor.white.withAlphaComponent(0.45)
        statusLabel.textAlignment = .center
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)

        NSLayoutConstraint.activate([
            statusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusLabel.topAnchor.constraint(equalTo: ringContainer.bottomAnchor, constant: 28),
        ])
    }

    private func setupPasswordButton() {
        passwordBtn.setTitle("Sign in with account password", for: .normal)
        passwordBtn.titleLabel?.font = UIFont.systemFont(ofSize: 14, weight: .medium)
        passwordBtn.setTitleColor(UIColor.white.withAlphaComponent(0.30), for: .normal)
        passwordBtn.setTitleColor(fcAccent, for: .highlighted)
        passwordBtn.translatesAutoresizingMaskIntoConstraints = false
        passwordBtn.addTarget(self, action: #selector(passwordTapped), for: .touchUpInside)
        view.addSubview(passwordBtn)

        NSLayoutConstraint.activate([
            passwordBtn.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            passwordBtn.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -28),
        ])
    }

    // MARK: - Pulse Rings

    private func startPulse() {
        pulseLayers.forEach { $0.removeFromSuperlayer() }
        pulseLayers = []

        let center = CGPoint(x: 60, y: 60)
        let configs: [(CGFloat, Double)] = [(56, 0.0), (48, 0.7)]

        for (radius, delay) in configs {
            let layer = CALayer()
            layer.bounds       = CGRect(x: 0, y: 0, width: radius * 2, height: radius * 2)
            layer.position     = center
            layer.cornerRadius = radius
            layer.borderWidth  = 1.5
            layer.borderColor  = fcAccent.withAlphaComponent(0.25).cgColor
            layer.opacity      = 0
            ringContainer.layer.insertSublayer(layer, at: 0)
            pulseLayers.append(layer)

            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 0.88
            scale.toValue   = 1.18

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

    @objc private func faceIDTapped() {
        authenticate()
    }

    private func authenticate() {
        guard !isAuthenticating else { return }
        isAuthenticating    = true
        faceIDButton.isEnabled = false
        subtitleLabel.text  = "Scanning…"

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

    private func handleSuccess() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()

        // Button turns green
        UIView.animate(withDuration: 0.2) {
            self.faceIDButton.backgroundColor = self.fcSuccess.withAlphaComponent(0.15)
            self.faceIDButton.layer.borderColor = self.fcSuccess.withAlphaComponent(0.5).cgColor
            self.faceIDButton.tintColor = self.fcSuccess
        }
        let cfg = UIImage.SymbolConfiguration(pointSize: 34, weight: .light)
        faceIDButton.setImage(UIImage(systemName: "checkmark", withConfiguration: cfg), for: .normal)

        statusLabel.text      = "✓ Unlocked"
        statusLabel.textColor = fcSuccess
        subtitleLabel.text    = ""

        // Spring pop
        UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.52,
                       initialSpringVelocity: 1.0, options: []) {
            self.faceIDButton.transform = CGAffineTransform(scaleX: 1.18, y: 1.18)
        } completion: { _ in
            UIView.animate(withDuration: 0.18) {
                self.faceIDButton.transform = .identity
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.42) { [weak self] in
            self?.dismissWithSuccess()
        }
    }

    private func handleFailure(error: LAError?) {
        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()

        let cancelled = error?.code == .userCancel  ||
                        error?.code == .appCancel   ||
                        error?.code == .systemCancel

        if cancelled {
            // User dismissed the prompt — show a clear tap-to-retry state
            subtitleLabel.text    = "Tap to try again"
            statusLabel.text      = ""
            faceIDButton.isEnabled = true
        } else {
            UIView.animate(withDuration: 0.2) {
                self.faceIDButton.backgroundColor = self.fcDanger.withAlphaComponent(0.12)
                self.faceIDButton.layer.borderColor = self.fcDanger.withAlphaComponent(0.40).cgColor
            }
            statusLabel.text      = "Didn't recognize you"
            statusLabel.textColor = fcDanger
            shakeButton()

            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
                guard let self else { return }
                UIView.animate(withDuration: 0.25) {
                    self.faceIDButton.backgroundColor = self.fcAccent.withAlphaComponent(0.08)
                    self.faceIDButton.layer.borderColor = self.fcAccent.withAlphaComponent(0.35).cgColor
                }
                self.statusLabel.text      = "Tap to try again"
                self.statusLabel.textColor = UIColor.white.withAlphaComponent(0.45)
            }
            subtitleLabel.text     = "Your finances are locked"
            faceIDButton.isEnabled = true
        }
    }

    private func shakeButton() {
        let anim = CAKeyframeAnimation(keyPath: "transform.translation.x")
        anim.timingFunction = CAMediaTimingFunction(name: .linear)
        anim.duration = 0.38
        anim.values   = [0, -9, 9, -6, 6, -3, 3, 0]
        faceIDButton.layer.add(anim, forKey: "shake")
    }

    private func dismissWithSuccess() {
        onUnlocked?()
        UIView.animate(withDuration: 0.30, delay: 0, options: [.curveEaseIn]) {
            self.view.alpha     = 0
            self.view.transform = CGAffineTransform(scaleX: 1.04, y: 1.04)
        } completion: { _ in
            self.dismiss(animated: false) {
                self.view.alpha     = 1
                self.view.transform = .identity
            }
        }
    }

    @objc private func passwordTapped() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        dismiss(animated: true) { [weak self] in
            self?.onSignOut?()
        }
    }
}
