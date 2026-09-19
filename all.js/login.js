(function () {
    // ---------- LOGIN / AUTHENTICATION ----------
    // Everything about who's allowed in: the on-device login (create/verify/change/
    // reset), the password-field UX (show/hide, Caps Lock warning), and the Fixed
    // section's password gate (a second password check, reusing the same account
    // credentials, before the Brand & Price master config can be opened).
    //
    // This file never touches ledger data (rows/meta/fixedConfig) directly — once a
    // login or the Fixed gate succeeds, it hands off to inventory.js via the
    // window.AppInventory bridge below.

    const { saveWithRetry, loadWithRetry } = window.AppStorage;

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    const EYE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const EYE_OFF_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a17.6 17.6 0 0 1-3.06 3.94M6.6 6.6C3.7 8.4 1 12 1 12s4 7 11 7a10.1 10.1 0 0 0 5.4-1.6M1 1l22 22"/><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88"/></svg>`;

    let loginCreds = null;

    function randomSalt() {
        if (window.crypto && crypto.getRandomValues) {
            const arr = new Uint8Array(16);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        }
        // Fallback for the rare environment without the Web Crypto API. Still unique
        // per install, just not cryptographically strong — fine for a soft access
        // screen that was never meant to be real security anyway.
        return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    async function hashPassword(password, salt) {
        const combined = salt + '::' + password;
        if (window.crypto && crypto.subtle && crypto.subtle.digest) {
            try {
                const enc = new TextEncoder();
                const data = enc.encode(combined);
                const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
            } catch (e) {
                console.warn('crypto.subtle.digest failed, falling back to a simple hash', e);
            }
        }
        // Fallback (non-cryptographic) hash for contexts without Web Crypto — e.g. some
        // very old or locked-down browsers opening this file directly. Weaker, but this
        // login was always documented as a soft access screen, not real authentication.
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < combined.length; i++) {
            const ch = combined.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + 'fallback';
    }

    async function loadLoginCreds() {
        try {
            const res = await loadWithRetry('stock_login');
            const parsed = res ? JSON.parse(res.value) : null;
            loginCreds = (parsed && typeof parsed === 'object' && parsed.username) ? parsed : null;
        } catch (e) {
            console.warn('Login state read failed, defaulting to setup screen', e);
            loginCreds = null;
        }
        renderLoginForm();
    }

    // ---------- LOGIN UX HELPERS ----------
    // Small, reusable helpers behind the friendlier login form: a show/hide toggle for
    // password fields, a Caps Lock warning (a very common reason people get "locked
    // out" of a password they typed correctly), and consistent error display/clearing.

    function pwdFieldHTML(id, labelText, placeholder, autocomplete, enterAttr) {
        return `
        <label class="login-label" for="${id}">${labelText}</label>
        <div class="pwd-field">
          <input class="login-input" type="password" id="${id}" placeholder="${placeholder}" autocomplete="${autocomplete}"
            oninput="clearLoginError(this)"
            onkeyup="watchCapsLock(event,'${id}')"
            onblur="hideCapsWarning('${id}')"
            ${enterAttr}>
          <button type="button" class="pwd-toggle-btn" id="pwdToggle_${id}" aria-label="Show password" aria-pressed="false" onclick="togglePwdVisibility('${id}')">${EYE_ICON}</button>
        </div>
        <div class="caps-warning" id="capsWarn_${id}" style="display:none;" role="status">⇪ Caps Lock is on</div>
      `;
    }

    window.togglePwdVisibility = function (id) {
        const input = document.getElementById(id);
        const btn = document.getElementById('pwdToggle_' + id);
        if (!input || !btn) return;
        const nowShown = input.type === 'password';
        input.type = nowShown ? 'text' : 'password';
        btn.innerHTML = nowShown ? EYE_OFF_ICON : EYE_ICON;
        btn.setAttribute('aria-label', nowShown ? 'Hide password' : 'Show password');
        btn.setAttribute('aria-pressed', String(nowShown));
        // Keep focus (and the cursor at the end) in the field rather than jumping to the button.
        input.focus();
        const len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (e) { /* not all input types support this */ }
    };

    window.watchCapsLock = function (event, id) {
        const warn = document.getElementById('capsWarn_' + id);
        if (!warn) return;
        const isOn = typeof event.getModifierState === 'function' && event.getModifierState('CapsLock');
        warn.style.display = isOn ? 'flex' : 'none';
    };

    window.hideCapsWarning = function (id) {
        const warn = document.getElementById('capsWarn_' + id);
        if (warn) warn.style.display = 'none';
    };

    window.clearLoginError = function (fromInput) {
        const errEl = document.getElementById('loginError');
        if (errEl && errEl.style.display !== 'none') {
            errEl.style.display = 'none';
            errEl.classList.remove('shake');
        }
        document.querySelectorAll('#loginFormArea .login-input.invalid').forEach(el => el.classList.remove('invalid'));
    };

    function showLoginFormError(msg, invalidIds) {
        const errEl = document.getElementById('loginError');
        if (!errEl) return;
        errEl.innerHTML = `<span aria-hidden="true">⚠</span><span>${escapeHtml(msg)}</span>`;
        errEl.style.display = 'flex';
        errEl.setAttribute('role', 'alert');
        errEl.classList.remove('shake');
        void errEl.offsetWidth; // restart the animation if the same error fires twice in a row
        errEl.classList.add('shake');
        (invalidIds || []).forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('invalid');
        });
    }

    function setSubmitBusy(btn, busy, busyLabel, idleLabel) {
        if (!btn) return;
        btn.disabled = busy;
        const arrow = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
        btn.innerHTML = busy ? busyLabel : `${idleLabel} ${arrow}`;
    }

    function renderLoginForm() {
        const area = document.getElementById('loginFormArea');
        if (!area) return;
        if (!loginCreds) {
            area.innerHTML = `
          <div class="login-form">
            <label class="login-label" for="loginSetupUser">Choose a username</label>
            <input class="login-input" type="text" id="loginSetupUser" placeholder="e.g. your name" autocomplete="off"
              oninput="clearLoginError(this)"
              onkeydown="if(event.key==='Enter'){event.preventDefault();document.getElementById('loginSetupPass').focus();}">
            ${pwdFieldHTML('loginSetupPass', 'Choose a password', 'Anything you\u2019ll remember', 'new-password',
                "onkeydown=\"if(event.key==='Enter'){event.preventDefault();document.getElementById('loginSetupPassConfirm').focus();}\"")}
            <div class="login-hint">At least 4 characters — pick something you won't forget, since there's no email to reset it with.</div>
            ${pwdFieldHTML('loginSetupPassConfirm', 'Confirm password', 'Type it again', 'new-password',
                "onkeydown=\"if(event.key==='Enter'){event.preventDefault();createLogin();}\"")}
            <div id="loginError" class="login-error" style="display:none;" aria-live="assertive"></div>
            <button class="login-submit-btn" id="loginSubmitBtn" onclick="createLogin()">
              Create Login &amp; Enter
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
          </div>
        `;
            setTimeout(() => { const u = document.getElementById('loginSetupUser'); if (u) u.focus(); }, 0);
        } else {
            area.innerHTML = `
          <div class="login-form">
            <div class="welcome-returning">Welcome back, <strong>${escapeHtml(loginCreds.username)}</strong></div>
            ${pwdFieldHTML('loginPass', 'Password', 'Enter your password', 'current-password',
                "onkeydown=\"if(event.key==='Enter'){event.preventDefault();attemptLogin();}\"")}
            <div id="loginError" class="login-error" style="display:none;" aria-live="assertive"></div>
            <button class="login-submit-btn" id="loginSubmitBtn" onclick="attemptLogin()">
              Sign In
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
            <button class="login-link-btn" onclick="showResetConfirm()">Not you, or forgot your password? Reset login</button>
          </div>
        `;
            setTimeout(() => { const p = document.getElementById('loginPass'); if (p) p.focus(); }, 0);
        }
    }

    window.createLogin = async function () {
        const userEl = document.getElementById('loginSetupUser');
        const passEl = document.getElementById('loginSetupPass');
        const confirmEl = document.getElementById('loginSetupPassConfirm');
        const btn = document.getElementById('loginSubmitBtn');
        const username = (userEl.value || '').trim();
        const password = passEl.value || '';
        const confirmPassword = confirmEl.value || '';

        if (!username) {
            showLoginFormError('Please choose a username.', ['loginSetupUser']);
            userEl.focus();
            return;
        }
        if (password.length < 4) {
            showLoginFormError('Please choose a password with at least 4 characters.', ['loginSetupPass']);
            passEl.focus();
            return;
        }
        if (password !== confirmPassword) {
            showLoginFormError("Those passwords don't match — please re-enter them.", ['loginSetupPass', 'loginSetupPassConfirm']);
            confirmEl.value = '';
            confirmEl.focus();
            return;
        }

        setSubmitBusy(btn, true, 'Creating your login…', 'Create Login &amp; Enter');
        try {
            const salt = randomSalt();
            const passwordHash = await hashPassword(password, salt);
            const newCreds = { username, passwordHash, salt };
            const ok = await saveWithRetry('stock_login', JSON.stringify(newCreds));
            if (!ok) {
                showLoginFormError("Couldn't save your login right now — please try again.", []);
                setSubmitBusy(btn, false, '', 'Create Login &amp; Enter');
                return;
            }
            loginCreds = newCreds;
            afterLoginSuccess(username);
        } catch (e) {
            console.error('Login creation failed', e);
            showLoginFormError('Something went wrong creating your login — please try again.', []);
            setSubmitBusy(btn, false, '', 'Create Login &amp; Enter');
        }
    };

    window.attemptLogin = async function () {
        const passEl = document.getElementById('loginPass');
        const btn = document.getElementById('loginSubmitBtn');
        const entered = passEl.value || '';

        if (!entered) {
            showLoginFormError('Please enter your password.', ['loginPass']);
            passEl.focus();
            return;
        }
        if (!loginCreds) {
            showLoginFormError('Incorrect password. Please try again.', ['loginPass']);
            passEl.value = '';
            passEl.focus();
            return;
        }

        setSubmitBusy(btn, true, 'Signing in…', 'Sign In');
        try {
            const enteredHash = await hashPassword(entered, loginCreds.salt);
            if (enteredHash !== loginCreds.passwordHash) {
                showLoginFormError('Incorrect password. Please try again.', ['loginPass']);
                passEl.value = '';
                passEl.focus();
                setSubmitBusy(btn, false, '', 'Sign In');
                return;
            }
            afterLoginSuccess(loginCreds.username);
        } catch (e) {
            console.error('Login attempt failed', e);
            showLoginFormError('Something went wrong signing in — please try again.', []);
            setSubmitBusy(btn, false, '', 'Sign In');
        }
    };

    function afterLoginSuccess(username) {
        // Nice-to-have: prefill the bartender name if it hasn't been set yet. This is
        // ledger data, so inventory.js owns the actual logic — login.js just hands off
        // the username once it knows who successfully logged in.
        window.AppInventory.prefillBartenderIfEmpty(username);
        const navUserEl = document.getElementById('navUser');
        if (navUserEl) navUserEl.innerHTML = `Logged in as <strong>${escapeHtml(username)}</strong>`;
        enterSystem();
    }

    window.doLogout = function () {
        if (!confirm("Log out? You'll need to enter the password again to get back in.")) return;
        document.getElementById('app').style.display = 'none';
        document.getElementById('welcomeScreen').classList.remove('hidden');
        renderLoginForm();
    };

    window.showResetConfirm = function () {
        if (!confirm('Reset the login for this file? Anyone who opens it afterward will be able to set new credentials — only do this if you forgot yours.')) return;
        resetLogin();
    };

    async function resetLogin() {
        loginCreds = null;
        const ok = await saveWithRetry('stock_login', JSON.stringify(null));
        if (!ok) {
            alert("The reset didn't fully save due to a storage error — if you reopen this file before it resolves, your old login may still be there. Try again in a moment.");
        }
        renderLoginForm();
    }

    window.openChangePasswordModal = function () {
        document.getElementById('cpCurrent').value = '';
        document.getElementById('cpNew').value = '';
        document.getElementById('cpConfirm').value = '';
        document.getElementById('cpError').style.display = 'none';
        document.getElementById('changePasswordModal').classList.add('show');
        setTimeout(() => document.getElementById('cpCurrent').focus(), 0);
    };

    window.closeChangePasswordModal = function () {
        document.getElementById('changePasswordModal').classList.remove('show');
    };

    window.submitChangePassword = async function () {
        const curEl = document.getElementById('cpCurrent');
        const newEl = document.getElementById('cpNew');
        const confirmEl = document.getElementById('cpConfirm');
        const errEl = document.getElementById('cpError');
        const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };

        if (!loginCreds) { showErr('No login is currently set up.'); return; }
        const curHash = await hashPassword(curEl.value || '', loginCreds.salt);
        if (curHash !== loginCreds.passwordHash) { showErr('Current password is incorrect.'); return; }
        if (!newEl.value) { showErr('Please enter a new password.'); return; }
        if (newEl.value !== confirmEl.value) { showErr('New passwords do not match.'); return; }

        const newSalt = randomSalt();
        const newHash = await hashPassword(newEl.value, newSalt);
        const newCreds = { username: loginCreds.username, passwordHash: newHash, salt: newSalt };
        const ok = await saveWithRetry('stock_login', JSON.stringify(newCreds));
        if (!ok) { showErr("Couldn't save the new password right now — please try again."); return; }
        loginCreds = newCreds;
        document.getElementById('changePasswordModal').classList.remove('show');
        window.AppInventory.flashStatus('PASSWORD UPDATED');
    };

    window.enterSystem = function () {
        const welcome = document.getElementById('welcomeScreen');
        const app = document.getElementById('app');
        if (welcome) welcome.classList.add('hidden');
        if (app) app.style.display = '';
    };


    // ---------- FIXED SECTION PASSWORD GATE ----------
    // Reuses the same account password as login — there's no separate "admin"
    // credential. On success, control passes to inventory.js's Fixed editor.
    window.openFixedGate = function () {
        const passEl = document.getElementById('fixedGatePass');
        const errEl = document.getElementById('fixedGateError');
        if (passEl) passEl.value = '';
        if (errEl) errEl.style.display = 'none';
        document.getElementById('fixedGateModal').classList.add('show');
        setTimeout(() => { if (passEl) passEl.focus(); }, 0);
    };

    window.closeFixedGate = function () {
        document.getElementById('fixedGateModal').classList.remove('show');
    };

    window.clearFixedGateError = function () {
        const errEl = document.getElementById('fixedGateError');
        if (errEl) errEl.style.display = 'none';
    };

    window.submitFixedGate = async function () {
        const passEl = document.getElementById('fixedGatePass');
        const errEl = document.getElementById('fixedGateError');
        const btn = document.getElementById('fixedGateSubmitBtn');
        const entered = passEl.value || '';
        if (!entered) {
            errEl.textContent = 'Please enter your password.';
            errEl.style.display = 'block';
            passEl.focus();
            return;
        }
        if (!loginCreds) {
            errEl.textContent = 'No login is set up on this device yet.';
            errEl.style.display = 'block';
            return;
        }
        btn.disabled = true;
        try {
            const hash = await hashPassword(entered, loginCreds.salt);
            if (hash !== loginCreds.passwordHash) {
                errEl.textContent = 'Incorrect password. Please try again.';
                errEl.style.display = 'block';
                passEl.value = '';
                passEl.focus();
                return;
            }
            closeFixedGate();
            await window.AppInventory.openFixedEditor();
        } catch (e) {
            console.error('Fixed gate check failed', e);
            errEl.textContent = 'Something went wrong checking your password — please try again.';
            errEl.style.display = 'block';
        } finally {
            btn.disabled = false;
        }
    };


    window.AppLogin = { loadLoginCreds };
})();