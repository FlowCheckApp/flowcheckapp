import UIKit
import Darwin   // for posix_spawn(), kill(), strdup()
import MachO    // for _dyld_image_count(), _dyld_get_image_name()

// ─────────────────────────────────────────────────────────────────────────────
// SecurityChecker — Multi-layer jailbreak & tampering detection
//
// Six independent heuristics that an attacker would need to defeat simultaneously:
//
//   1. Cydia/jailbreak URL schemes       — checks UIApplication.canOpenURL
//   2. Suspicious file paths             — FileManager presence checks
//   3. Sandbox write escape              — tries to write outside /private/var/mobile
//   4. Readable paths outside sandbox    — tries to stat sensitive binaries
//   5. Injected dylib scan               — walks _dyld_image_count for known hookers
//   6. fork() availability               — only works on jailbroken devices
//
// Design principles:
//   • Pure Swift (not Obj-C) to reduce method-swizzling attack surface
//   • Each check is independent — defeating one doesn't affect others
//   • Simulator always returns false (avoids false-positive in dev)
//   • No SPM dependency — zero supply-chain risk on security-critical code
//
// Reference implementations:
//   IOSSecuritySuite (MIT), TrustKit, and Guardsquare DexGuard
// ─────────────────────────────────────────────────────────────────────────────

enum SecurityChecker {

    // MARK: - Public entry point

    /// Returns `true` if any jailbreak indicator is detected.
    /// Call on `applicationDidFinishLaunchingWithOptions` before any user data loads.
    static func isJailbroken() -> Bool {
        #if targetEnvironment(simulator)
        // Simulator is not a jailbroken device — skip all checks.
        return false
        #else
        return checkJailbreakURLSchemes()
            || checkSuspiciousFiles()
            || checkSandboxWriteEscape()
            || checkReadablePrivatePaths()
            || checkInjectedDylibs()
            || checkForkAvailability()
        #endif
    }

    // MARK: - Check 1: Jailbreak URL schemes

    /// Cydia, Sileo, Zebra, Filza — common jailbreak app URL schemes.
    /// A clean device cannot open these.
    private static func checkJailbreakURLSchemes() -> Bool {
        let schemes = [
            "cydia://package/com.example",
            "sileo://package/com.example",
            "zbra://package/com.example",
            "filza://",
            "undecimus://",
            "activator://"
        ]
        return schemes.contains {
            guard let url = URL(string: $0) else { return false }
            return UIApplication.shared.canOpenURL(url)
        }
    }

    // MARK: - Check 2: Suspicious file paths

    /// Files and directories that only exist on jailbroken devices.
    /// Includes Cydia, MobileSubstrate, ssh, apt, and common tweak directories.
    private static func checkSuspiciousFiles() -> Bool {
        let paths = [
            "/Applications/Cydia.app",
            "/Applications/FakeCarrier.app",
            "/Applications/Icy.app",
            "/Applications/IntelliScreen.app",
            "/Applications/MxTube.app",
            "/Applications/RockApp.app",
            "/Applications/SBSettings.app",
            "/Applications/WinterBoard.app",
            "/Applications/blackra1n.app",
            "/Library/MobileSubstrate/DynamicLibraries/LiveClock.plist",
            "/Library/MobileSubstrate/DynamicLibraries/Veency.plist",
            "/Library/MobileSubstrate/MobileSubstrate.dylib",
            "/Library/MobileSubstrate/CydiaSubstrate",
            "/System/Library/LaunchDaemons/com.ikey.bbot.plist",
            "/System/Library/LaunchDaemons/com.saurik.Cydia.Startup.plist",
            "/bin/bash",
            "/bin/sh",
            "/usr/bin/ssh",
            "/usr/libexec/sftp-server",
            "/usr/sbin/sshd",
            "/usr/libexec/cydo",
            "/etc/apt",
            "/etc/apt/sources.list.d/electra.list",
            "/etc/apt/sources.list.d/sileo.sources",
            "/var/lib/apt",
            "/var/lib/cydia",
            "/var/cache/apt",
            "/var/log/apt",
            "/var/tmp/cydia.log",
            "/private/var/lib/apt",
            "/private/var/lib/cydia",
            "/private/var/stash",
            "/private/var/mobile/Library/SBSettings",
            "/private/var/cache/apt"
        ]
        let fm = FileManager.default
        return paths.contains { fm.fileExists(atPath: $0) }
    }

