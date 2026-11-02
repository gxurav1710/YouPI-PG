
    let state = null;
    let countdownTimer = null;
    let queuePollTimer = null;
    let sse = null;
    let activeCustomer = null;
    let activeToken = null;

    const STORAGE_KEY_IDENTITY = 'youpi.customer.identity';
    const STORAGE_KEY_ACCOUNTS = 'youpi.customer.accounts';
    const STORAGE_KEY_ACTIVE = 'youpi.customer.activeId';
    const MAX_IDENTITY_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (maximum 1 week)

    // Client-side obfuscation layer for localStorage to prevent casual/cleartext inspection of customer tokens
    function encryptClientStorage(plainText) {
      if (!plainText) return '';
      try {
        let cipher = '';
        for (let i = 0; i < plainText.length; i++) {
          cipher += String.fromCharCode(plainText.charCodeAt(i) ^ 0x5a);
        }
        return btoa(cipher);
      } catch {
        return '';
      }
    }

    function decryptClientStorage(cipherText) {
      if (!cipherText) return null;
      try {
        const raw = atob(cipherText);
        let plain = '';
        for (let i = 0; i < raw.length; i++) {
          plain += String.fromCharCode(raw.charCodeAt(i) ^ 0x5a);
        }
        try { return JSON.parse(plain); } catch { return plain; }
      } catch {
        try { return JSON.parse(cipherText); } catch { return cipherText; }
      }
    }

    function getStoredCustomerToken() {
      try {
        const raw = localStorage.getItem('ypg_customer_token');
        if (!raw) return null;
        return decryptClientStorage(raw) || raw;
      } catch {
        return null;
      }
    }

    function getPreservedIdentity() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_IDENTITY);
        if (!raw) return null;
        const data = decryptClientStorage(raw);
        if (!data || !data.customer) {
          clearPreservedIdentity();
          return null;
        }
        const now = Date.now();
        const expiry = data.expiresAt || ((data.savedAt || now) + MAX_IDENTITY_AGE_MS);
        if (now > expiry) {
          console.log('[Auth] Preserved identity expired (> 1 week). Purging.');
          clearPreservedIdentity();
          return null;
        }
        return data;
      } catch {
        return null;
      }
    }

    function savePreservedIdentity(cust, token) {
      if (!cust || !cust.id) return;
      try {
        const now = Date.now();
        const cleanCust = {
          id: cust.id,
          name: cust.name || cust.fullName || 'Customer',
          status: cust.status || 'ACTIVE'
        };
        const resolvedToken = token || activeToken || getStoredCustomerToken() || null;
        const payload = {
          customer: cleanCust,
          token: resolvedToken,
          savedAt: now,
          expiresAt: now + MAX_IDENTITY_AGE_MS
        };
        // 1. Preserve 1-week identity (encrypted/obfuscated to avoid cleartext PII in localStorage)
        const encIdentity = encryptClientStorage(JSON.stringify(payload));
        if (encIdentity) localStorage.setItem(STORAGE_KEY_IDENTITY, encIdentity);
        // 2. Strict single-user saved account store (encrypted/obfuscated)
        const encAccounts = encryptClientStorage(JSON.stringify([cleanCust]));
        if (encAccounts) localStorage.setItem(STORAGE_KEY_ACCOUNTS, encAccounts);
        localStorage.setItem(STORAGE_KEY_ACTIVE, cust.id);
        if (resolvedToken) {
          const encToken = encryptClientStorage(resolvedToken);
          if (encToken) localStorage.setItem('ypg_customer_token', encToken);
        }
      } catch { }
    }

    function clearPreservedIdentity() {
      try {
        localStorage.removeItem(STORAGE_KEY_IDENTITY);
        localStorage.removeItem(STORAGE_KEY_ACCOUNTS);
        localStorage.removeItem(STORAGE_KEY_ACTIVE);
        localStorage.removeItem('ypg_customer_token');
      } catch { }
    }

    // Immediately restore 1-week preserved identity if present
    const initPreserved = getPreservedIdentity();
    if (initPreserved && initPreserved.customer) {
      activeCustomer = initPreserved.customer;
      activeToken = initPreserved.token || null;
    }

    // Notify parent if embedded in iframe
    if (window.parent !== window || location.search.includes('embedded=1')) {
      document.body.classList.add('is-embedded');
      try {
        postToMerchant({ event: 'youpi.modal_ready', paymentId: PAYMENT_ID });
      } catch (e) { }
    }

    // Dismiss Initial Splash Screen smoothly after brief intro
    function dismissSplashScreen() {
      const splash = document.getElementById('ypgSplashScreen');
      if (splash && !splash.classList.contains('fade-out')) {
        setTimeout(() => {
          splash.classList.add('fade-out');
        }, 550);
      }
    }

    // Toast helper
    let toastTimer = null;
    function showOptionToast(msg) {
      const toast = document.getElementById('ypgToast');
      if (!toast) return;
      toast.textContent = msg;
      toast.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.classList.remove('show');
      }, 2500);
    }

    // Toggle Order Breakdown Drawer
    function toggleOrderDetails() {
      const drawer = document.getElementById('orderDetailsDrawer');
      const chevron = document.getElementById('chevronDetailsIcon');
      if (!drawer) return;
      const isOpen = drawer.classList.contains('open');
      if (isOpen) {
        drawer.classList.remove('open');
        if (chevron) chevron.innerHTML = '&#9652;';
      } else {
        drawer.classList.add('open');
        if (chevron) chevron.innerHTML = '&#9662;';
      }
    }

    // Failure redirect URL resolver
    function getFailedRedirectUrl() {
      const orderId = state?.orderId || '';
      const reason = state?.status || 'FAILED';
      const paymentId = typeof PAYMENT_ID !== 'undefined' ? PAYMENT_ID : (state?.id || '');

      let baseOrigin = '';
      if (state && state.returnUrl) {
        try {
          baseOrigin = new URL(state.returnUrl).origin;
        } catch (e) { }
      }
      if (!baseOrigin && document.referrer) {
        try {
          baseOrigin = new URL(document.referrer).origin;
        } catch (e) { }
      }

      const query = `orderId=${encodeURIComponent(orderId)}&reason=${encodeURIComponent(reason)}&paymentId=${encodeURIComponent(paymentId)}`;
      return baseOrigin ? `${baseOrigin}/order-failed?${query}` : `/order-failed?${query}`;
    }

    /**
     * Only http/https URLs may be navigated to. Blocks `javascript:`, `data:` and other
     * schemes that would execute script in the checkout origin.
     */
    function sanitizeRedirectUrl(candidate) {
      if (typeof candidate !== 'string') return null;
      const trimmed = candidate.trim();
      if (!trimmed) return null;
      let parsed;
      try {
        parsed = new URL(trimmed, window.location.origin);
      } catch (e) {
        return null;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.href;
    }

    /**
     * Origin of the storefront embedding this iframe, used as the postMessage target.
     * Returns null when the embedder cannot be identified (callers then fall back to '*').
     */
    function resolveMerchantOrigin() {
      try {
        if (document.referrer) {
          const parsed = new URL(document.referrer);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
        }
      } catch (e) { }
      try {
        const params = new URLSearchParams(window.location.search);
        const explicit = params.get('origin') || params.get('merchantOrigin');
        if (explicit) {
          const parsed = new URL(explicit, window.location.origin);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
        }
      } catch (e) { }
      return null;
    }

    // Posts to the embedding storefront. The message carries payment data, so it
    // is only ever sent to a known merchant origin: when the origin cannot be
    // resolved the message is dropped rather than broadcast to every origin.
    function postToMerchant(message) {
      const target = resolveMerchantOrigin();
      if (!target) return;
      try {
        window.parent.postMessage(message, target);
      } catch (e) { }
    }

    // Store return URL resolver (used when user cancels payment or returns to merchant store)
    function getStoreReturnUrl() {
      if (typeof state !== 'undefined' && state) {
        if (state.cancelUrl) {
          return state.cancelUrl;
        }
        if (state.returnUrl) {
          try {
            const parsed = new URL(state.returnUrl);
            return parsed.origin ? `${parsed.origin}/` : state.returnUrl;
          } catch (e) { }
        }
      }
      try {
        const params = new URLSearchParams(window.location.search);
        const cancelParam = params.get('cancelUrl') || params.get('cancel_url');
        if (cancelParam) return cancelParam;
        const qUrl = params.get('returnUrl') || params.get('storeUrl') || params.get('redirectUrl');
        if (qUrl) {
          const parsed = new URL(qUrl, window.location.origin);
          return parsed.origin ? `${parsed.origin}/` : qUrl;
        }
      } catch (e) { }
      if (document.referrer) {
        try {
          const refUrl = new URL(document.referrer);
          if (refUrl.host !== window.location.host) {
            return `${refUrl.origin}/`;
          }
        } catch (e) { }
      }
      if (window.location.port === '7000' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return 'http://localhost:5000/';
      }
      return '/';
    }

    // Retry / Close on Expired or Failed session
    function handleRetryNewPayment() {
      if (typeof handleEndAndStartNewPayment === 'function') {
        handleEndAndStartNewPayment();
        return;
      }
      const failRedirectUrl = getFailedRedirectUrl();
      const orderId = state?.orderId || '';
      const reason = state?.status || 'FAILED';
      const paymentId = typeof PAYMENT_ID !== 'undefined' ? PAYMENT_ID : (state?.id || '');

      const isEmbedded = (window.parent !== window) || location.search.includes('embedded=1');

      if (isEmbedded) {
        try {
          postToMerchant({
            event: 'youpi.payment_failed',
            data: {
              orderId,
              reason,
              paymentId,
              status: reason,
              redirectUrl: failRedirectUrl
            },
            orderId,
            reason,
            paymentId,
            status: reason,
            redirectUrl: failRedirectUrl
          });
        } catch (e) { }

        // Fallback postMessage in case parent container only listens for modal_close
        try {
          postToMerchant({
            event: 'youpi.modal_close',
            action: 'payment_failed',
            redirectUrl: failRedirectUrl
          });
        } catch (e) { }
      } else {
        // Standalone full page checkout
        const safeFailUrl = sanitizeRedirectUrl(failRedirectUrl);
        if (safeFailUrl) window.location.href = safeFailUrl;
      }
    }

    // --- ACTION HOOK ENGINE (Dispatches triggers to merchant website and backend telemetry) ---
    function emitTriggerHook(action, details = {}) {
      try {
        postToMerchant({
          type: 'YOUPI_PAYMENT_HOOK',
          action,
          paymentId: PAYMENT_ID,
          orderId: state?.orderId,
          details
        });
      } catch { }

      fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/trigger-hook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, details })
      }).catch(() => { });
    }

    // --- SAVED / REMEMBERED CUSTOMER ACCOUNT (STRICT SINGLE USER) ---
    function getRememberedAccounts() {
      try {
        const preserved = getPreservedIdentity();
        if (preserved && preserved.customer) {
          return [preserved.customer];
        }
        const raw = localStorage.getItem(STORAGE_KEY_ACCOUNTS);
        if (!raw) return [];
        const parsed = decryptClientStorage(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) return [];
        return [parsed[0]]; // Strictly single user only
      } catch {
        return [];
      }
    }

    function saveRememberedAccount(cust, token) {
      if (!cust || !cust.id) return;
      savePreservedIdentity(cust, token);
    }

    function removeRememberedAccount(customerId, e) {
      if (e) {
        e.stopPropagation();
        e.preventDefault();
      }
      clearPreservedIdentity();
      if (activeCustomer && activeCustomer.id === customerId) {
        activeCustomer = null;
        activeToken = null;
      }
      updateCustomerDisplay(null);
      renderSavedAccountsUI();
    }

    function renderSavedAccountsUI() {
      const accounts = getRememberedAccounts();
      const container = document.getElementById('preAuthSavedAccountsContainer');
      const listEl = document.getElementById('savedAccountsList');
      const badge = document.getElementById('savedAccountCountBadge');

      if (badge) badge.style.display = 'none';

      if (container && listEl) {
        if (accounts.length > 0) {
          container.hidden = false;
          let html = '';
          accounts.slice(0, 1).forEach(acc => {
            const initial = (acc.name || 'U').charAt(0).toUpperCase();
            const isActive = activeCustomer && activeCustomer.id === acc.id;
            html += `
              <div class="saved-account-row ${isActive ? 'active' : ''}" onclick="handleSelectSavedAccount('${acc.id}', event)">
                <div style="display:flex; align-items:center; gap:8px;">
                  <div style="width:28px; height:28px; border-radius:50%; background:#e0f2fe; color:#0369a1; font-weight:800; font-size:12px; display:flex; align-items:center; justify-content:center;">${initial}</div>
                  <div>
                    <div style="font-size:13px; font-weight:700;">${escapeHtml(acc.name)}</div>
                    <div style="font-size:11px; color:#64748b;">${escapeHtml(acc.email || '')} ${acc.mobileNumber ? '&bull; ' + escapeHtml(acc.mobileNumber) : ''}</div>
                  </div>
                </div>
                <div style="display:flex; align-items:center; gap:6px;">
                  <button type="button" class="ypg-btn-select-account" style="background:#eff6ff; border:1px solid #bfdbfe; color:var(--ypg-blue); font-size:11px; font-weight:700; padding:4px 10px; border-radius:6px; cursor:pointer; display:inline-flex; align-items:center; gap:2px; transition:all 0.15s;" onclick="handleSelectSavedAccount('${acc.id}', event)">
                    <span>Select</span> &rsaquo;
                  </button>
                  <button type="button" style="background:none; border:none; color:#94a3b8; font-size:14px; cursor:pointer; padding:2px 6px;" onclick="removeRememberedAccount('${acc.id}', event)" title="Remove Account">✕</button>
                </div>
              </div>
            `;
          });
          listEl.innerHTML = html;
        } else {
          container.hidden = true;
          listEl.innerHTML = '';
        }
      }
    }

    let currentAuthMobile = '';
    let currentAuthName = '';
    let currentAuthEmail = '';
    let currentAuthStep = 'mobile';
    let hasAttemptedAutoLogin = false;
    let otpCooldownTimer = null;
    let otpCooldownSec = 0;

    function setGatewayAuthMode(isAuthView) {
      const authEl = document.getElementById('preGatewayAuthView');
      const payEl = document.getElementById('paymentGatewayInterface');
      const footerEl = document.getElementById('ypgStickyFooter');
      const pcTopbarTitle = document.querySelector('.ypg-pc-topbar-title');

      if (isAuthView) {
        if (authEl) {
          authEl.hidden = false;
          authEl.style.removeProperty('display');
        }
        if (payEl) {
          payEl.hidden = true;
          payEl.style.setProperty('display', 'none', 'important');
        }
        if (footerEl) {
          footerEl.style.display = 'none';
        }
        if (pcTopbarTitle) {
          pcTopbarTitle.textContent = 'Sign in to Pay';
        }
      } else {
        if (authEl) {
          authEl.hidden = true;
          authEl.style.setProperty('display', 'none', 'important');
        }
        if (payEl) {
          payEl.hidden = false;
          payEl.style.removeProperty('display');
        }
        if (footerEl) {
          footerEl.style.display = '';
        }
        if (pcTopbarTitle) {
          pcTopbarTitle.textContent = 'Payment Options';
        }
      }
    }

    function goToAuthStep(step) {
      currentAuthStep = step;
      const stepMobile = document.getElementById('authStepMobile');
      const stepSignup = document.getElementById('authStepSignup');
      const stepOtp = document.getElementById('authStepOtp');
      const title = document.getElementById('authViewMainTitle');
      const subtitle = document.getElementById('authViewSubTitle');
      const savedAccountsBox = document.getElementById('preAuthSavedAccountsContainer');

      if (step === 'mobile') {
        if (stepMobile) stepMobile.hidden = false;
        if (stepSignup) stepSignup.hidden = true;
        if (stepOtp) stepOtp.hidden = true;
        if (savedAccountsBox && getRememberedAccounts().length > 0) savedAccountsBox.hidden = false;
        if (title) title.innerText = 'Sign in to Pay';
        if (subtitle) subtitle.innerText = 'Enter your 10-digit WhatsApp mobile number to continue';
        const input = document.getElementById('authMobileInput');
        if (input) {
          if (currentAuthMobile && !input.value) {
            input.value = currentAuthMobile;
          }
          if (document.activeElement !== input) {
            setTimeout(() => input.focus(), 50);
          }
        }
      } else if (step === 'signup') {
        if (stepMobile) stepMobile.hidden = true;
        if (stepSignup) stepSignup.hidden = false;
        if (stepOtp) stepOtp.hidden = true;
        if (savedAccountsBox) savedAccountsBox.hidden = true;
        if (title) title.innerText = 'Create Account';
        if (subtitle) subtitle.innerText = 'Complete your profile to proceed with instant checkout';
        const badge = document.getElementById('authSignupPhoneBadge');
        if (badge) badge.innerText = '+91 ' + currentAuthMobile;
        const nameInput = document.getElementById('authSignupName');
        const emailInput = document.getElementById('authSignupEmail');
        if (nameInput && currentAuthName && !nameInput.value) nameInput.value = currentAuthName;
        if (emailInput && currentAuthEmail && !emailInput.value) emailInput.value = currentAuthEmail;
        if (nameInput && document.activeElement !== nameInput && document.activeElement !== emailInput) {
          setTimeout(() => nameInput.focus(), 50);
        }
      } else if (step === 'otp') {
        if (stepMobile) stepMobile.hidden = true;
        if (stepSignup) stepSignup.hidden = true;
        if (stepOtp) stepOtp.hidden = false;
        if (savedAccountsBox) savedAccountsBox.hidden = true;
        if (title) title.innerText = 'Verify Mobile OTP';
        if (subtitle) subtitle.innerText = 'Enter the 6-digit code sent to your WhatsApp number';
        const badge = document.getElementById('authOtpPhoneBadge');
        if (badge) badge.innerText = '+91 ' + currentAuthMobile;
        const otpInput = document.getElementById('authOtpInput');
        if (otpInput) {
          otpInput.value = '';
          setTimeout(() => otpInput.focus(), 50);
        }
        startOtpCooldown(30);
      }
    }

    function startOtpCooldown(sec = 30) {
      clearInterval(otpCooldownTimer);
      otpCooldownSec = sec;
      const resendBtn = document.getElementById('btnResendOtp');
      const countdownEl = document.getElementById('otpCountdownTimer');

      const updateUI = () => {
        if (otpCooldownSec > 0) {
          if (resendBtn) {
            resendBtn.disabled = true;
            resendBtn.style.opacity = '0.5';
            resendBtn.style.cursor = 'not-allowed';
          }
          if (countdownEl) countdownEl.innerText = `(${otpCooldownSec}s)`;
          otpCooldownSec--;
        } else {
          clearInterval(otpCooldownTimer);
          if (resendBtn) {
            resendBtn.disabled = false;
            resendBtn.style.opacity = '1';
            resendBtn.style.cursor = 'pointer';
          }
          if (countdownEl) countdownEl.innerText = '';
        }
      };

      updateUI();
      otpCooldownTimer = setInterval(updateUI, 1000);
    }

    async function handleAuthMobileSubmit() {
      const input = document.getElementById('authMobileInput');
      const btn = document.getElementById('btnAuthContinue');
      const raw = input ? input.value : '';
      const clean = String(raw).replace(/\D/g, '').slice(-10);

      if (!clean || clean.length !== 10) {
        showOptionToast('Please enter a valid 10-digit mobile number');
        input?.focus();
        return;
      }

      currentAuthMobile = clean;
      const oldHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span>Checking account...</span>';

      try {
        const res = await fetch(`${API_BASE}/api/v1/customer/check-user`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobileNumber: clean })
        });
        const data = await res.json();

        if (!res.ok) {
          showOptionToast(data.error || 'Failed to check mobile number');
          return;
        }

        const accounts = getRememberedAccounts();
        const savedMatch = accounts.find(a => String(a.mobileNumber || '').replace(/\D/g, '').slice(-10) === clean);

        if (data.exists && data.customer) {
          // Existing customer in DB -> automatically send OTP and show OTP screen
          currentAuthName = data.customer.name;
          currentAuthEmail = data.customer.email;
          btn.innerHTML = '<span>Sending WhatsApp OTP...</span>';

          const sendRes = await fetch(`${API_BASE}/api/v1/customer/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mobileNumber: clean
            })
          });
          const sendData = await sendRes.json();
          if (sendData && sendData.devOtp) lastReceivedDevOtp = sendData.devOtp;

          const greetingEl = document.getElementById('authOtpGreeting');
          if (greetingEl) {
            greetingEl.innerHTML = `Welcome back, <strong>${escapeHtml(data.customer.name)}</strong>! Enter the 6-digit WhatsApp OTP:`;
          }

          goToAuthStep('otp');
          showOptionToast('OTP sent to your WhatsApp number!');
        } else if (savedMatch) {
          // Known customer in browser saved accounts -> dispatch OTP directly with saved profile
          currentAuthName = savedMatch.name || 'Customer';
          currentAuthEmail = savedMatch.email || '';
          btn.innerHTML = '<span>Sending WhatsApp OTP...</span>';

          const sendRes = await fetch(`${API_BASE}/api/v1/customer/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mobileNumber: clean,
              name: currentAuthName,
              email: currentAuthEmail
            })
          });
          const sendData = await sendRes.json();
          if (sendData && sendData.devOtp) lastReceivedDevOtp = sendData.devOtp;

          const greetingEl = document.getElementById('authOtpGreeting');
          if (greetingEl) {
            greetingEl.innerHTML = `Welcome back, <strong>${escapeHtml(currentAuthName)}</strong>! Enter the 6-digit WhatsApp OTP:`;
          }

          goToAuthStep('otp');
          showOptionToast('OTP sent to your WhatsApp number!');
        } else {
          // New customer -> prompt for name and email
          goToAuthStep('signup');
        }
      } catch (e) {
        showOptionToast('Network error checking mobile number.');
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    }

    async function handleAuthSignupSubmit() {
      const nameInput = document.getElementById('authSignupName');
      const emailInput = document.getElementById('authSignupEmail');
      const btn = document.getElementById('btnAuthSignup');

      const name = nameInput ? nameInput.value.trim() : '';
      const email = emailInput ? emailInput.value.trim() : '';

      if (!name) {
        showOptionToast('Please enter your full name');
        nameInput?.focus();
        return;
      }
      if (!email || !email.includes('@') || !email.includes('.')) {
        showOptionToast('Please enter a valid email address');
        emailInput?.focus();
        return;
      }

      currentAuthName = name;
      currentAuthEmail = email;

      const oldHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span>Sending WhatsApp OTP...</span>';

      try {
        const res = await fetch(`${API_BASE}/api/v1/customer/send-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mobileNumber: currentAuthMobile,
            name,
            email,
            isNewUser: true
          })
        });
        const data = await res.json();
        if (data && data.devOtp) lastReceivedDevOtp = data.devOtp;

        if (res.ok) {
          const greetingEl = document.getElementById('authOtpGreeting');
          if (greetingEl) {
            greetingEl.innerHTML = `Hello <strong>${escapeHtml(name)}</strong>! Enter the 6-digit WhatsApp OTP:`;
          }
          goToAuthStep('otp');
          showOptionToast('WhatsApp verification code sent!');
        } else {
          showOptionToast(data.error || 'Failed to send WhatsApp OTP.');
        }
      } catch (e) {
        showOptionToast('Network error sending WhatsApp OTP.');
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    }

    async function handleAuthVerifyOtpSubmit() {
      const otpInput = document.getElementById('authOtpInput');
      const btn = document.getElementById('btnAuthVerifyOtp');
      const otp = otpInput ? otpInput.value.trim() : '';

      if (!otp || otp.length < 6) {
        showOptionToast('Please enter the 6-digit WhatsApp OTP');
        otpInput?.focus();
        return;
      }

      const oldHtml = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span>Verifying OTP...</span>';

      try {
        const res = await fetch(`${API_BASE}/api/v1/customer/verify-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mobileNumber: currentAuthMobile,
            otp,
            name: currentAuthName,
            email: currentAuthEmail
          })
        });
        const data = await res.json();

        if (res.ok && data.customer) {
          activeCustomer = data.customer;
          activeToken = data.token;
          saveRememberedAccount(activeCustomer, activeToken);

          // Bind session
          await fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/bind-customer`, {
            method: 'POST',
            headers: getApiHeaders({
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${activeToken}`
            }),
            body: JSON.stringify({ token: activeToken, customerId: activeCustomer.id })
          });

          emitTriggerHook('AUTH_COMPLETED', { customerId: activeCustomer.id });

          setGatewayAuthMode(false);
          updateCustomerDisplay(activeCustomer);
          loadState();
          showOptionToast(`Welcome, ${activeCustomer.name}! Verified via WhatsApp.`);
        } else {
          showOptionToast(data.error || 'Invalid or expired OTP. Please try again.');
          otpInput.select();
        }
      } catch (e) {
        showOptionToast('Network error verifying OTP.');
      } finally {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    }

    async function handleResendOtp() {
      if (otpCooldownSec > 0) return;
      showOptionToast('Resending WhatsApp OTP...');
      try {
        const res = await fetch(`${API_BASE}/api/v1/customer/send-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mobileNumber: currentAuthMobile,
            name: currentAuthName,
            email: currentAuthEmail
          })
        });
        const data = await res.json();
        if (res.ok) {
          startOtpCooldown(30);
          showOptionToast('Fresh OTP dispatched to your WhatsApp number!');
          const otpInput = document.getElementById('authOtpInput');
          if (otpInput) {
            otpInput.value = '';
            otpInput.focus();
          }
        } else {
          showOptionToast(data.error || 'Failed to resend OTP.');
        }
      } catch (e) {
        showOptionToast('Network error resending OTP.');
      }
    }

    async function handleSelectSavedAccount(accountId, event) {
      if (event) {
        event.stopPropagation();
      }
      const accounts = getRememberedAccounts();
      const account = accounts.find(a => a.id === accountId);
      if (!account) return;

      const rawPhone = account.mobileNumber || '';
      const clean = String(rawPhone).replace(/\D/g, '').slice(-10);

      if (!clean || clean.length !== 10) {
        showOptionToast('Saved account does not have a valid 10-digit mobile number.');
        const input = document.getElementById('authMobileInput');
        if (input) {
          input.value = rawPhone;
          input.focus();
        }
        return;
      }

      currentAuthMobile = clean;
      currentAuthName = account.name || 'Customer';
      currentAuthEmail = account.email || '';

      const input = document.getElementById('authMobileInput');
      if (input) input.value = clean;

      // Provide visual loading feedback on the clicked button if present
      const selectBtn = event?.currentTarget?.querySelector?.('.ypg-btn-select-account') ||
        (event?.target?.classList?.contains('ypg-btn-select-account') ? event.target : null);
      const oldBtnHtml = selectBtn ? selectBtn.innerHTML : null;
      if (selectBtn) {
        selectBtn.disabled = true;
        selectBtn.innerHTML = '<span>Sending OTP...</span>';
      }

      showOptionToast(`Sending WhatsApp OTP to +91 ${clean}...`);

      try {
        const res = await fetch(`${API_BASE}/api/v1/customer/send-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mobileNumber: clean,
            name: currentAuthName,
            email: currentAuthEmail
          })
        });
        const data = await res.json();
        if (data && data.devOtp) lastReceivedDevOtp = data.devOtp;

        if (!res.ok) {
          showOptionToast(data.error || 'Failed to send WhatsApp OTP.');
          return;
        }

        const greetingEl = document.getElementById('authOtpGreeting');
        if (greetingEl) {
          greetingEl.innerHTML = `Welcome back, <strong>${escapeHtml(account.name || 'Customer')}</strong>! Enter the 6-digit WhatsApp OTP:`;
        }
        const badge = document.getElementById('authOtpPhoneBadge');
        if (badge) badge.innerText = '+91 ' + clean;

        goToAuthStep('otp');
        showOptionToast('WhatsApp verification code sent!');
      } catch (err) {
        console.error('[Select Saved Account Error]:', err);
        showOptionToast('Network error sending WhatsApp OTP.');
      } finally {
        if (selectBtn && oldBtnHtml) {
          selectBtn.disabled = false;
          selectBtn.innerHTML = oldBtnHtml;
        }
      }
    }

    function updateCustomerDisplay(cust) {
      const displayName = cust
        ? `${cust.fullName || cust.name || 'Customer'} (${cust.mobileNumber || cust.phoneNumber || cust.email || ''})`
        : 'Guest User';
      const nameElMobile = document.getElementById('popoverCustomerName');
      if (nameElMobile) nameElMobile.textContent = displayName;
      const nameElPc = document.getElementById('popoverCustomerNamePc');
      if (nameElPc) nameElPc.textContent = displayName;

      const pcCustomerText = document.getElementById('pcCustomerProfileText');
      if (pcCustomerText) {
        if (!cust) {
          pcCustomerText.textContent = 'Using as Guest User';
          return;
        }
        const name = cust.fullName || cust.name || cust.customerName || '';
        const phone = cust.mobileNumber || cust.phoneNumber || '';
        const clean = phone ? String(phone).replace(/^\+91/, '').replace(/\D/g, '').slice(-10) : '';
        if (name && clean) {
          pcCustomerText.textContent = `Using as ${name} (+91 ${clean})`;
        } else if (name) {
          pcCustomerText.textContent = `Using as ${name}`;
        } else if (clean) {
          pcCustomerText.textContent = `Using as +91 ${clean}`;
        } else if (cust.email) {
          pcCustomerText.textContent = `Using as ${cust.email}`;
        } else {
          pcCustomerText.textContent = 'Using as Guest User';
        }
      }
    }

    function toggleAccountMenu(e) {
      if (e) {
        e.stopPropagation();
        e.preventDefault();
      }
      const isPc = window.innerWidth > 600 && !document.body.classList.contains('is-embedded-mobile');
      const popover = isPc
        ? (document.getElementById('accountMenuPopoverPc') || document.getElementById('accountMenuPopover'))
        : (document.getElementById('accountMenuPopover') || document.getElementById('accountMenuPopoverPc'));
      if (!popover) return;

      const isHidden = popover.hidden || popover.style.display === 'none' || popover.hasAttribute('hidden');
      if (isHidden) {
        popover.removeAttribute('hidden');
        popover.hidden = false;
        popover.style.display = 'block';
        const dismissHandler = (evt) => {
          if (!popover.contains(evt.target) &&
              !evt.target.closest('#btnProfileMenu') &&
              !evt.target.closest('.ypg-pc-btn-more') &&
              !evt.target.closest('#btnPcMore') &&
              !evt.target.closest('#pcCustomerProfileRow')) {
            popover.setAttribute('hidden', '');
            popover.hidden = true;
            popover.style.display = 'none';
            document.removeEventListener('click', dismissHandler);
          }
        };
        setTimeout(() => document.addEventListener('click', dismissHandler), 10);
      } else {
        popover.setAttribute('hidden', '');
        popover.hidden = true;
        popover.style.display = 'none';
      }
    }

    async function handleCustomerLogout() {
      const popoverMobile = document.getElementById('accountMenuPopover');
      if (popoverMobile) { popoverMobile.setAttribute('hidden', ''); popoverMobile.hidden = true; popoverMobile.style.display = 'none'; }
      const popoverPc = document.getElementById('accountMenuPopoverPc');
      if (popoverPc) { popoverPc.setAttribute('hidden', ''); popoverPc.hidden = true; popoverPc.style.display = 'none'; }

      if (activeToken) {
        try {
          await fetch(`${API_BASE}/api/v1/customer/logout`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${activeToken}` }
          });
        } catch { }
      }

      clearPreservedIdentity();
      activeCustomer = null;
      activeToken = null;
      hasAttemptedAutoLogin = false;
      updateCustomerDisplay(null);
      setGatewayAuthMode(true);
      goToAuthStep('mobile');
      renderSavedAccountsUI();
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
    }

    let currentSelectedMethod = 'UPI';

    function hideAllContent() {
      document.getElementById('viewUpiContent').hidden = true;
      const vCod = document.getElementById('viewCodContent');
      if (vCod) vCod.hidden = true;
      const vCash = document.getElementById('viewCashContent');
      if (vCash) vCash.hidden = true;
      const vCard = document.getElementById('viewCardContent');
      if (vCard) vCard.hidden = true;
      document.getElementById('viewProcessingContent').hidden = true;
      document.getElementById('viewSuccessContent').hidden = true;
      document.getElementById('viewFailedContent').hidden = true;
      document.getElementById('viewQueuedContent').hidden = true;
      const vBlocked = document.getElementById('viewBlockedContent');
      if (vBlocked) vBlocked.hidden = true;
      const vDup = document.getElementById('viewDuplicateSessionContent');
      if (vDup) vDup.hidden = true;
    }

    function formatTime(totalSec) {
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    let _activeCountdownTargetTime = null;

    function runCountdown(seconds, onTick, onDone, targetExpiresAt) {
      const targetTime = targetExpiresAt
        ? new Date(targetExpiresAt).getTime()
        : (_activeCountdownTargetTime || (Date.now() + (seconds || 300) * 1000));

      if (countdownTimer && _activeCountdownTargetTime && Math.abs(_activeCountdownTargetTime - targetTime) <= 2500) {
        return;
      }

      _activeCountdownTargetTime = targetTime;
      if (countdownTimer) clearInterval(countdownTimer);

      const calcRemaining = () => {
        return Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
      };

      const doTick = (sec) => {
        onTick(sec);
        const tStr = formatTime(sec);
        document.querySelectorAll('.ypg-banner-running-timer').forEach(el => {
          el.textContent = tStr;
        });
      };
      doTick(calcRemaining());

      countdownTimer = setInterval(() => {
        const remaining = calcRemaining();
        if (remaining <= 0) {
          clearInterval(countdownTimer);
          countdownTimer = null;
          _activeCountdownTargetTime = null;
          doTick(0);
          if (onDone) onDone();
        } else {
          doTick(remaining);
        }
      }, 1000);
    }

    function renderMethodSelectorBar(data) {
      const bar = document.getElementById('paymentMethodSelectorBar');
      const sellingMode = data.sellingMode || 'ONLINE';
      const enabledMethods = data.enabledMethods || ['UPI'];

      // Populate authenticated customer into COD view
      const c = data.customer || activeCustomer;
      if (c) {
        const nameEl = document.getElementById('codCustomerName');
        const phoneEl = document.getElementById('codCustomerPhone');
        if (nameEl) nameEl.textContent = c.fullName || c.name || 'Customer';
        if (phoneEl) phoneEl.textContent = c.phoneNumber || c.mobileNumber || '-';
      }

      // Maintain authentic 3-column desktop layout
      const pcMethodsList = document.getElementById('pcMethodsList');
      const pcActiveView = document.querySelector('.ypg-pc-active-view');
      const pcTopbarTitle = document.querySelector('.ypg-pc-topbar-title');

      if (pcMethodsList) pcMethodsList.style.removeProperty('display');
      if (pcActiveView) pcActiveView.style.width = '';
      if (pcTopbarTitle) pcTopbarTitle.textContent = 'Payment Options';

      // Mobile selector bar is visible only when more than 1 method is available
      if (bar) {
        bar.style.display = (!enabledMethods || enabledMethods.length <= 1) ? 'none' : 'flex';
      }

      const tabUpi = document.getElementById('tabMethodUpi');
      const tabCod = document.getElementById('tabMethodCod');
      const tabCash = document.getElementById('tabMethodCash');
      const tabCard = document.getElementById('tabMethodCard');

      if (tabUpi) tabUpi.style.display = 'inline-flex';

      const pcUpi = document.getElementById('pcMethodCardUpi');
      const pcCod = document.getElementById('pcMethodCardCod');
      const pcCash = document.getElementById('pcMethodCardCash');
      const pcCard = document.getElementById('pcMethodCardCard');

      if (pcUpi) pcUpi.style.display = 'block';

      if (sellingMode === 'ONLINE') {
        // Online Selling Mode:
        // COD works (configurable ON/OFF).
        // Cash on counter and Card on counter do NOT exist (hidden).
        if (tabCod) tabCod.style.display = enabledMethods.includes('COD') ? 'inline-flex' : 'none';
        if (tabCash) tabCash.style.display = 'none';
        if (tabCard) tabCard.style.display = 'none';

        if (pcCod) pcCod.style.display = enabledMethods.includes('COD') ? 'block' : 'none';
        if (pcCash) pcCash.style.display = 'none';
        if (pcCard) pcCard.style.display = 'none';
      } else {
        // Offline Selling Mode:
        // Cash works (configurable ON/OFF).
        // Card works (configurable ON/OFF).
        // COD does NOT exist (hidden).
        if (tabCod) tabCod.style.display = 'none';
        if (tabCash) tabCash.style.display = enabledMethods.includes('CASH_COUNTER') ? 'inline-flex' : 'none';
        if (tabCard) tabCard.style.display = enabledMethods.includes('CARD_COUNTER') ? 'inline-flex' : 'none';

        if (pcCod) pcCod.style.display = 'none';
        if (pcCash) pcCash.style.display = enabledMethods.includes('CASH_COUNTER') ? 'block' : 'none';
        if (pcCard) pcCard.style.display = enabledMethods.includes('CARD_COUNTER') ? 'block' : 'none';
      }

      if (!enabledMethods.includes(currentSelectedMethod)) {
        currentSelectedMethod = 'UPI';
      }
      updateMethodTabsUI(currentSelectedMethod);
    }

    function updateMethodTabsUI(method) {
      const tabs = [
        { id: 'tabMethodUpi', method: 'UPI' },
        { id: 'tabMethodCod', method: 'COD' },
        { id: 'tabMethodCash', method: 'CASH_COUNTER' },
        { id: 'tabMethodCard', method: 'CARD_COUNTER' }
      ];
      tabs.forEach(t => {
        const el = document.getElementById(t.id);
        if (!el) return;
        if (t.method === method) {
          el.classList.add('active');
        } else {
          el.classList.remove('active');
        }
      });

      const pcCards = [
        { id: 'pcMethodCardUpi', method: 'UPI' },
        { id: 'pcMethodCardCod', method: 'COD' },
        { id: 'pcMethodCardCash', method: 'CASH_COUNTER' },
        { id: 'pcMethodCardCard', method: 'CARD_COUNTER' }
      ];
      pcCards.forEach(c => {
        const el = document.getElementById(c.id);
        if (!el) return;
        if (c.method === method) {
          el.classList.add('is-active');
        } else {
          el.classList.remove('is-active');
        }
      });
    }

    function switchMethodFromDowntime() {
      const enabled = state?.enabledMethods || state?.branding?.enabledPaymentMethods || [];
      const sellingMode = state?.sellingMode || state?.branding?.sellingMode || 'OFFLINE';
      if (sellingMode === 'ONLINE' && enabled.includes('COD')) {
        selectPaymentMethod('COD');
      } else if (enabled.includes('CASH_COUNTER')) {
        selectPaymentMethod('CASH_COUNTER');
      }
    }

    async function selectPaymentMethod(method) {
      currentSelectedMethod = method;
      updateMethodTabsUI(method);
      hideAllContent();

      if (method === 'UPI') {
        document.getElementById('viewUpiContent').hidden = false;
        document.getElementById('ypgStickyFooter').style.display = 'flex';
      } else if (method === 'COD') {
        const vCod = document.getElementById('viewCodContent');
        if (vCod) vCod.hidden = false;
        document.getElementById('ypgStickyFooter').style.display = 'none';
      } else if (method === 'CASH_COUNTER') {
        const vCash = document.getElementById('viewCashContent');
        if (vCash) vCash.hidden = false;
        document.getElementById('ypgStickyFooter').style.display = 'none';
      } else if (method === 'CARD_COUNTER') {
        const vCard = document.getElementById('viewCardContent');
        if (vCard) vCard.hidden = false;
        document.getElementById('ypgStickyFooter').style.display = 'none';
      }

      try {
        const res = await fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/select-method`, {
          method: 'POST',
          headers: getApiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ method, deviceId: DeviceIdentity?.currentDeviceId })
        });
        const resData = await res.json();
        if (res.ok && resData) {
          state.method = method;
          if (resData.timeRemainingSeconds !== undefined) {
            state.timeRemainingSeconds = resData.timeRemainingSeconds;
          }
          if (resData.status) {
            state.status = resData.status;
          }

          if (method === 'COD') {
            runCountdown(resData.timeRemainingSeconds || 300, sec => {
              const el = document.getElementById('codTimerText');
              if (el) el.textContent = formatTime(sec);
            }, () => {
              const el = document.getElementById('codTimerText');
              if (el) el.textContent = 'Expired';
              fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/expire`, { method: 'POST' }).catch(() => { });
              loadState();
            });
          } else if (method === 'UPI') {
            if (resData.status === 'ACTIVE') {
              loadQrSvg();
              runCountdown(resData.timeRemainingSeconds || 300, sec => {
                const el = document.getElementById('activeTimerText');
                if (el) el.textContent = formatTime(sec);
              }, () => {
                const el = document.getElementById('activeTimerText');
                if (el) el.textContent = 'Expired';
                fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/expire`, { method: 'POST' }).catch(() => { });
                loadState();
              });
            } else if (resData.status === 'QUEUED') {
              loadState();
            }
          } else {
            // Offline Counter mode: no timer countdown
            if (countdownTimer) clearInterval(countdownTimer);
          }
        }
      } catch (e) {
        console.warn('selectPaymentMethod network error:', e);
      }
    }

    function renderCodButton(btn, amount) {
      if (!btn) return;
      btn.disabled = false;
      btn.textContent = '';
      const span = document.createElement('span');
      span.textContent = 'Confirm & Place COD Order (₹' + (amount || '0.00') + ')';
      btn.appendChild(span);
      btn.appendChild(document.createTextNode(' \u203A'));
    }

    async function promptConfirmCodOrder() {
      const amt = state?.amount || '0.00';
      if (!confirm(`Are you sure you want to confirm and place this Cash on Delivery (COD) order for ₹${amt}? You will pay in cash upon doorstep delivery.`)) {
        return;
      }
      await executeConfirmCodOrder();
    }

    async function executeConfirmCodOrder() {
      const btn = document.getElementById('btnConfirmCod');
      if (btn) {
        btn.disabled = true;
        btn.innerText = 'Placing Cash on Delivery Order...';
      }

      try {
        const res = await fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/confirm-cod`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (res.ok) {
          loadState();
        } else {
          alert(data.error || 'Failed to place COD order');
          renderCodButton(btn, state?.amount);
        }
      } catch (e) {
        alert('Network error confirming COD order.');
        renderCodButton(btn, state?.amount);
      }
    }

    // --- DEVICE IDENTITY & HARDWARE CONTEXT BINDING LAYER ---
    const DeviceIdentity = {
      dbName: 'youpi_device_keystore_v1',
      storeName: 'keys',
      currentDeviceId: null,
      currentDeviceToken: null,

      async openDb() {
        return new Promise((resolve) => {
          if (!window.indexedDB) {
            resolve(null);
            return;
          }
          const req = window.indexedDB.open(this.dbName, 1);
          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(this.storeName)) {
              db.createObjectStore(this.storeName, { keyPath: 'id' });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        });
      },

      async getStoredRecord() {
        try {
          const db = await this.openDb();
          if (!db) return null;
          return new Promise((resolve) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const req = store.get('primary_device');
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
          });
        } catch {
          return null;
        }
      },

      async saveRecord(record) {
        try {
          const db = await this.openDb();
          if (!db) return;
          return new Promise((resolve) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            store.put({ id: 'primary_device', ...record });
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
          });
        } catch {}
      },

      collectSignals() {
        let canvasSig = '';
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 120;
          canvas.height = 30;
          const ctx = canvas.getContext('2d');
          ctx.textBaseline = 'top';
          ctx.font = "14px 'Arial'";
          ctx.fillText('YouPI-PG-Device-Binding-2026', 2, 2);
          canvasSig = canvas.toDataURL().slice(-32);
        } catch {}

        let webglRenderer = '';
        try {
          const gl = document.createElement('canvas').getContext('webgl');
          if (gl) {
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            if (dbg) webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
          }
        } catch {}

        return {
          userAgent: navigator.userAgent || '',
          platform: navigator.platform || '',
          language: navigator.language || '',
          timezone: (Intl && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
          screenSignature: `${window.screen?.width || 0}x${window.screen?.height || 0}x${window.screen?.colorDepth || 24}`,
          hardwareConcurrency: navigator.hardwareConcurrency || 0,
          deviceMemory: navigator.deviceMemory || 0,
          webglRenderer,
          canvasSignature: canvasSig
        };
      },

      async getOrRegister() {
        if (this.currentDeviceId) {
          return { deviceId: this.currentDeviceId, deviceToken: this.currentDeviceToken };
        }

        // 1. Check local storage / session cache first
        let cachedId = localStorage.getItem('ypg_device_id');
        let cachedToken = localStorage.getItem('ypg_device_token');

        // 2. Check IndexedDB persistent store
        const stored = await this.getStoredRecord();
        if (stored?.deviceId) {
          this.currentDeviceId = stored.deviceId;
          this.currentDeviceToken = stored.deviceToken;
          localStorage.setItem('ypg_device_id', stored.deviceId);
          if (stored.deviceToken) localStorage.setItem('ypg_device_token', stored.deviceToken);
          return { deviceId: stored.deviceId, deviceToken: stored.deviceToken };
        }

        if (cachedId) {
          this.currentDeviceId = cachedId;
          this.currentDeviceToken = cachedToken;
          return { deviceId: cachedId, deviceToken: cachedToken };
        }

        // 3. Generate new Web Crypto key pair
        let publicKeyBase64 = '';
        try {
          if (window.crypto && window.crypto.subtle) {
            const keyPair = await window.crypto.subtle.generateKey(
              { name: 'ECDSA', namedCurve: 'P-256' },
              true,
              ['sign', 'verify']
            );
            const spki = await window.crypto.subtle.exportKey('spki', keyPair.publicKey);
            const bytes = new Uint8Array(spki);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            publicKeyBase64 = btoa(binary);
          }
        } catch (e) {
          console.warn('[DeviceIdentity] Web Crypto keygen fallback:', e.message);
        }

        if (!publicKeyBase64) {
          publicKeyBase64 = btoa(`fallback-device-key-${Math.random()}-${Date.now()}`);
        }

        // 4. Register with YouPI backend
        const signals = this.collectSignals();
        try {
          const resp = await fetch(`${API_BASE}/api/v1/devices/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ publicKey: publicKeyBase64, signals })
          });
          const data = await resp.json();
          if (data?.deviceId) {
            this.currentDeviceId = data.deviceId;
            this.currentDeviceToken = data.deviceToken;
            localStorage.setItem('ypg_device_id', data.deviceId);
            if (data.deviceToken) localStorage.setItem('ypg_device_token', data.deviceToken);

            await this.saveRecord({
              deviceId: data.deviceId,
              deviceToken: data.deviceToken,
              publicKeyBase64,
              registeredAt: new Date().toISOString()
            });

            return { deviceId: data.deviceId, deviceToken: data.deviceToken };
          }
        } catch (err) {
          console.error('[DeviceIdentity] Registration error:', err);
        }

        return { deviceId: null, deviceToken: null };
      }
    };

    function getApiHeaders(customHeaders = {}) {
      const headers = { ...customHeaders };
      if (typeof DeviceIdentity !== 'undefined' && DeviceIdentity?.currentDeviceId) {
        headers['X-Device-Id'] = DeviceIdentity.currentDeviceId;
      }
      if (typeof DeviceIdentity !== 'undefined' && DeviceIdentity?.currentDeviceToken) {
        headers['X-Device-Token'] = DeviceIdentity.currentDeviceToken;
      }
      const token = activeToken || (getPreservedIdentity()?.token) || getStoredCustomerToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
        headers['x-customer-token'] = token;
      }
      return headers;
    }

    async function loadState() {
      try {
        await DeviceIdentity.getOrRegister();
        const headers = getApiHeaders();

        const res = await fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/state`, { headers });
        const data = await res.json().catch(() => ({}));

        if (res.status === 409 || data.error === 'DUPLICATE_SESSION_DETECTED') {
          renderDuplicateSession(data);
          dismissSplashScreen();
          return;
        }

        if (!res.ok) {
          dismissSplashScreen();
          return;
        }

        renderState(data);
        dismissSplashScreen();
      } catch (e) {
        console.warn('loadState error:', e);
        dismissSplashScreen();
      }
    }

    function adjustHexColor(col, amt) {
      if (!col) return '#0957cb';
      try {
        let usePound = false;
        if (col[0] === '#') {
          col = col.slice(1);
          usePound = true;
        }
        if (col.length === 3) col = col[0] + col[0] + col[1] + col[1] + col[2] + col[2];
        const num = parseInt(col, 16);
        let r = (num >> 16) + amt;
        if (r > 255) r = 255; else if (r < 0) r = 0;
        let b = ((num >> 8) & 0x00FF) + amt;
        if (b > 255) b = 255; else if (b < 0) b = 0;
        let g = (num & 0x0000FF) + amt;
        if (g > 255) g = 255; else if (g < 0) g = 0;
        return (usePound ? '#' : '') + (g | (b << 8) | (r << 16)).toString(16).padStart(6, '0');
      } catch {
        return col;
      }
    }

    function applyDynamicTheme(branding) {
      if (!branding) return;
      const primary = branding.primaryColor || '#0b63e5';
      const darkPrimary = adjustHexColor(primary, -25);
      const root = document.documentElement;

      root.style.setProperty('--ypg-blue', primary);
      root.style.setProperty('--ypg-blue-dark', darkPrimary);

      const theme = branding.headerTheme || 'gradient';
      const headerEl = document.querySelector('.ypg-header');
      const sidebarEl = document.querySelector('.ypg-pc-sidebar');

      if (theme === 'solid') {
        root.style.setProperty('--ypg-header-gradient', primary);
        if (headerEl) headerEl.style.background = primary;
        if (sidebarEl) sidebarEl.style.background = primary;
      } else if (theme === 'dark') {
        root.style.setProperty('--ypg-header-gradient', '#0b1329');
        if (headerEl) headerEl.style.background = '#0b1329';
        if (sidebarEl) sidebarEl.style.background = 'linear-gradient(180deg, #0b1329 0%, #030712 100%)';
      } else {
        const grad = `linear-gradient(180deg, ${primary} 0%, ${darkPrimary} 100%)`;
        root.style.setProperty('--ypg-header-gradient', grad);
        if (headerEl) headerEl.style.background = grad;
        if (sidebarEl) sidebarEl.style.background = grad;
      }
    }

    function renderHelpLegalLinks(branding) {
      const container = document.getElementById('helpModalLegalLinks');
      if (!container) return;
      let html = '';
      if (branding.privacyPolicyUrl) {
        html += `<a href="${branding.privacyPolicyUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--ypg-blue); text-decoration:underline; font-weight:600;">Privacy Policy &nearr;</a>`;
      }
      if (branding.termsUrl) {
        html += `<a href="${branding.termsUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--ypg-blue); text-decoration:underline; font-weight:600;">Terms of Service &nearr;</a>`;
      }
      container.innerHTML = html;
      container.style.display = html ? 'flex' : 'none';
    }

    function renderState(data) {
      state = data;
      const b = data.branding || {};
      const appName = (b.appName && b.appName !== 'YOUPI PG') ? b.appName : 'Mitto Pay';
      const merchantName = (data.merchantName && data.merchantName !== 'YOUPI Demo Store' && data.merchantName !== 'Merchant Checkout') ? data.merchantName : 'V-Visa Business';

      // 1. Dynamic Title
      document.title = `${merchantName} · ${appName} Checkout`;

      // 2. Dynamic Colors & Header Theme
      applyDynamicTheme(b);

      // 3. Merchant Name & Avatar
      if (data.merchantName) {
        const nameEl = document.getElementById('headerMerchantName');
        if (nameEl) nameEl.textContent = data.merchantName;
        const letterEl = document.getElementById('merchantAvatarLetter');
        if (letterEl) letterEl.textContent = data.merchantName.charAt(0).toUpperCase();
      }

      // 4. Verified Trust Badge
      const trustBadgeEl = document.getElementById('headerTrustBadge');
      const trustBadgeTextEl = document.getElementById('headerTrustBadgeText');
      if (trustBadgeEl) {
        if (b.hideTrustBadge) {
          trustBadgeEl.style.display = 'none';
        } else {
          trustBadgeEl.style.display = 'inline-flex';
          if (trustBadgeTextEl) {
            trustBadgeTextEl.textContent = b.trustBadgeText || `Verified Business · Powered by ${appName}`;
          }
        }
      }

      // 5. Header Sub-banner
      const subbannerEl = document.getElementById('headerSubbanner');
      const subbannerTextEl = document.getElementById('subbannerText');
      if (subbannerEl) {
        if (b.hideSubbanner) {
          subbannerEl.style.display = 'none';
        } else {
          subbannerEl.style.display = 'flex';
          if (subbannerTextEl) {
            subbannerTextEl.textContent = b.subbannerText || b.sidebarNotice || `Secured by ${appName} · 256-Bit Bank Encryption`;
          }
        }
      }

      // 6. Time-Saving Conversion Banner
      if (b.hideTimeSavingBanner) {
        document.querySelectorAll('.ypg-time-saving-banner').forEach(el => el.style.setProperty('display', 'none', 'important'));
      }


      // Update PC Sidebar Details & Whitelabeling
      const pcMerchant = document.getElementById('pcMerchantName');
      if (pcMerchant) pcMerchant.textContent = data.merchantName || 'Merchant Name';
      const pcPrice = document.getElementById('pcPriceSummaryAmount');
      if (pcPrice && data.amount) pcPrice.textContent = `₹${data.amount}`;
      const pcAppBrand = document.getElementById('pcAppNameBrand');
      if (pcAppBrand) pcAppBrand.textContent = appName;

      // PC Avatar Logo Whitelabel
      const pcLogoImg = document.getElementById('pcMerchantAvatarImg');
      const pcLetterSpan = document.getElementById('pcMerchantAvatarLetter');
      if (b.logoUrl) {
        if (pcLogoImg) {
          pcLogoImg.src = b.logoUrl;
          pcLogoImg.style.display = 'block';
        }
        if (pcLetterSpan) pcLetterSpan.style.display = 'none';
      } else {
        if (pcLogoImg) pcLogoImg.style.display = 'none';
        if (pcLetterSpan) {
          pcLetterSpan.style.display = 'block';
          pcLetterSpan.textContent = (data.merchantName || 'M').charAt(0).toUpperCase();
        }
      }

      // PC Trust Badge Whitelabel
      const pcTrust = document.getElementById('pcTrustBadge');
      const pcTrustText = document.getElementById('pcTrustBadgeText');
      if (pcTrust) {
        if (b.hideTrustBadge) {
          pcTrust.style.display = 'none';
        } else {
          pcTrust.style.display = 'inline-flex';
          if (pcTrustText) {
            pcTrustText.textContent = b.trustBadgeText || `Verified Business · Powered by ${appName}`;
          }
        }
      }

      // PC Social Proof / Subbanner Whitelabel
      const pcSocialWrap = document.getElementById('pcSocialProofWrap');
      const pcSocialProof = document.getElementById('pcSocialProofText');
      if (pcSocialWrap) {
        if (b.hideSubbanner) {
          pcSocialWrap.style.display = 'none';
        } else {
          pcSocialWrap.style.display = 'flex';
          if (pcSocialProof) {
            pcSocialProof.textContent = b.subbannerText || b.sidebarNotice || `Secured by ${appName} · 256-Bit Bank Encryption`;
          }
        }
      }

      const pcCustomerText = document.getElementById('pcCustomerProfileText');
      if (pcCustomerText) {
        const c = data.customer || activeCustomer || (typeof getPreservedIdentity === 'function' ? getPreservedIdentity()?.customer : null);
        if (c) {
          const name = c.fullName || c.name || c.customerName || '';
          const mobile = c.mobileNumber || c.phoneNumber || '';
          const clean = mobile ? String(mobile).replace(/^\+91/, '').replace(/\D/g, '').slice(-10) : '';
          if (name && clean) {
            pcCustomerText.textContent = `Using as ${name} (+91 ${clean})`;
          } else if (name) {
            pcCustomerText.textContent = `Using as ${name}`;
          } else if (clean) {
            pcCustomerText.textContent = `Using as +91 ${clean}`;
          } else if (c.email) {
            pcCustomerText.textContent = `Using as ${c.email}`;
          } else {
            pcCustomerText.textContent = 'Using as Guest User';
          }
        } else {
          pcCustomerText.textContent = 'Using as Guest User';
        }
      }
      document.querySelectorAll('.cancelMerchantNameSpan').forEach(el => {
        el.textContent = data.merchantName || 'Merchant';
      });

      // Update UPI Server Health Indicator (3-Tier Model: Green, Yellow, Red)
      const serverIndicator = data.upiServerIndicator || { status: 'WORKING', tier: 'GREEN', label: 'Server Is Working', isWorking: true };
      const healthPill = document.getElementById('upiServerHealthIndicator');
      const healthLabel = document.getElementById('serverStatusLabel');
      const downtimeAlert = document.getElementById('serverDowntimeAlert');
      const downtimeHeading = document.querySelector('#serverDowntimeAlert .ypg-downtime-heading');
      const downtimeMsg = document.getElementById('serverDowntimeMsg');
      const btnCashAlt = document.getElementById('btnDowntimeCashAlt');

      const tier = serverIndicator.tier || (serverIndicator.status === 'WORKING' ? 'GREEN' : (serverIndicator.status === 'BUSY' ? 'YELLOW' : 'RED'));

      if (healthPill) {
        if (tier === 'GREEN') {
          healthPill.className = 'ypg-server-health-indicator is-working';
        } else if (tier === 'YELLOW') {
          healthPill.className = 'ypg-server-health-indicator is-busy';
        } else {
          healthPill.className = 'ypg-server-health-indicator is-issues';
        }
      }
      if (healthLabel) {
        healthLabel.textContent = serverIndicator.label || (tier === 'GREEN' ? 'Server Is Working' : (tier === 'YELLOW' ? 'UPI Server Busy' : 'Server Facing Issues'));
      }
      if (downtimeAlert) {
        if (tier === 'GREEN') {
          downtimeAlert.style.display = 'none';
        } else if (tier === 'YELLOW') {
          downtimeAlert.style.display = 'flex';
          downtimeAlert.className = 'ypg-downtime-alert is-warning';
          if (downtimeHeading) downtimeHeading.textContent = 'UPI Server Busy';
          if (downtimeMsg) {
            downtimeMsg.textContent = serverIndicator.warning || 'Your payment may go through extra processing seconds.';
          }
          if (btnCashAlt) {
            btnCashAlt.style.display = (serverIndicator.recommendedAlternative === 'CASH') ? 'inline-block' : 'none';
          }
        } else {
          // RED
          downtimeAlert.style.display = 'flex';
          downtimeAlert.className = 'ypg-downtime-alert';
          if (downtimeHeading) downtimeHeading.textContent = 'UPI Server Facing Issues';
          if (downtimeMsg) {
            downtimeMsg.textContent = serverIndicator.warning || 'It is not recommended to pay by UPI right now as the server is facing downtime. We recommend paying by cash instead.';
          }
          if (btnCashAlt) {
            btnCashAlt.style.display = (serverIndicator.recommendedAlternative === 'CASH') ? 'inline-block' : 'none';
          }
        }
      }

      // CRITICAL INVARIANT: In all 3 states (Green, Yellow, Red), ALWAYS display the dynamic UPI QR code
      const upiCardContainer = document.querySelector('.ypg-qr-card-container');
      if (upiCardContainer) upiCardContainer.style.display = 'flex';
      const qrContainerBox = document.getElementById('qrImageContainer');
      if (qrContainerBox && (!qrContainerBox.querySelector('svg') || qrContainerBox.textContent.includes('Loading QR'))) {
        loadQrSvg();
      }

      // 7. Amount & Order IDs
      if (data.amount) {
        const formatted = `₹${data.amount}`;
        const bAmt = document.getElementById('bottomAmountDisplay');
        if (bAmt) bAmt.textContent = formatted;
        const dAmt = document.getElementById('drawerTotalAmount');
        if (dAmt) dAmt.textContent = formatted;
        const sAmt = document.getElementById('successAmountVal');
        if (sAmt) sAmt.textContent = formatted;
      }
      if (data.orderId || data.id) {
        const oId = data.orderId || data.id;
        const dOrder = document.getElementById('drawerOrderId');
        if (dOrder) dOrder.textContent = oId;
        const formattedOId = String(oId).startsWith('#') ? oId : `#${oId}`;
        document.querySelectorAll('.cashierOrderIdDisplay').forEach(el => {
          el.textContent = formattedOId;
        });
      }
      // Note: Payee VPA / UPI ID is strictly hidden from customer view in all screens

      // 8. In-Store Offline Counter Instructions
      const cashNoticeEl = document.getElementById('cashCounterDeskNotice');
      if (cashNoticeEl && b.counterInstructions) {
        cashNoticeEl.textContent = b.counterInstructions;
      }
      const cardNoticeEl = document.getElementById('cardCounterDeskNotice');
      if (cardNoticeEl && b.cardCounterInstructions) {
        cardNoticeEl.textContent = b.cardCounterInstructions;
      }

      // 9. Dynamic Logo
      const logoImg = document.getElementById('merchantAvatarImg');
      const letterSpan = document.getElementById('merchantAvatarLetter');
      if (b.logoUrl) {
        if (logoImg) {
          logoImg.src = b.logoUrl;
          logoImg.style.display = 'block';
        }
        if (letterSpan) letterSpan.style.display = 'none';
      } else {
        if (logoImg) logoImg.style.display = 'none';
        if (letterSpan) letterSpan.style.display = 'block';
      }

      // 10. Splash Screen Branding
      const splashLogo = document.getElementById('splashBrandLogo');
      const splashDefaultShield = document.getElementById('splashDefaultShield');
      const splashSecuredText = document.getElementById('splashSecuredByText');
      if (b.logoUrl && splashLogo) {
        splashLogo.src = b.logoUrl;
        splashLogo.style.display = 'block';
        if (splashDefaultShield) splashDefaultShield.style.display = 'none';
      }
      if (splashSecuredText) {
        splashSecuredText.textContent = b.hidePoweredBy ? (b.appName || '256-Bit Bank Encryption') : (b.appName || 'Mitto Pay');
      }

      // 12. Legal Disclaimer Strip
      const legalDisclaimerEl = document.getElementById('footerLegalDisclaimer');
      if (legalDisclaimerEl) {
        if (b.hidePoweredBy) {
          legalDisclaimerEl.innerHTML = `Secured by 256-Bit Bank Encryption &bull; <span style="text-decoration:underline; cursor:pointer;" onclick="openHelpModal()">Privacy &amp; Terms</span>`;
        } else {
          legalDisclaimerEl.innerHTML = `Secured by ${appName} &amp; 256-Bit Bank Encryption &bull; <span style="text-decoration:underline; cursor:pointer;" onclick="openHelpModal()">Privacy Notice</span>`;
        }
      }

      // 13. Success Screen Description
      const successDesc = document.getElementById('successDescText');
      if (successDesc) {
        successDesc.textContent = 'Your payment was automatically verified.';
      }

      // 14. Help Modal Title & Legal Links
      const helpTitle = document.getElementById('helpModalTitle');
      if (helpTitle) helpTitle.textContent = `${merchantName} Help & Support`;
      renderHelpLegalLinks(b);

      // 1. Conflict detection: single active payment session invariant
      const conflictModal = document.getElementById('activeConflictModal');
      if (data.hasActiveSessionConflict) {
        hideAllContent();
        if (conflictModal) conflictModal.hidden = false;
        if (data.conflictingSession && data.conflictingSession.id) {
          activeConflictSessionId = data.conflictingSession.id;
          const desc = document.getElementById('conflictModalDesc');
          if (desc) {
            desc.textContent = `You already have an active payment session (#${data.conflictingSession.orderId || data.conflictingSession.id.slice(0, 8)}) for ₹${data.conflictingSession.amount}. For security, only one active payment session is allowed per customer.`;
          }
        }
        if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null; }
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        return;
      } else {
        if (conflictModal) conflictModal.hidden = true;
      }

      // --- 2. TERMINAL PAYMENT STATES (TERMINAL & OVER) ---
      if (['SUCCESS', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(data.status)) {
        if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null; }
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        setGatewayAuthMode(false);

        if (data.status === 'CANCELLED') {
          emitTriggerHook('CANCEL_CONFIRMED');
          closeProcessingModal();
          closeCancelPaymentModal();
          const bar = document.getElementById('paymentMethodSelectorBar');
          if (bar) bar.style.display = 'none';

          hideAllContent();
          const failedView = document.getElementById('viewFailedContent');
          if (failedView) failedView.hidden = false;
          const footer = document.getElementById('ypgStickyFooter');
          if (footer) footer.style.display = 'none';

          const titleEl = document.getElementById('failedTitleText');
          if (titleEl) titleEl.textContent = 'Payment Cancelled';
          const descEl = document.getElementById('failedDescriptionText');
          if (descEl) descEl.textContent = 'You cancelled this payment session. Click below to return to the store.';

          const btnAction = document.getElementById('btnFailedAction');
          if (btnAction) {
            btnAction.textContent = 'Back to Store';
            btnAction.onclick = () => {
              const storeUrl = getStoreReturnUrl();
              const isEmbedded = (window.parent && window.parent !== window) || location.search.includes('embedded=1');
              if (isEmbedded) {
                try {
                  postToMerchant({ event: 'youpi.modal_close', redirectUrl: storeUrl });
                  postToMerchant({ event: 'youpi.close', redirectUrl: storeUrl });
                  postToMerchant({ event: 'youpi.cancel', redirectUrl: storeUrl });
                  postToMerchant({ event: 'youpi.payment_cancelled', redirectUrl: storeUrl });
                } catch (e) {}
              } else {
                const safeStoreUrl = sanitizeRedirectUrl(storeUrl);
                if (safeStoreUrl) {
                  window.location.href = safeStoreUrl;
                } else {
                  window.history.back();
                }
              }
            };
          }
          return;
        }

        if (data.status === 'FAILED' || data.status === 'EXPIRED') {
          closeProcessingModal();
          closeCancelPaymentModal();
          const bar = document.getElementById('paymentMethodSelectorBar');
          if (bar) bar.style.display = 'none';

          hideAllContent();
          const failedView = document.getElementById('viewFailedContent');
          if (failedView) failedView.hidden = false;
          const footer = document.getElementById('ypgStickyFooter');
          if (footer) footer.style.display = 'none';
          emitTriggerHook('PAYMENT_FAILED', { status: data.status });

          const isExpired = data.status === 'EXPIRED';
          const titleEl = document.getElementById('failedTitleText');
          if (titleEl) titleEl.textContent = isExpired ? 'Payment Session Expired' : 'Payment Not Confirmed';
          const descEl = document.getElementById('failedDescriptionText');
          if (descEl) {
            descEl.textContent = isExpired
              ? 'The 5-minute active payment window elapsed before verification was completed. For security, please return to the store and initiate a new order.'
              : 'No matching UPI bank confirmation was detected during the verification window.';
          }
          const btnAction = document.getElementById('btnFailedAction');
          if (btnAction) {
            btnAction.textContent = isExpired ? 'Start New Payment' : 'Try Again';
            btnAction.onclick = () => handleRetryNewPayment();
          }
          return;
        }

        if (data.status === 'SUCCESS') {
          closeProcessingModal();
          closeCancelPaymentModal();
          const bar = document.getElementById('paymentMethodSelectorBar');
          if (bar) bar.style.display = 'none';

          hideAllContent();
          const successView = document.getElementById('viewSuccessContent');
          if (successView) successView.hidden = false;
          const footer = document.getElementById('ypgStickyFooter');
          if (footer) footer.style.display = 'none';
          const amtEl = document.getElementById('successAmountVal');
          if (amtEl) amtEl.textContent = `₹${data.amount}`;

          const isCodOrder = data.method === 'COD' || data.verificationTag === 'COD_ORDER_PLACED';
          const titleEl = document.getElementById('successTitleText');
          const descEl = document.getElementById('successDescText');
          const codApiBox = document.getElementById('successCodDevApiBox');
          const codApiUrl = document.getElementById('successCodDevApiUrl');

          if (isCodOrder) {
            if (titleEl) titleEl.textContent = 'Order Placed (Cash on Delivery)!';
            if (descEl) descEl.textContent = `Your order #${data.orderId} was confirmed. Please keep ₹${data.amount} in cash ready for the courier agent upon arrival.`;
            if (codApiBox && codApiUrl) {
              codApiBox.style.display = 'block';
              codApiUrl.textContent = `${API_BASE}/api/v1/orders/${data.orderId}/cod`;
            }
          } else {
            if (titleEl) titleEl.textContent = 'Payment Successful!';
            if (descEl) descEl.textContent = 'Your payment was automatically verified.';
            if (codApiBox) codApiBox.style.display = 'none';
          }

          emitTriggerHook('PAYMENT_COMPLETED', { amount: data.amount, method: data.method, isCod: isCodOrder });

          try {
            postToMerchant({
              event: 'youpi.payment_success',
              data: data
            });
          } catch (e) { }

          const effectiveReturnUrl = data.returnUrl || state?.returnUrl || null;
          const btnReturn = document.getElementById('btnReturnStore') || document.getElementById('btnReturnToStore');
          if (effectiveReturnUrl) {
            const safeReturn = sanitizeRedirectUrl(effectiveReturnUrl);
            if (safeReturn) {
              if (btnReturn) {
                btnReturn.hidden = false;
                btnReturn.href = safeReturn;
                btnReturn.textContent = 'Return to Store (Redirecting in 2s...)';
              }
              if (descEl && !descEl.textContent.includes('Redirecting')) {
                descEl.textContent += ' Redirecting to merchant store...';
              }
              if (window.parent === window) {
                setTimeout(() => { window.location.href = safeReturn; }, 2000);
              }
            } else if (btnReturn) {
              btnReturn.hidden = true;
            }
          } else if (btnReturn) {
            btnReturn.hidden = true;
          }
          return;
        }
      }

      // Sync payment methods & modality layout immediately to match merchant settings
      renderMethodSelectorBar(data);

      // Auto-bind customer to payment session helper
      if (typeof autoBindCustomerToSession !== 'function') {
        window.autoBindCustomerToSession = async function(customerId, token) {
          if (window.isAutoBindingSession || !PAYMENT_ID || !token || !customerId) return;
          window.isAutoBindingSession = true;
          try {
            const res = await fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/bind-customer`, {
              method: 'POST',
              headers: getApiHeaders({
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              }),
              body: JSON.stringify({ token, customerId })
            });
            if (res.ok) {
              const boundData = await res.json().catch(() => null);
              if (boundData && boundData.status && boundData.status !== 'INITIATED') {
                loadState();
              }
            } else if (res.status === 401) {
              clearPreservedIdentity();
              activeCustomer = null;
              activeToken = null;
              setGatewayAuthMode(true);
              goToAuthStep('mobile');
              renderSavedAccountsUI();
            }
          } catch (e) {
          } finally {
            window.isAutoBindingSession = false;
          }
        };
      }

      // 3. Pre-Gateway Customer Authentication Gate (Preserves identity up to 1 week)
      if (data.customer) {
        activeCustomer = data.customer;
      } else if (!activeCustomer) {
        const preserved = getPreservedIdentity();
        if (preserved && preserved.customer) {
          activeCustomer = preserved.customer;
          activeToken = preserved.token || activeToken;
        }
      }
      const hasCustomer = Boolean(data.customer || activeCustomer);

      if (!hasCustomer) {
        setGatewayAuthMode(true);
        const stepMob = document.getElementById('authStepMobile');
        const isAlreadyOnMobile = stepMob && !stepMob.hidden;
        if (!currentAuthStep || (currentAuthStep === 'mobile' && !isAlreadyOnMobile)) {
          goToAuthStep('mobile');
        }
        renderSavedAccountsUI();
        return;
      }

      // Authenticated Customer
      if (activeCustomer) {
        updateCustomerDisplay(activeCustomer);
        // Automatically bind customer to the payment session if session is INITIATED or unbound
        if (activeToken && PAYMENT_ID && (!data.customer || data.status === 'INITIATED')) {
          window.autoBindCustomerToSession(activeCustomer.id, activeToken);
        }
      }
      setGatewayAuthMode(false);

      // Render psychological time-saving conversion banner
      renderTimeSavingBanners(data);

      // 3. Status Handling: BLOCKED, QUEUED, ACTIVE, PROCESSING, SUCCESS, FAILED, EXPIRED
      if (data.status === 'BLOCKED' || data.isBanned || data.fraudDetected) {
        renderBlockedState(data);
        return;
      }

      if (data.status === 'QUEUED') {
        const bar = document.getElementById('paymentMethodSelectorBar');
        if (bar) bar.style.display = 'none';

        hideAllContent();
        document.getElementById('viewQueuedContent').hidden = false;
        document.getElementById('ypgStickyFooter').style.display = 'none';
        document.getElementById('queueNumberDisplay').textContent = `#${data.queuePosition || 1}`;
        runCountdown(data.timeRemainingSeconds, sec => {
          document.getElementById('queueTimerText').textContent = formatTime(sec);
        }, () => loadState());

        if (!queuePollTimer) {
          queuePollTimer = setInterval(() => { loadState(); }, 1200);
        }
        return;
      }

      if (queuePollTimer) {
        clearInterval(queuePollTimer);
        queuePollTimer = null;
      }

      if (data.status === 'ACTIVE' || (data.status === 'INITIATED' && (data.timeRemainingSeconds > 0 || data.expiresAt))) {
        renderMethodSelectorBar(data);

        hideAllContent();
        if (currentSelectedMethod === 'COD') {
          const vCod = document.getElementById('viewCodContent');
          if (vCod) vCod.hidden = false;
          document.getElementById('ypgStickyFooter').style.display = 'none';

          runCountdown(data.timeRemainingSeconds || 300, sec => {
            const el = document.getElementById('codTimerText');
            if (el) el.textContent = formatTime(sec);
          }, () => {
            const el = document.getElementById('codTimerText');
            if (el) el.textContent = 'Expired';
            fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/expire`, { method: 'POST' }).catch(() => { });
            loadState();
          }, data.expiresAt);
        } else if (currentSelectedMethod === 'CASH_COUNTER') {
          const vCash = document.getElementById('viewCashContent');
          if (vCash) vCash.hidden = false;
          document.getElementById('ypgStickyFooter').style.display = 'none';
        } else if (currentSelectedMethod === 'CARD_COUNTER') {
          const vCard = document.getElementById('viewCardContent');
          if (vCard) vCard.hidden = false;
          document.getElementById('ypgStickyFooter').style.display = 'none';
        } else {
          // Default: UPI QR (CRITICAL INVARIANT: ALWAYS SHOWS QR AND RUNS 5:00 TIMER REGARDLESS OF GREEN/YELLOW/RED)
          document.getElementById('viewUpiContent').hidden = false;
          document.getElementById('ypgStickyFooter').style.display = 'flex';
          loadQrSvg();

          const btnContinue = document.getElementById('btnContinuePayment');

          const remainingSec = (data.timeRemainingSeconds !== undefined && data.timeRemainingSeconds !== null) ? Number(data.timeRemainingSeconds) : 300;
          const targetExpiry = data.expiresAt || new Date(Date.now() + remainingSec * 1000).toISOString();

          if (remainingSec <= 0 && data.status === 'ACTIVE') {
            const tText = document.getElementById('activeTimerText');
            if (tText) tText.textContent = 'Expired';
            if (btnContinue) btnContinue.style.display = 'none';
            return;
          }

          // Initialize button hidden until 4:00 has elapsed
          if (btnContinue && remainingSec > 240) {
            btnContinue.style.display = 'none';
          } else if (btnContinue) {
            btnContinue.style.display = 'block';
          }

          runCountdown(remainingSec, sec => {
            const tText = document.getElementById('activeTimerText');
            if (tText) tText.textContent = formatTime(sec);

            // "Payment Done — Check My Payment" button appears after 4:00
            if (sec <= 240 && btnContinue) {
              btnContinue.style.display = 'block';
            } else if (btnContinue) {
              btnContinue.style.display = 'none';
            }
          }, () => {
            const tText = document.getElementById('activeTimerText');
            if (tText) tText.textContent = 'Expired';
            if (btnContinue) btnContinue.style.display = 'none';
            closeProcessingModal();
            fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/expire`, { method: 'POST' }).catch(() => { });
            loadState();
          }, targetExpiry);
        }
        return;
      }

      if (data.status === 'PROCESSING') {
        const bar = document.getElementById('paymentMethodSelectorBar');
        if (bar) bar.style.display = 'none';

        hideAllContent();
        document.getElementById('viewProcessingContent').hidden = false;
        document.getElementById('ypgStickyFooter').style.display = 'none';
        runCountdown(data.timeRemainingSeconds, sec => {
          document.getElementById('procTimerText').textContent = `${sec}s`;
        }, () => loadState(), data.expiresAt);
        return;
      }


    }

    // --- PSYCHOLOGICAL TIME-SAVING CONVERSION BANNER ---
    // Invariant: ONLY display when the customer is actively waiting in the UPI queue!
    function renderTimeSavingBanners(data) {
      const qBanner = document.getElementById('queueTimeSavingBanner');
      const uBanner = document.getElementById('upiTimeSavingBanner');
      if (uBanner) uBanner.style.display = 'none'; // NEVER show on active UPI session

      const isQueued = (data.status === 'QUEUED') || (Number(data.queuePosition || 0) > 0);
      if (!isQueued || !qBanner) {
        if (qBanner) qBanner.style.display = 'none';
        return;
      }

      const enabled = data.enabledMethods || ['UPI'];
      const sellingMode = data.sellingMode || 'OFFLINE';

      let altMethodCode = null;
      let altMethodName = null;

      if (sellingMode === 'ONLINE') {
        if (enabled.includes('COD')) {
          altMethodCode = 'COD';
          altMethodName = 'Cash on Delivery';
        } else if (enabled.includes('CARD')) {
          altMethodCode = 'CARD';
          altMethodName = 'Credit / Debit Card';
        } else if (enabled.includes('NETBANKING')) {
          altMethodCode = 'NETBANKING';
          altMethodName = 'Net Banking';
        } else if (enabled.includes('CARD_COUNTER')) {
          altMethodCode = 'CARD_COUNTER';
          altMethodName = 'Card Payment';
        }
      } else {
        // Offline selling mode (retail till / counter)
        if (enabled.includes('CASH_COUNTER')) {
          altMethodCode = 'CASH_COUNTER';
          altMethodName = 'Cash at Till';
        } else if (enabled.includes('CARD_COUNTER')) {
          altMethodCode = 'CARD_COUNTER';
          altMethodName = 'Card at Counter';
        }
      }

      // CRITICAL REQUIREMENT: If both cash and card are disabled by merchant, psychological conversion MUST NOT BE SHOWN!
      if (!altMethodCode || (!enabled.includes('COD') && !enabled.includes('CASH_COUNTER') && !enabled.includes('CARD') && !enabled.includes('CARD_COUNTER'))) {
        qBanner.style.display = 'none';
        return;
      }

      const timeSec = data.timeRemainingSeconds || (data.queuePosition ? data.queuePosition * 30 : 30);
      const initialTimerStr = formatTime(timeSec);

      const actionText = sellingMode === 'ONLINE'
        ? `Skip the UPI wait! Pay with <strong>${altMethodName}</strong> instantly without waiting for a UPI slot.`
        : `Don't wait in the UPI line! Pay with <strong>${altMethodName}</strong> right now to complete your purchase instantly.`;

      qBanner.innerHTML = `
        <div class="ypg-queue-conversion-card">
          <div class="ypg-queue-conversion-header">
            <div class="ypg-queue-conversion-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="display:inline-block; vertical-align:middle; margin-right:3px;"><path d="M12 2l2.4 7.2h7.6l-6 4.8 2.4 7.2-6.4-4.8-6.4 4.8 2.4-7.2-6-4.8h7.6z"/></svg>Instant Alternative</div>
            <div class="ypg-queue-conversion-pill">Save <span class="ypg-banner-running-timer">${initialTimerStr}</span></div>
          </div>
          <div class="ypg-queue-conversion-text">
            ${actionText}
          </div>
          <button type="button" class="ypg-btn-queue-switch" onclick="selectPaymentMethod('${altMethodCode}')">
            <span>Pay with ${altMethodName}</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      `;
      qBanner.style.display = 'block';
    }

    // --- PURE QR SVG LOADER (ALWAYS LOADS & SHOWS QR CODE REGARDLESS OF SERVER STATUS) ---
    async function loadQrSvg() {
      const container = document.getElementById('qrImageContainer');
      if (!container) return;
      try {
        const res = await fetch(`/checkout/${PAYMENT_ID}/qr.svg`);
        if (res.ok) {
          const svg = await res.text();
          if (svg && svg.includes('<svg')) {
            container.innerHTML = svg;
            return;
          }
        }
      } catch (e) {
        console.warn('loadQrSvg error:', e);
      }
      // Automatic retry to guarantee QR code is loaded
      setTimeout(async () => {
        try {
          const res = await fetch(`/checkout/${PAYMENT_ID}/qr.svg`);
          if (res.ok) {
            const svg = await res.text();
            if (svg && svg.includes('<svg')) {
              container.innerHTML = svg;
            }
          }
        } catch (e) {}
      }, 400);
    }

    function copyVpaId() {
      const vpa = (state?.payeeVpa || document.getElementById('displayVpaVal')?.textContent || '').trim();
      if (!vpa) return;

      const btn = document.getElementById('btnCopyVpa');
      const text = document.getElementById('copyVpaText');
      if (btn && text) {
        navigator.clipboard.writeText(vpa).then(() => {
          text.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            text.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 2000);
        }).catch(() => {
          text.textContent = 'Copied!';
          setTimeout(() => { text.textContent = 'Copy'; }, 2000);
        });
      }
    }

    // --- RAZORPAY AUTHENTIC "PROCESSING YOUR PAYMENT" MODAL SHEET ---
    function openProcessingModal(title = 'Processing payment securely with Mitto Pay', subtitle = 'Bank verification in progress. Please do not close or refresh this window.') {
      const modal = document.getElementById('rzpProcessingModal');
      const tEl = document.getElementById('rzpProcessingTitle');
      const sEl = document.getElementById('rzpProcessingSubtitle');
      if (tEl) tEl.textContent = title;
      if (sEl) sEl.textContent = subtitle;
      if (modal) {
        modal.hidden = false;
        requestAnimationFrame(() => modal.classList.add('active'));
      }
    }

    function closeProcessingModal() {
      const modal = document.getElementById('rzpProcessingModal');
      if (modal) {
        modal.classList.remove('active');
        setTimeout(() => { modal.hidden = true; }, 300);
      }
    }

    // --- RAZORPAY AUTHENTIC "CANCEL PAYMENT" CONFIRMATION MODAL SHEET ---
    function openCancelPaymentModal() {
      emitTriggerHook('CANCEL_CLICKED');
      document.body.style.overflow = 'hidden';
      const yBody = document.querySelector('.ypg-body');
      if (yBody) yBody.style.overflow = 'hidden';

      const modal = document.getElementById('rzpCancelModal');
      const promptView = document.getElementById('rzpCancelPromptView');
      const progressView = document.getElementById('rzpCancellingProgressView');
      if (promptView) promptView.style.display = 'flex';
      if (progressView) progressView.style.display = 'none';
      if (modal) {
        modal.hidden = false;
        requestAnimationFrame(() => modal.classList.add('active'));
      }
    }

    function closeCancelPaymentModal() {
      document.body.style.overflow = '';
      const yBody = document.querySelector('.ypg-body');
      if (yBody) yBody.style.overflow = '';

      const modal = document.getElementById('rzpCancelModal');
      if (modal) {
        modal.classList.remove('active');
        setTimeout(() => { modal.hidden = true; }, 300);
      }
    }

    async function confirmCancelPayment() {
      emitTriggerHook('CANCEL_CONFIRMED');
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null; }

      const promptView = document.getElementById('rzpCancelPromptView');
      const progressView = document.getElementById('rzpCancellingProgressView');
      if (promptView) promptView.style.display = 'none';
      if (progressView) progressView.style.display = 'flex';

      try {
        await fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/cancel`, {
          method: 'POST',
          headers: getApiHeaders()
        });
      } catch (e) { }

      // Smooth realistic delay matching Razorpay transition
      setTimeout(() => {
        document.body.style.overflow = '';
        const yBody = document.querySelector('.ypg-body');
        if (yBody) yBody.style.overflow = '';

        closeCancelPaymentModal();
        closeProcessingModal();

        const storeUrl = getStoreReturnUrl();
        const isEmbedded = (window.parent && window.parent !== window) || location.search.includes('embedded=1');

        if (isEmbedded) {
          try {
            postToMerchant({ event: 'youpi.modal_close', redirectUrl: storeUrl });
            postToMerchant({ event: 'youpi.close', redirectUrl: storeUrl });
            postToMerchant({ event: 'youpi.cancel', redirectUrl: storeUrl });
            postToMerchant({ event: 'youpi.payment_cancelled', redirectUrl: storeUrl });
          } catch (e) { }
        }

        loadState();
      }, 500);
    }

    // Direct invocation from header back button, close button, or inline links
    function cancelPayment() {
      openCancelPaymentModal();
    }

    // Listen for cancel requests from parent iframe cross button
    window.addEventListener('message', (e) => {
      if (e.data && e.data.event === 'youpi.request_cancel') {
        openCancelPaymentModal();
      }
    });

    // --- MANUAL PAYMENT DONE VERIFICATION ---
    async function submitPaymentDone() {
      openProcessingModal('Processing payment securely with Mitto Pay', 'Bank verification in progress. Please do not close or refresh this window.');
      emitTriggerHook('PAYMENT_DONE_CLICKED');

      try {
        const res = await fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/payment-done`, {
          method: 'POST'
        });
        if (res.ok) {
          loadState();
        }
      } catch (e) { }
    }

    // --- SINGLE ACTIVE PAYMENT SESSION CONFLICT RESOLUTION ---
    let activeConflictSessionId = null;

    async function executeRetryNewPayment() {
      try {
        const btn = document.getElementById('btnEndSessionAndStartNew');
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Activating new payment...';
        }
        const headers = { 'Content-Type': 'application/json' };
        if (typeof DeviceIdentity !== 'undefined') {
          if (DeviceIdentity.currentDeviceId) headers['X-Device-Id'] = DeviceIdentity.currentDeviceId;
          if (DeviceIdentity.currentDeviceToken) headers['X-Device-Token'] = DeviceIdentity.currentDeviceToken;
        }
        const token = activeToken || getStoredCustomerToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
          headers['x-customer-token'] = token;
        }
        const res = await fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/retry-new-payment`, {
          method: 'POST',
          headers
        });
        if (res.ok) {
          const conflictModal = document.getElementById('activeConflictModal');
          if (conflictModal) conflictModal.hidden = true;
          await loadState();
        } else {
          const err = await res.json().catch(() => ({}));
          alert(err.error || 'Failed to retry payment');
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'END SESSION & START NEW PAYMENT';
          }
        }
      } catch (e) {
        alert('Network error while retrying payment');
        const btn = document.getElementById('btnEndSessionAndStartNew');
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'END SESSION & START NEW PAYMENT';
        }
      }
    }

    function continueExistingActivePayment() {
      if (activeConflictSessionId) {
        window.location.href = `/checkout/${activeConflictSessionId}`;
      } else {
        const conflictModal = document.getElementById('activeConflictModal');
        if (conflictModal) conflictModal.hidden = true;
        loadState();
      }
    }



    function renderBlockedState(data) {
      closeProcessingModal();
      closeCancelPaymentModal();
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null; }
      
      const bar = document.getElementById('paymentMethodSelectorBar');
      if (bar) bar.style.display = 'none';
      const footer = document.getElementById('ypgStickyFooter');
      if (footer) footer.style.display = 'none';

      hideAllContent();
      const vBlocked = document.getElementById('viewBlockedContent');
      if (vBlocked) vBlocked.hidden = false;

      // Expand to full width on PC desktop split view
      const pcMethodsList = document.getElementById('pcMethodsList');
      if (pcMethodsList) pcMethodsList.style.setProperty('display', 'none', 'important');
      const pcActiveView = document.querySelector('.ypg-pc-active-view');
      if (pcActiveView) pcActiveView.style.width = '100%';
      const pcTopbarTitle = document.querySelector('.ypg-pc-topbar-title');
      if (pcTopbarTitle) pcTopbarTitle.textContent = 'Security Incident Investigation';

      const orderRef = data.orderId || state?.orderId || 'N/A';
      const orderEl = document.getElementById('blockedOrderRefVal');
      if (orderEl) orderEl.textContent = `#${orderRef}`;

      const sessEl = document.getElementById('blockedSessionIdVal');
      if (sessEl) sessEl.textContent = data.id || PAYMENT_ID || 'N/A';

      const timeEl = document.getElementById('blockedTimestampVal');
      if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();

      if (data.blockedNotice?.title) {
        const titleEl = document.getElementById('blockedTitleText');
        if (titleEl) titleEl.textContent = data.blockedNotice.title;
      }
      if (data.blockedNotice?.subtitle) {
        const subEl = document.getElementById('blockedSubtitleText');
        if (subEl) subEl.textContent = data.blockedNotice.subtitle;
      }
      if (data.blockedNotice?.message) {
        const msgEl = document.getElementById('blockedNoticeText');
        if (msgEl) msgEl.textContent = data.blockedNotice.message;
      }

      emitTriggerHook('PAYMENT_BLOCKED', {
        reason: data.reason || data.blockedNotice?.reason || 'FRAUDULENT_PAYMENT_INJECTION',
        orderId: orderRef
      });

      try {
        postToMerchant({
          event: 'youpi.payment_blocked',
          data: {
            status: 'BLOCKED',
            isBanned: true,
            orderId: orderRef,
            paymentId: data.id || PAYMENT_ID
          }
        });
      } catch (e) {}
    }

    function handleBlockedExit() {
      const failRedirectUrl = getFailedRedirectUrl();
      if (window.parent && window.parent !== window) {
        try {
          postToMerchant({
            event: 'youpi.payment_blocked_exit',
            data: { status: 'BLOCKED', isBanned: true, orderId: state?.orderId }
          });
        } catch (e) {}
      }
      const safeFailUrl = sanitizeRedirectUrl(failRedirectUrl);
      if (safeFailUrl) window.location.href = safeFailUrl;
    }

    let lastDuplicateSessionPayload = null;
    function renderDuplicateSession(data) {
      lastDuplicateSessionPayload = data;
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null; }
      if (sse) { try { sse.close(); } catch(e){} sse = null; }

      const bar = document.getElementById('paymentMethodSelectorBar');
      if (bar) bar.style.display = 'none';
      const footer = document.getElementById('ypgStickyFooter');
      if (footer) footer.style.display = 'none';

      hideAllContent();
      const vDup = document.getElementById('viewDuplicateSessionContent');
      if (vDup) vDup.hidden = false;

      // Expand to full width on PC desktop split view
      const pcMethodsList = document.getElementById('pcMethodsList');
      if (pcMethodsList) pcMethodsList.style.setProperty('display', 'none', 'important');
      const pcActiveView = document.querySelector('.ypg-pc-active-view');
      if (pcActiveView) pcActiveView.style.width = '100%';
      const pcTopbarTitle = document.querySelector('.ypg-pc-topbar-title');
      if (pcTopbarTitle) pcTopbarTitle.textContent = 'Device Security Verification';

      emitTriggerHook('DUPLICATE_SESSION_DETECTED', {
        sessionId: data.session_id || PAYMENT_ID,
        action: 'END_SESSION_AND_CREATE_NEW'
      });
    }

    async function handleEndAndStartNewPayment() {
      const btn = document.getElementById('btnEndAndRestartPayment') || document.getElementById('btnFailedAction');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="ypg-spinner" style="display:inline-block;width:15px;height:15px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:rzpRotate 0.8s linear infinite;margin-right:8px;vertical-align:middle;"></span> CREATING NEW PAYMENT...';
      }

      try {
        await DeviceIdentity.getOrRegister();
        const headers = { 'Content-Type': 'application/json' };
        if (DeviceIdentity.currentDeviceId) {
          headers['X-Device-Id'] = DeviceIdentity.currentDeviceId;
        }
        if (DeviceIdentity.currentDeviceToken) {
          headers['X-Device-Token'] = DeviceIdentity.currentDeviceToken;
        }

        const conflictingSessionId = lastDuplicateSessionPayload?.conflicting_session_id || activeConflictSessionId || null;

        const res = await fetch(`${API_BASE}/api/v1/checkout/${PAYMENT_ID}/end-and-restart-payment`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            deviceId: DeviceIdentity.currentDeviceId,
            conflictingSessionId
          })
        });

        const data = await res.json();
        if (data.success && (data.checkoutUrl || data.newSessionId)) {
          const targetUrl = sanitizeRedirectUrl(data.checkoutUrl) || `/checkout/${data.newSessionId}`;
          window.location.href = targetUrl;
        } else {
          alert(data.error || 'Failed to start new payment session. Please try again.');
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<span>END SESSION &amp; START NEW PAYMENT</span>';
          }
        }
      } catch (err) {
        alert('Network error while starting new payment session.');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<span>END SESSION &amp; START NEW PAYMENT</span>';
        }
      }
    }

    // --- SSE REALTIME STREAM (AUTOMATIC OBSERVER & CASHIER INTEGRATION) ---
    function connectSse() {
      if (sse) {
        try { sse.close(); } catch (e) { }
        sse = null;
      }

      try {
        const devQuery = DeviceIdentity.currentDeviceId ? `?deviceId=${encodeURIComponent(DeviceIdentity.currentDeviceId)}` : '';
        const streamUrl = `${API_BASE}/api/v1/checkout/${PAYMENT_ID}/stream${devQuery}`;
        sse = new EventSource(streamUrl);

        const handleRealtimePayload = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data && (data.error === 'DUPLICATE_SESSION_DETECTED' || data.type === 'DUPLICATE_SESSION_DETECTED')) {
              renderDuplicateSession(data);
            } else if (data && (data.status === 'BLOCKED' || data.isBanned || data.fraudDetected || data.type === 'FRAUD_BLOCKED' || data.event === 'account_blocked')) {
              renderBlockedState(data);
            } else if (data && data.type === 'STATE_CHANGE' && data.payload) {
              renderState(data.payload);
            } else if (data && data.status) {
              if (data.status === 'BLOCKED' || data.isBanned) {
                renderBlockedState(data);
              } else {
                loadState();
              }
            } else {
              loadState();
            }
          } catch (e) {
            loadState();
          }
        };

        sse.onmessage = handleRealtimePayload;
        sse.addEventListener('status_change', handleRealtimePayload);
        sse.addEventListener('state_change', handleRealtimePayload);
        sse.addEventListener('account_blocked', handleRealtimePayload);
        sse.addEventListener('fraud_detected', handleRealtimePayload);
        sse.addEventListener('counter_payment_confirmed', handleRealtimePayload);
        sse.addEventListener('counter_payment_declined', handleRealtimePayload);
        sse.addEventListener('payment_success', handleRealtimePayload);
        sse.addEventListener('queue_cleared', handleRealtimePayload);
        sse.addEventListener('session_expired', handleRealtimePayload);

        sse.onerror = () => {
          if (sse) {
            try { sse.close(); } catch (e) { }
            sse = null;
          }
          setTimeout(connectSse, 3000);
        };
      } catch (e) {
        setTimeout(connectSse, 3000);
      }
    }

    // Continuous 2-second fallback polling: guarantees instant response when cashier confirms/declines or queues clear
    setInterval(() => {
      if (state && (state.status === 'SUCCESS' || state.status === 'FAILED' || state.status === 'EXPIRED' || state.status === 'BLOCKED' || state.isBanned)) {
        return;
      }
      loadState();
    }, 2000);

    // --- SUPPORT / HELP MODAL ---
    function openHelpModal() {
      document.getElementById('helpModal').hidden = false;
      const popoverMobile = document.getElementById('accountMenuPopover');
      if (popoverMobile) { popoverMobile.setAttribute('hidden', ''); popoverMobile.hidden = true; popoverMobile.style.display = 'none'; }
      const popoverPc = document.getElementById('accountMenuPopoverPc');
      if (popoverPc) { popoverPc.setAttribute('hidden', ''); popoverPc.hidden = true; popoverPc.style.display = 'none'; }

      const branding = state?.branding || {};
      renderSupportInfo({
        supportEmails: branding.supportEmails || (branding.supportEmail ? [branding.supportEmail] : []),
        supportMobiles: branding.supportMobiles || (branding.supportMobile ? [branding.supportMobile] : [])
      });
    }

    function renderSupportInfo(info) {
      const emailBox = document.getElementById('helpModalEmailsContainer');
      const phoneBox = document.getElementById('helpModalMobilesContainer');
      const caseBox = document.getElementById('helpModalCaseInfoText');

      const emails = (info && info.supportEmails && info.supportEmails.length > 0)
        ? info.supportEmails
        : ['support@vvisa.in'];
      const phones = (info && info.supportMobiles && info.supportMobiles.length > 0)
        ? info.supportMobiles
        : ['+91 8610648309'];

      if (emailBox) {
        emailBox.innerHTML = `<strong>Email:</strong> ${emails.join(', ')}`;
      }
      if (phoneBox) {
        phoneBox.innerHTML = `<strong>Phone:</strong> ${phones.join(', ')}`;
      }
      if (caseBox) {
        caseBox.textContent = `PAYMENT_ID: ${PAYMENT_ID}\nORDER_ID: ${state?.orderId || 'N/A'}\nAMOUNT: ₹${state?.amount || 'N/A'}\nSTATUS: ${state?.status || 'N/A'}`;
      }
    }

    function closeHelpModal() {
      document.getElementById('helpModal').hidden = true;
    }

    function copyCaseInfo() {
      const text = document.getElementById('helpModalCaseInfoText').textContent;
      navigator.clipboard.writeText(text).then(() => {
        document.getElementById('copyCaseText').textContent = 'Copied to Clipboard!';
        setTimeout(() => {
          document.getElementById('copyCaseText').textContent = 'Copy Payment Case Details';
        }, 2000);
      });
    }

    // WhatsApp OTP Input Keyboard Listeners
    const mobIn = document.getElementById('authMobileInput');
    if (mobIn) {
      mobIn.addEventListener('input', (e) => {
        const clean = e.target.value.replace(/\D/g, '').slice(0, 10);
        if (e.target.value !== clean) {
          e.target.value = clean;
        }
        currentAuthMobile = clean;
      });
      mobIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleAuthMobileSubmit();
        }
      });
    }

    const nameIn = document.getElementById('authSignupName');
    const emailIn = document.getElementById('authSignupEmail');
    if (nameIn) {
      nameIn.addEventListener('input', (e) => {
        currentAuthName = e.target.value;
      });
      nameIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          emailIn?.focus();
        }
      });
    }
    if (emailIn) {
      emailIn.addEventListener('input', (e) => {
        currentAuthEmail = e.target.value;
      });
      emailIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleAuthSignupSubmit();
        }
      });
    }

    const otpIn = document.getElementById('authOtpInput');
    if (otpIn) {
      otpIn.addEventListener('input', (e) => {
        const val = e.target.value.replace(/\D/g, '');
        e.target.value = val;
        if (val.length === 6) {
          handleAuthVerifyOtpSubmit();
        }
      });
      otpIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleAuthVerifyOtpSubmit();
        }
      });
    }

    // Boot checkout - restore preserved 1-week identity if available
    const bootPreserved = getPreservedIdentity();
    if (bootPreserved && bootPreserved.customer) {
      activeCustomer = bootPreserved.customer;
      activeToken = bootPreserved.token || getStoredCustomerToken() || null;
      updateCustomerDisplay(activeCustomer);
    } else {
      activeCustomer = null;
      activeToken = null;
    }

    try {
      const initEl = document.getElementById('ypgInitialState');
      if (initEl && initEl.textContent && initEl.textContent.trim()) {
        const parsed = JSON.parse(initEl.textContent);
        if (parsed && (parsed.amount || parsed.branding || parsed.merchantName)) {
          renderState(parsed);
        }
      }
    } catch (e) { }

    loadState();
    connectSse();