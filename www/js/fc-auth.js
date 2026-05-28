/**
 * FlowCheck — Authentication Module
 * ─────────────────────────────────────────────────────────────
 * Handles: Firebase Auth, Face ID / Biometrics, session lock,
 *          Sign in with Apple, forgot password, sign out.
 *
 * Biometric pattern: biometrics UNLOCK an existing Firebase
 * session — they never bypass authentication. This is the
 * secure, Apple-approved approach.
 * ─────────────────────────────────────────────────────────────
 */
window.FCAuth = (function () {
  'use strict';

  let _auth = null;          // Firebase Auth instance
  let _db   = null;          // Firestore instance
  let _currentUser = null;   // Firebase User object
  let _biometricAvailable = false;

  /* ── Login rate limiting (brute-force protection) ────────── */
  // Tracks failed attempts per email address (in-memory only — clears on app restart)
  const _loginAttempts = {};
  const _MAX_ATTEMPTS  = 5;
  const _LOCKOUT_MS    = 30_000; // 30 seconds

  function _checkRateLimit(email) {
    const key   = (email || '').toLowerCase().trim();
    const entry = _loginAttempts[key];
    if (!entry || !entry.lockUntil) return;
    if (Date.now() < entry.lockUntil) {
      const secs = Math.ceil((entry.lockUntil - Date.now()) / 1000);
      throw new Error(`Too many failed attempts — try again in ${secs} seconds`);
    }
    // Lockout expired — reset
    delete _loginAttempts[key];
  }

  function _recordFailedAttempt(email) {
    const key   = (email || '').toLowerCase().trim();
    const entry = _loginAttempts[key] || { count: 0 };
    entry.count++;
    if (entry.count >= _MAX_ATTEMPTS) {
      entry.lockUntil = Date.now() + _LOCKOUT_MS;
      entry.count     = 0;
    }
    _loginAttempts[key] = entry;
  }

  function _clearAttempts(email) {
    delete _loginAttempts[(email || '').toLowerCase().trim()];
  }

  /* ── Capacitor plugin references ─────────────────────────── */
  const Cap = () => window.Capacitor && window.Capacitor.Plugins;
  const BiometricAuth  = () => Cap() && (Cap().BiometricAuth || Cap().NativeBiometric);
  const Haptics        = () => Cap() && Cap().Haptics;
  const Preferences    = () => Cap() && (Cap().Preferences || Cap().Storage);

  /* ── Haptic helper ───────────────────────────────────────── */
  function haptic(style) {
    try {
      if (Haptics()) Haptics().impact({ style: style || 'light' });
      else if (navigator.vibrate) navigator.vibrate(8);
    } catch (_) {}
  }

  /* ── Preferences (secure key-value storage) ──────────────── */
  async function prefSet(key, value) {
    try {
      if (Preferences()) await Preferences().set({ key, value: JSON.stringify(value) });
      else localStorage.setItem('fc_' + key, JSON.stringify(value));
    } catch (_) {}
  }

  async function prefGet(key) {
    try {
      if (Preferences()) {
        const r = await Preferences().get({ key });
        return r && r.value ? JSON.parse(r.value) : null;
      }
      const v = localStorage.getItem('fc_' + key);
      return v ? JSON.parse(v) : null;
    } catch (_) { return null; }
  }

  async function prefRemove(key) {
    try {
      if (Preferences()) await Preferences().remove({ key });
      else localStorage.removeItem('fc_' + key);
    } catch (_) {}
  }

  /* ── Check biometric availability ───────────────────────── */
  async function checkBiometricAvailable() {
    try {
      const plugin = BiometricAuth();
      if (!plugin) return false;

      // @aparajita/capacitor-biometric-auth
      if (plugin.checkBiometry) {
        const result = await plugin.checkBiometry();
        return result && result.isAvailable;
      }
      // capacitor-native-biometric
      if (plugin.isAvailable) {
        const result = await plugin.isAvailable();
        return result && result.isAvailable;
      }
      return false;
    } catch (_) { return false; }
  }

  /* ── Prompt Face ID / Touch ID ───────────────────────────── */
  async function promptBiometric(reason) {
    const plugin = BiometricAuth();
    if (!plugin) throw new Error('Biometric not available');

    const opts = {
      reason:               reason || 'Sign in to FlowCheck',
      cancelTitle:          'Use Password',
      allowDeviceCredential: false,
      // @aparajita API
      title:                'FlowCheck',
      subtitle:             'Confirm your identity',
      iosFallbackTitle:     'Use Password',
    };

    // @aparajita/capacitor-biometric-auth
    if (plugin.authenticate) {
      return await plugin.authenticate(opts);
    }
    // capacitor-native-biometric
    if (plugin.verifyIdentity) {
      return await plugin.verifyIdentity({
        reason:      opts.reason,
        title:       opts.title,
        subtitle:    opts.subtitle,
        description: 'FlowCheck uses Face ID to keep your finances secure.',
      });
    }
    throw new Error('No compatible biometric plugin found');
  }

  /* ── Firebase initialisation ─────────────────────────────── */
  function init() {
    if (!window.firebase || !window.FC_CONFIG) {
      console.error('[FCAuth] Firebase SDK or FC_CONFIG not loaded.');
      return;
    }
    if (!firebase.apps.length) {
      firebase.initializeApp(FC_CONFIG.firebase);
    }
    _auth = firebase.auth();
    _db   = firebase.firestore();

    // Enable Firestore offline persistence
    _db.enablePersistence({ synchronizeTabs: true }).catch(err => {
      if (err.code === 'failed-precondition') {
        fcLog('Firestore persistence: multiple tabs open');
      } else if (err.code === 'unimplemented') {
        fcLog('Firestore persistence: not supported');
      }
    });

    fcLog('FCAuth initialised');
  }

  /* ── Auth state observer ─────────────────────────────────── */
  function onAuthStateChanged(callback) {
    if (!_auth) init();
    return _auth.onAuthStateChanged(async user => {
      _currentUser = user;
      if (user) {
        // Update last_seen in Firestore
        try {
          await _db.collection('users').doc(user.uid).set(
            { last_seen: firebase.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
        } catch (_) {}
      }
      callback(user);
    });
  }

  /* ── Sign in with email + password ──────────────────────── */
  async function signIn(email, password) {
    if (!_auth) init();

    // Throw immediately if this email is in a lockout window
    _checkRateLimit(email);

    let cred;
    try {
      cred = await _auth.signInWithEmailAndPassword(email, password);
    } catch (err) {
      // Record failures for wrong-password / user-not-found only, not network errors
      if (err.code && (err.code === 'auth/wrong-password' ||
                       err.code === 'auth/user-not-found' ||
                       err.code === 'auth/invalid-credential')) {
        _recordFailedAttempt(email);
      }
      throw err;
    }

    // Successful login — clear any accumulated failure count
    _clearAttempts(email);

    // Store that biometric should be offered next time
    await prefSet('biometric_email', email);
    await prefSet('biometric_enabled', true);

    haptic('medium');
    return cred.user;
  }

  /* ── Biometric unlock (for returning users) ──────────────── */
  async function signInWithBiometric() {
    const email = await prefGet('biometric_email');
    if (!email) throw new Error('No saved credentials for biometric sign-in');

    // Prompt Face ID — this verifies identity but doesn't fetch password.
    // Firebase maintains its own persistent session (IndexedDB).
    // We just need to verify biometric, then reload the current user.
    await promptBiometric('Unlock FlowCheck');

    // At this point, Firebase session should already be persisted.
    // Force a token refresh to confirm session is still valid.
    if (_auth.currentUser) {
      await _auth.currentUser.getIdToken(true);
      haptic('medium');
      return _auth.currentUser;
    }
    throw new Error('Firebase session expired — please sign in with your password');
  }

  /* ── Sign up ─────────────────────────────────────────────── */
  async function signUp(name, email, password, referralCode = '') {
    if (!_auth) init();
    const cred = await _auth.createUserWithEmailAndPassword(email, password);
    const user = cred.user;

    // Set display name
    await user.updateProfile({ displayName: name });

    // Create Firestore user document.
    // email_marketing_opt_in defaults to false — the onboarding permissions
    // slide lets the user explicitly opt in (required for GDPR compliance).
    const doc = {
      uid:         user.uid,
      name:        name,
      email:       email,
      created_at:  firebase.firestore.FieldValue.serverTimestamp(),
      last_seen:   firebase.firestore.FieldValue.serverTimestamp(),
      plaid_linked: false,
      pro:          false,
      streak:       0,
      goals:        [],
      budgets:      {},
      notifications_enabled:  true,
      biometric_enabled:      true,
      email_marketing_opt_in: false,  // set by onboarding slide 3
    };

    // Store referral code if provided — backend processes it to credit the referrer
    const cleanCode = (referralCode || '').trim().toUpperCase();
    if (cleanCode) doc.referred_by = cleanCode;

    await _db.collection('users').doc(user.uid).set(doc);

    // Send Firebase email verification — non-blocking, never delays signup flow
    if (!user.emailVerified) {
      try { await user.sendEmailVerification(); } catch (_) { /* best-effort */ }
    }

    haptic('medium');
    return user;
  }

  /** Reload the current Firebase user to pick up fresh emailVerified status */
  async function reloadUser() {
    const user = _auth && _auth.currentUser;
    if (user) await user.reload();
    return _auth && _auth.currentUser; // fresh reference post-reload
  }

  /* ── Sign in with Apple ──────────────────────────────────── */

  /**
   * Generate a cryptographically random nonce and its SHA-256 hex hash.
   * The hash is sent to Apple; Firebase verifies by re-hashing the raw value.
   */
  async function _generateNonce() {
    const array  = new Uint8Array(32);
    crypto.getRandomValues(array);
    const raw    = Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
    const msgBuf = new TextEncoder().encode(raw);
    const hashBuf = await crypto.subtle.digest('SHA-256', msgBuf);
    const hashed  = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return { raw, hashed };
  }

  async function signInWithApple() {
    if (!_auth) init();
    // Use Capacitor's Sign in with Apple if on iOS, otherwise Firebase popup
    const isNative = window.Capacitor && window.Capacitor.isNativePlatform();

    // @capacitor-community/apple-sign-in registers as 'SignInWithApple'
    // v1–v5: Authorize()   v6+: authorize() (lowercase)
    const applePlugin = Cap() && (Cap().SignInWithApple);
    if (isNative && applePlugin) {
      // Generate a proper nonce: send the SHA-256 hash to Apple,
      // pass the raw value to Firebase so it can verify the token.
      const { raw: rawNonce, hashed: hashedNonce } = await _generateNonce();

      // Support both v5 (Authorize) and v6+ (authorize) API
      const authFn = applePlugin.authorize || applePlugin.Authorize;
      if (!authFn) throw new Error('Apple Sign In plugin not compatible — update @capacitor-community/apple-sign-in');
      const result = await authFn.call(applePlugin, { nonce: hashedNonce });
      const provider = new firebase.auth.OAuthProvider('apple.com');
      const credential = provider.credential({
        idToken:  result.response.identityToken,
        rawNonce: rawNonce,  // Firebase hashes this and compares to what Apple embedded
      });
      const userCred = await _auth.signInWithCredential(credential);
      // Create user doc if first time
      const doc = await _db.collection('users').doc(userCred.user.uid).get();
      if (!doc.exists) {
        await _db.collection('users').doc(userCred.user.uid).set({
          uid:          userCred.user.uid,
          name:         userCred.user.displayName || 'FlowCheck User',
          email:        userCred.user.email || '',
          created_at:   firebase.firestore.FieldValue.serverTimestamp(),
          last_seen:    firebase.firestore.FieldValue.serverTimestamp(),
          plaid_linked: false,
          pro:          false,
          streak:       0,
        });
      }
      haptic('medium');
      return userCred.user;
    } else {
      // In a native Capacitor app, signInWithPopup doesn't work in WKWebView.
      // The SignInWithApple Capacitor plugin is not installed — direct the user
      // to use email/password sign-in instead.
      if (window.Capacitor && window.Capacitor.isNativePlatform()) {
        throw new Error(
          'Apple Sign In isn\'t available right now — please use your email and password to sign in.'
        );
      }
      // Web / simulator fallback (works fine in a browser, not WKWebView)
      const provider = new firebase.auth.OAuthProvider('apple.com');
      provider.addScope('email');
      provider.addScope('name');
      const userCred = await _auth.signInWithPopup(provider);
      haptic('medium');
      return userCred.user;
    }
  }

  /* ── Password reset ──────────────────────────────────────── */
  async function sendPasswordReset(email) {
    if (!_auth) init();
    await _auth.sendPasswordResetEmail(email);
  }

  /* ── Sign out ────────────────────────────────────────────── */
  async function signOut() {
    if (!_auth) return;
    // Clear biometric preferences — including the cached email so a different
    // user on a shared device doesn't see the previous user's address pre-filled
    // on the lock screen or as the "last user" hint.
    await prefRemove('biometric_enabled');
    await prefRemove('biometric_email');
    // Sign out of Firebase
    await _auth.signOut();
    _currentUser = null;
    haptic('light');
    fcLog('Signed out');
  }

  /* ── Getters ─────────────────────────────────────────────── */
  function currentUser()  { return _currentUser || (_auth && _auth.currentUser); }
  function db()           { return _db; }
  function auth()         { return _auth; }

  async function isBiometricEnabled() {
    if (!_biometricAvailable) {
      _biometricAvailable = await checkBiometricAvailable();
    }
    const setting = await prefGet('biometric_enabled');
    return _biometricAvailable && setting !== false;
  }

  async function setBiometricEnabled(enabled) {
    await prefSet('biometric_enabled', enabled);
  }

  async function getUserDoc() {
    const user = currentUser();
    if (!user || !_db) return null;
    const doc = await _db.collection('users').doc(user.uid).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  }

  /** Get the current user's Firebase ID token (for backend auth headers) */
  async function getIdToken(forceRefresh = false) {
    const user = currentUser();
    if (!user) throw new Error('Not authenticated');
    return user.getIdToken(forceRefresh);
  }

  /**
   * fetch() wrapper that injects a Firebase ID token and retries once on 401
   * with a force-refreshed token. Use this for ALL backend calls — protects
   * against silent failures when a cached token expires mid-session.
   */
  async function authedFetch(url, opts = {}) {
    const user = currentUser();
    if (!user) throw new Error('Not authenticated');
    const send = async (forceRefresh) => {
      const token = await user.getIdToken(forceRefresh);
      const headers = Object.assign({}, opts.headers || {}, {
        Authorization: `Bearer ${token}`,
      });
      if (opts.body && !headers['Content-Type'] && typeof opts.body === 'string') {
        headers['Content-Type'] = 'application/json';
      }
      return fetch(url, Object.assign({}, opts, { headers }));
    };
    let resp = await send(false);
    if (resp.status === 401) {
      resp = await send(true);
    }
    return resp;
  }

  /* ── Jailbreak / root detection (best-effort) ───────────── */
  /**
   * Attempts to detect if the device is jailbroken using available signals.
   * This is best-effort — a sophisticated jailbreak can evade JS-level checks.
   * For production-grade protection, add a native Swift plugin (e.g. IOSSecuritySuite).
   *
   * Returns: true if jailbreak indicators found, false otherwise.
   */
  async function checkJailbreak() {
    try {
      // Only relevant on real iOS devices
      if (!window.Capacitor || !window.Capacitor.isNativePlatform()) return false;

      // Check for Cydia-injected globals (common Substrate/libhooker pattern)
      if (window.cydiaSubstrate || window.Cydia || window.substrate) return true;

      // Try to read a file outside the app sandbox using Capacitor Filesystem.
      // On a normal device, this throws a permission error.
      // On a jailbroken device, it may succeed.
      const Filesystem = Cap() && Cap().Filesystem;
      if (Filesystem) {
        try {
          await Filesystem.readFile({ path: '/Applications/Cydia.app/Info.plist' });
          return true; // readable = jailbroken
        } catch (_) {
          // Expected — file doesn't exist or no permission (normal device)
        }
        try {
          await Filesystem.readFile({ path: '/bin/bash' });
          return true; // bash outside sandbox = jailbroken
        } catch (_) {}
      }
    } catch (_) {}
    return false;
  }

  /* ── Public API ──────────────────────────────────────────── */
  return {
    init,
    onAuthStateChanged,
    signIn,
    signInWithBiometric,
    signInWithApple,
    signUp,
    sendPasswordReset,
    signOut,
    currentUser,
    db,
    auth,
    isBiometricEnabled,
    setBiometricEnabled,
    checkBiometricAvailable,
    promptBiometric,
    getUserDoc,
    getIdToken,
    authedFetch,
    checkJailbreak,
    reloadUser,
  };
})();