    // MARK: - Check 3: Sandbox write escape

    /// Attempts to write a file to a path that should be inaccessible on a
    /// non-jailbroken device. Success means the sandbox was bypassed.
    private static func checkSandboxWriteEscape() -> Bool {
        let testPath = "/private/jailbreak_test_fc_\(arc4random())"
        do {
            try "fc_security_test".write(
                toFile: testPath,
                atomically: true,
                encoding: .utf8
            )
            // Clean up if somehow it succeeded
            try? FileManager.default.removeItem(atPath: testPath)
            return true  // Write succeeded → jailbroken
        } catch {
            return false // Expected: sandbox denied the write
        }
    }

    // MARK: - Check 4: Readable private paths

    /// On a stock device the app cannot read these paths.
    /// `isReadableFile` checks read permission without triggering a crash.
    private static func checkReadablePrivatePaths() -> Bool {
        let restrictedPaths = [
            "/bin/bash",
            "/bin/sh",
            "/usr/bin/ssh",
            "/usr/sbin/sshd",
            "/etc/apt",
            "/private/etc/apt"
        ]
        return restrictedPaths.contains {
            FileManager.default.isReadableFile(atPath: $0)
        }
    }

    // MARK: - Check 5: Injected dylib scan

    /// Walks all loaded dylibs and looks for known jailbreak / hooking frameworks.
    /// MobileSubstrate, libhooker, Substitute, and common SSL-kill-switch dylibs
    /// are all visible here if present.
    private static func checkInjectedDylibs() -> Bool {
        let knownMalicious = [
            "MobileSubstrate",
            "SubstrateLoader",
            "CydiaSubstrate",
            "libhooker",
            "Substitute",
            "cynject",
            "TweakInject",
            "SSLKillSwitch",
            "Flex_",
            "RevealServer",
            "FridaGadget",
            "frida-gadget"
        ]
        let count = _dyld_image_count()
        for i in 0..<count {
            if let namePtr = _dyld_get_image_name(i) {
                let name = String(cString: namePtr)
                if knownMalicious.contains(where: { name.contains($0) }) {
                    return true
                }
            }
        }
        return false
    }

    // MARK: - Check 6: posix_spawn with a jailbreak-only binary

    /// Attempts to spawn /bin/bash via posix_spawn().
    /// On a stock device /bin/bash does not exist, so posix_spawn returns ENOENT.
    /// On a jailbroken device that installed a UNIX environment (Cydia, Sileo, etc.)
    /// the binary is present and the sandbox restriction is lifted — spawn succeeds.
    ///
    /// Uses posix_spawn() instead of the now-deprecated fork() per Apple's
    /// recommendation (fork() is marked unavailable in iOS 17+ Swift SDK).
    /// Any spawned child is immediately killed before it can execute.
    private static func checkForkAvailability() -> Bool {
        var pid: pid_t = 0
        let path = "/bin/bash"

        // Build a null-terminated argv array using strdup so we hold mutable C strings.
        let arg0 = strdup(path)
        defer { free(arg0) }

        // withUnsafeMutableBufferPointer bridges [UnsafeMutablePointer<Int8>?]
        // to the char ** type that posix_spawn expects for argv.
        var argv: [UnsafeMutablePointer<Int8>?] = [arg0, nil]
        let ret = argv.withUnsafeMutableBufferPointer { buf in
            posix_spawn(&pid, path, nil, nil, buf.baseAddress, nil)
        }

        if ret == 0 {
            // Spawn succeeded — /bin/bash exists and sandbox was not enforced.
            kill(pid, SIGKILL)
            return true // jailbroken
        }
        return false // Expected: ENOENT or EPERM on a clean device
    }
}
