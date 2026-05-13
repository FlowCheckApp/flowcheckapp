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
    const cred = await _auth.signInWithEmailAndPassword(email, password);

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
  async function signUp(name, email, password) {
    if (!_auth) init();
    const cred = await _auth.createUserWithEmailAndPassword(email, password);
    const user = cred.user;

    // Set display name
    await user.updateProfile({ displayName: name });

    // Create Firestore user document
    await _db.collection('users').doc(user.uid).set({
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
      notifications_enabled: true,
      biometric_enabled:     true,
    });

    haptic('medium');
    return user;
  }

  /* ── Sign in with Apple ──────────────────────────────────── */
  async function signInWithApple() {
    if (!_auth) init();
    // Use Capacitor's Sign in with Apple if on iOS, otherwise Firebase popup
    const isNative = window.Capacitor && window.Capacitor.isNativePlatform();

    if (isNative && Cap() && Cap().SignInWithApple) {
      // capacitor-sign-in-with-apple plugin
      const result = await Cap().SignInWithApple.Authorize();
      const provider = new firebase.auth.OAuthProvider('apple.com');
      const credential = provider.credential({
        idToken:    result.response.identityToken,
        rawNonce:   result.response.authorizationCode,
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
      // Web fallback (dev/simulator)
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
    // Clear biometric preference
    await prefRemove('biometric_enabled');
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
  };
})();
