/**
 * YOUPI PG V2 — Universal One-Script Integration SDK
 *
 * Official Distributable Browser Script (youpi.js / youpi-checkout.js)
 * Provides zero-JavaScript button configuration [data-youpi-pay] and programmatic Youpi.pay({...})
 * Launches the responsive iframe checkout modal with background blur.
 * Emits normalized browser payment events and manages checkout modal lifecycle.
 *
 * IMPORTANT SECURITY NOTE:
 * Browser events and client-side callbacks are strictly for UI and user experience.
 * Browser callbacks are not proof of settlement. For manual UPI, only the merchant's
 * independent bank-account review may approve payment.
 */

(function (globalScope) {
  'use strict';

  // Prevent multiple initializations
  if (globalScope.__YOUPI_SDK_INITIALIZED__) {
    return;
  }
  globalScope.__YOUPI_SDK_INITIALIZED__ = true;

  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

  function sanitizeModalUrl(url) {
    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch {}
    return 'about:blank';
  }

  /**
   * Helper: extract configuration from the <script> tag loading this file.
   */
  function getScriptConfig() {
    if (!isBrowser) return {};

    const script = document.currentScript ||
      document.querySelector('script[src*="youpi.js"], script[src*="youpi-checkout.js"]');

    if (!script) return {};

    let scriptUrl = '';
    try {
      scriptUrl = new URL(script.src, window.location.href);
    } catch (e) { }

    const origin = scriptUrl ? scriptUrl.origin : (window.location.protocol + '//' + window.location.hostname + ':7000');

    return {
      // Merchant identifiers are public. Secret API credentials belong only on merchant servers.
      merchantId: script.getAttribute('data-merchant-id') || '',
      apiUrl: script.getAttribute('data-api-url') || origin,
      portalUrl: script.getAttribute('data-portal-url') || script.getAttribute('data-checkout-url') || origin,
      currency: script.getAttribute('data-currency') || 'INR',
      name: script.getAttribute('data-name') || 'Merchant Store',
      themeColor: script.getAttribute('data-theme-color') || '#0b63e5',
      successUrl: script.getAttribute('data-success-url') || '',
      failedUrl: script.getAttribute('data-failed-url') || '',
      suspiciousUrl: script.getAttribute('data-suspicious-url') || '',
      expiredUrl: script.getAttribute('data-expired-url') || '',
      cancelledUrl: script.getAttribute('data-cancelled-url') || ''
    };
  }

  const scriptConfig = getScriptConfig();

  /**
   * YoupiCheckout class
   */
  class YoupiCheckout {
    /**
     * @param {{
     *   order_id?: string,
     *   orderId?: string,
     *   amount?: number | string,
     *   currency?: string,
     *   name?: string,
     *   description?: string,
     *   customer?: { name?: string, email?: string, phone?: string },
     *   metadata?: Record<string, any>,
     *   paymentId?: string,
     *   checkoutUrl?: string,
     *   portalUrl?: string,
     *   apiUrl?: string,
     *   theme?: { color?: string },
     *   handler?: (result: any) => void,
     *   onSuccess?: (result: any) => void,
     *   onFailed?: (result: any) => void,
     *   onPaymentFailed?: (result: any) => void,
     *   onSuspicious?: (result: any) => void,
     *   onExpired?: (result: any) => void,
     *   onCancelled?: (result: any) => void,
     *   onClose?: () => void,
     *   successUrl?: string,
     *   failedUrl?: string,
     *   suspiciousUrl?: string,
     *   expiredUrl?: string,
     *   cancelledUrl?: string
     * }} options
     */
    constructor(options = {}) {
      const defaultPortal = isBrowser
        ? (scriptConfig.portalUrl || window.location.origin)
        : 'http://localhost:7000';

      const defaultApi = isBrowser
        ? (scriptConfig.apiUrl || defaultPortal)
        : 'http://localhost:6100';

      this.options = Object.assign({
        order_id: '',
        orderId: '',
        amount: 0,
        currency: scriptConfig.currency || 'INR',
        name: scriptConfig.name || 'Merchant Store',
        description: 'Order Payment',
        customer: {},
        metadata: {},
        paymentId: '',
        checkoutUrl: '',
        portalUrl: defaultPortal,
        apiUrl: defaultApi,
        theme: { color: scriptConfig.themeColor || '#0b63e5' },
        handler: null,
        onSuccess: null,
        onFailed: null,
        onPaymentFailed: null,
        onSuspicious: null,
        onExpired: null,
        onCancelled: null,
        onClose: null,
        successUrl: scriptConfig.successUrl || '',
        failedUrl: scriptConfig.failedUrl || '',
        suspiciousUrl: scriptConfig.suspiciousUrl || '',
        expiredUrl: scriptConfig.expiredUrl || '',
        cancelledUrl: scriptConfig.cancelledUrl || ''
      }, options);

      // Normalize order ID
      if (!this.options.orderId && this.options.order_id) {
        this.options.orderId = this.options.order_id;
      }
      if (!this.options.order_id && this.options.orderId) {
        this.options.order_id = this.options.orderId;
      }

      this.isOpen = false;
      this.backdrop = null;
      this.container = null;
      this.iframe = null;

      this._handleMessage = this._handleMessage.bind(this);
    }

    /**
     * Primary static programmatic entry point: Youpi.pay(options)
     */
    static async pay(options = {}) {
      const instance = new YoupiCheckout(options);

      // If checkoutUrl is already provided, open modal directly
      if (instance.options.checkoutUrl) {
        instance.open();
        return instance;
      }

      // If paymentId is already provided, construct checkoutUrl and open
      if (instance.options.paymentId) {
        instance.options.checkoutUrl = `${instance.options.portalUrl}/checkout/${instance.options.paymentId}`;
        instance.open();
        return instance;
      }

      throw new Error('Create the payment on your server using trusted order data, then pass checkoutUrl or paymentId to Youpi.pay(). Never put a merchant API secret in browser code.');
    }

    /**
     * Backward-compatible static entry point: YoupiCheckout.open(options)
     */
    static open(options) {
      const instance = new YoupiCheckout(options);
      instance.open();
      return instance;
    }

    /**
     * Opens the responsive iframe checkout modal
     */
    open() {
      if (!isBrowser) {
        console.warn('YoupiCheckout.open() can only be invoked in a browser DOM environment.');
        return;
      }
      if (this.isOpen) return;
      this.isOpen = true;

      YoupiCheckout._ensureStyles();

      let targetUrl = '';
      if (this.options.checkoutUrl) {
        targetUrl = this.options.checkoutUrl;
      } else if (this.options.paymentId) {
        targetUrl = `${this.options.portalUrl}/checkout/${this.options.paymentId}`;
      } else {
        targetUrl = `${this.options.portalUrl}/checkout/demo`;
      }

      // If running on localhost / 127.0.0.1 and targetUrl points to remote external origin, keep path and point to local host
      if (isBrowser && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
        try {
          const parsed = new URL(targetUrl, window.location.origin);
          if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && !this.options.portalUrl) {
            targetUrl = `${window.location.protocol}//${window.location.host}${parsed.pathname}${parsed.search}`;
          }
        } catch {}
      }

      // Add embedded flag and custom params
      const sep = targetUrl.includes('?') ? '&' : '?';
      targetUrl = `${targetUrl}${sep}embedded=1`;

      // Declare this page's origin so the checkout can target its postMessages
      // even when the browser strips the referrer. Opaque origins (file:) and
      // non-http(s) schemes must not be announced.
      try {
        const parsed = new URL(window.location.href);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          targetUrl += `&youpiParentOrigin=${encodeURIComponent(parsed.origin)}`;
        }
      } catch {}

      if (this.options.amount) {
        targetUrl += `&customAmount=${encodeURIComponent(this.options.amount)}`;
      }
      if (this.options.name) {
        targetUrl += `&customName=${encodeURIComponent(this.options.name)}`;
      }

      this._injectModal(targetUrl);
      window.addEventListener('message', this._handleMessage);
    }

    /**
     * Closes the checkout modal
     */
    close(callback) {
      if (!isBrowser || !this.isOpen) return;
      this.isOpen = false;

      window.removeEventListener('message', this._handleMessage);

      if (this.container) {
        this.container.classList.remove('active');
        this.container.classList.add('closing');
      }
      if (this.backdrop) {
        this.backdrop.classList.remove('active');
      }

      // The closing modal may no longer be the current one when its animation ends.
      const closingBackdrop = this.backdrop;
      setTimeout(() => {
        if (closingBackdrop && closingBackdrop.parentNode) {
          closingBackdrop.parentNode.removeChild(closingBackdrop);
        }
        if (this.backdrop === closingBackdrop) {
          this.backdrop = null;
          this.container = null;
          this.iframe = null;
        }

        if (typeof this.options.onClose === 'function') {
          this.options.onClose();
        }
        if (typeof callback === 'function') {
          callback();
        }
      }, 350);
    }

    _injectModal(targetUrl) {
      const backdrop = document.createElement('div');
      backdrop.className = 'youpi-checkout-backdrop';

      const container = document.createElement('div');
      container.className = 'youpi-checkout-container';

      const closeBtn = document.createElement('button');
      closeBtn.className = 'youpi-checkout-close-btn';
      closeBtn.textContent = '✕';
      closeBtn.title = 'Close Checkout';
      closeBtn.type = 'button';
      closeBtn.onclick = () => {
        try {
          if (iframe && iframe.contentWindow) {
            if (this._iframeOrigin) {
              iframe.contentWindow.postMessage({ event: 'youpi.request_cancel' }, this._iframeOrigin);
            }
            return;
          }
        } catch (err) { }
        this._dispatchCancelled();
        this.close();
      };

      const iframe = document.createElement('iframe');
      iframe.className = 'youpi-checkout-iframe';
      iframe.src = sanitizeModalUrl(targetUrl);
      // Only messages from this exact iframe/origin are trusted (see _handleMessage).
      this._iframe = iframe;
      try { this._iframeOrigin = new URL(targetUrl, window.location.href).origin; } catch { this._iframeOrigin = null; }
      iframe.allow = 'payment';

      container.appendChild(closeBtn);
      container.appendChild(iframe);
      backdrop.appendChild(container);
      document.body.appendChild(backdrop);

      requestAnimationFrame(() => {
        backdrop.classList.add('active');
        container.classList.add('active');
      });

      this.backdrop = backdrop;
      this.container = container;
      this.iframe = iframe;

      // Invariant: ONLY the cross (X) button exits the payment gateway!
      // Prevent outside touch/click on backdrop from closing the checkout modal.
      const stopOutsideDismiss = (e) => {
        if (e.target === backdrop) {
          e.preventDefault();
          e.stopPropagation();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          return false;
        }
      };
      backdrop.addEventListener('click', stopOutsideDismiss, true);
      backdrop.addEventListener('touchstart', stopOutsideDismiss, { passive: false, capture: true });
      backdrop.addEventListener('touchend', stopOutsideDismiss, { passive: false, capture: true });
      backdrop.addEventListener('touchmove', stopOutsideDismiss, { passive: false, capture: true });
      backdrop.addEventListener('pointerdown', stopOutsideDismiss, true);
      backdrop.addEventListener('pointerup', stopOutsideDismiss, true);
      backdrop.addEventListener('mousedown', stopOutsideDismiss, true);
      backdrop.addEventListener('mouseup', stopOutsideDismiss, true);
    }

    _isSafeRedirect(url) {
      try {
        const u = new URL(url, window.location.href);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    }

    /**
     * Origin of the checkout iframe this instance embeds. Messages from any
     * other origin are ignored so a third party cannot forge payment events.
     */
    _checkoutOrigin() {
      try {
        // Only an explicitly configured checkout URL is authoritative. `portalUrl` defaults
        // to localhost, so including it would make this check reject legitimate messages.
        const url = this.options.checkoutUrl;
        if (url) return new URL(url, window.location.href).origin;
      } catch (e) { }
      return null;
    }

    _handleMessage(e) {
      // Ignore messages from any window other than our checkout iframe (spoofed success events).
      if (!this._iframe || e.source !== this._iframe.contentWindow) return;
      if (!this._iframeOrigin || e.origin !== this._iframeOrigin) return;
      if (!e.data || typeof e.data !== 'object') return;

      const expectedOrigin = this._checkoutOrigin();
      if (expectedOrigin && e.origin !== expectedOrigin) return;

      const event = e.data.event;
      const rawData = e.data.data || e.data;

      if (event === 'youpi.payment_success') {
        const successBackdrop = this.backdrop;
        const payload = e.data.data || {};
        const result = {
          status: 'SUCCESS',
          order_id: payload.orderId || this.options.orderId || this.options.order_id,
          payment_mode: payload.method || 'UPI',
          amount_received: Number(payload.amount || this.options.amount || 0),
          utr: payload.bankRef || payload.utr || payload.reference || '',
          timestamp: payload.completedAt || new Date().toISOString(),
          metadata: payload.metadata || this.options.metadata || {},
          raw: payload
        };

        YoupiCheckout._emitEvent('youpi:payment:success', result);
        YoupiCheckout._emitEvent('youpi:payment:result', result);

        if (typeof this.options.handler === 'function') {
          this.options.handler(result);
        }
        if (typeof this.options.onSuccess === 'function') {
          this.options.onSuccess(result);
        }

        setTimeout(() => {
          if (!this.isOpen || this.backdrop !== successBackdrop) return;
          this.close(() => {
            if (this.options.successUrl) {
              const delim = this.options.successUrl.includes('?') ? '&' : '?';
              window.location.href = `${this.options.successUrl}${delim}order_id=${encodeURIComponent(result.order_id)}&amount=${encodeURIComponent(result.amount_received)}&utr=${encodeURIComponent(result.utr)}`;
            }
          });
        }, 1500);
      } else if (event === 'youpi.payment_observed' || event === 'youpi.payment_reconciled' || event === 'youpi.payment_manual_review') {
        const payload = e.data.data || {};
        const status = event === 'youpi.payment_reconciled'
          ? 'RECONCILED'
          : (event === 'youpi.payment_manual_review' ? 'MANUAL_REVIEW' : 'OBSERVED_SUCCESS');
        const result = {
          status,
          order_id: payload.orderId || this.options.orderId || this.options.order_id,
          payment_mode: payload.method || 'UPI',
          amount_received: Number(payload.amount || this.options.amount || 0),
          utr: payload.bankRef || payload.utr || payload.reference || '',
          timestamp: payload.completedAt || new Date().toISOString(),
          metadata: payload.metadata || this.options.metadata || {},
          settlement_state: payload.settlementState || (status === 'RECONCILED' ? 'RECONCILED' : (status === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW' : 'NOT_RECONCILED')),
          raw: payload
        };
        const domEvent = status === 'RECONCILED'
          ? 'youpi:payment:success'
          : (status === 'MANUAL_REVIEW' ? 'youpi:payment:suspicious' : 'youpi:payment:observed');
        YoupiCheckout._emitEvent(domEvent, result);
        YoupiCheckout._emitEvent('youpi:payment:result', result);
        if (typeof this.options.handler === 'function') this.options.handler(result);
        if (status === 'RECONCILED' && typeof this.options.onSuccess === 'function') this.options.onSuccess(result);
      } else if (event === 'youpi.payment_failed') {
        const payload = e.data.data || e.data || {};
        const result = {
          status: 'FAILED',
          order_id: payload.orderId || this.options.orderId || this.options.order_id,
          payment_mode: payload.method || 'UPI',
          amount_received: 0,
          utr: '',
          reason: payload.reason || payload.status || 'PAYMENT_FAILED',
          timestamp: new Date().toISOString(),
          metadata: payload.metadata || this.options.metadata || {},
          raw: payload
        };

        YoupiCheckout._emitEvent('youpi:payment:failed', result);
        YoupiCheckout._emitEvent('youpi:payment:result', result);

        if (typeof this.options.onFailed === 'function') {
          try { this.options.onFailed(result); } catch (err) { }
        }
        if (typeof this.options.onPaymentFailed === 'function') {
          try { this.options.onPaymentFailed(result); } catch (err) { }
        }

        this.close(() => {
          if (this.options.failedUrl) {
            const delim = this.options.failedUrl.includes('?') ? '&' : '?';
            window.location.href = `${this.options.failedUrl}${delim}order_id=${encodeURIComponent(result.order_id)}&reason=${encodeURIComponent(result.reason)}`;
          } else if (payload.redirectUrl && this._isSafeRedirect(payload.redirectUrl) && payload.redirectUrl !== window.location.href && !payload.redirectUrl.includes('/checkout')) {
            window.location.href = payload.redirectUrl;
          }
        });
      } else if (event === 'youpi.payment_blocked' || event === 'youpi.payment_blocked_exit') {
        const payload = e.data.data || e.data || {};
        const result = {
          status: 'SUSPICIOUS',
          order_id: payload.orderId || this.options.orderId || this.options.order_id,
          payment_mode: payload.method || 'UPI',
          amount_received: 0,
          utr: '',
          reason: 'SECURITY_REVIEW_FLAGGED',
          timestamp: new Date().toISOString(),
          metadata: payload.metadata || this.options.metadata || {},
          raw: payload
        };

        YoupiCheckout._emitEvent('youpi:payment:suspicious', result);
        YoupiCheckout._emitEvent('youpi:payment:result', result);

        if (typeof this.options.onSuspicious === 'function') {
          try { this.options.onSuspicious(result); } catch (err) { }
        }

        this.close(() => {
          if (this.options.suspiciousUrl) {
            const delim = this.options.suspiciousUrl.includes('?') ? '&' : '?';
            window.location.href = `${this.options.suspiciousUrl}${delim}order_id=${encodeURIComponent(result.order_id)}&reason=SUSPICIOUS`;
          }
        });
      } else if (event === 'youpi.payment_expired') {
        const payload = e.data.data || e.data || {};
        const result = {
          status: 'EXPIRED',
          order_id: payload.orderId || this.options.orderId || this.options.order_id,
          timestamp: new Date().toISOString()
        };

        YoupiCheckout._emitEvent('youpi:payment:expired', result);
        YoupiCheckout._emitEvent('youpi:payment:result', result);

        if (typeof this.options.onExpired === 'function') {
          try { this.options.onExpired(result); } catch (err) { }
        }

        this.close(() => {
          if (this.options.expiredUrl) {
            const delim = this.options.expiredUrl.includes('?') ? '&' : '?';
            window.location.href = `${this.options.expiredUrl}${delim}order_id=${encodeURIComponent(result.order_id)}`;
          }
        });
      } else if (event === 'youpi.modal_close' || event === 'youpi.close' || event === 'youpi.cancel' || event === 'youpi.payment_cancelled') {
        this._dispatchCancelled();
        const redirectUrl = e.data.redirectUrl;
        this.close(() => {
          if (this.options.cancelledUrl) {
            const delim = this.options.cancelledUrl.includes('?') ? '&' : '?';
            window.location.href = `${this.options.cancelledUrl}${delim}order_id=${encodeURIComponent(this.options.orderId || '')}`;
          } else if (redirectUrl && this._isSafeRedirect(redirectUrl) && redirectUrl !== window.location.href && !redirectUrl.includes('/checkout')) {
            window.location.href = redirectUrl;
          }
        });
      }
    }

    _dispatchCancelled() {
      const result = {
        status: 'CANCELLED',
        order_id: this.options.orderId || this.options.order_id || '',
        timestamp: new Date().toISOString()
      };
      YoupiCheckout._emitEvent('youpi:payment:cancelled', result);
      YoupiCheckout._emitEvent('youpi:payment:result', result);

      if (typeof this.options.onCancelled === 'function') {
        try { this.options.onCancelled(result); } catch (e) { }
      }
    }

    static _emitEvent(name, detail) {
      if (!isBrowser) return;
      try {
        const ev = new CustomEvent(name, { detail, bubbles: true, cancelable: true });
        window.dispatchEvent(ev);
        document.dispatchEvent(ev);
      } catch (e) { }
    }

    /**
     * Handles clicks on elements with [data-youpi-pay] attribute
     */
    static handleButtonClick(btn) {
      if (!btn) return;

      const orderId = btn.getAttribute('data-order-id') || `ORDER-${Date.now()}`;
      const amount = btn.getAttribute('data-amount') || '0';
      const currency = btn.getAttribute('data-currency') || scriptConfig.currency || 'INR';
      const name = btn.getAttribute('data-name') || scriptConfig.name || 'Merchant Store';
      const description = btn.getAttribute('data-description') || 'Order Payment';

      // Customer info
      const customer = {
        name: btn.getAttribute('data-customer-name') || '',
        email: btn.getAttribute('data-customer-email') || '',
        phone: btn.getAttribute('data-customer-phone') || btn.getAttribute('data-customer-mobile') || ''
      };

      // Metadata parsing
      let metadata = {};
      const rawMeta = btn.getAttribute('data-metadata');
      if (rawMeta) {
        try {
          metadata = JSON.parse(rawMeta);
        } catch (e) {
          metadata = { raw: rawMeta };
        }
      }
      // Gather any data-meta-* attributes
      for (const attr of btn.attributes) {
        if (attr.name.startsWith('data-meta-')) {
          const key = attr.name.slice(10);
          metadata[key] = attr.value;
        }
      }

      const checkoutUrl = btn.getAttribute('data-checkout-url') || '';
      const paymentId = btn.getAttribute('data-payment-id') || '';
      const successUrl = btn.getAttribute('data-success-url') || scriptConfig.successUrl || '';
      const failedUrl = btn.getAttribute('data-failed-url') || scriptConfig.failedUrl || '';
      const suspiciousUrl = btn.getAttribute('data-suspicious-url') || scriptConfig.suspiciousUrl || '';
      const expiredUrl = btn.getAttribute('data-expired-url') || scriptConfig.expiredUrl || '';
      const cancelledUrl = btn.getAttribute('data-cancelled-url') || scriptConfig.cancelledUrl || '';

      YoupiCheckout.pay({
        order_id: orderId,
        orderId: orderId,
        amount: amount,
        currency: currency,
        name: name,
        description: description,
        customer: customer,
        metadata: metadata,
        checkoutUrl: checkoutUrl,
        paymentId: paymentId,
        successUrl: successUrl,
        failedUrl: failedUrl,
        suspiciousUrl: suspiciousUrl,
        expiredUrl: expiredUrl,
        cancelledUrl: cancelledUrl
      }).catch(err => {
        console.error('[YouPI JS] Pay error:', err);
      });
    }

    static _ensureStyles() {
      if (!isBrowser) return;
      let styleEl = document.getElementById('youpi-checkout-styles');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'youpi-checkout-styles';
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = `
        .youpi-checkout-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          width: 100%;
          height: 100vh;
          height: 100dvh;
          height: 100%;
          background: rgba(12, 35, 64, 0.76);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          z-index: 2147483640;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 0.25s ease-out;
          touch-action: pan-y;
          overscroll-behavior: contain;
          user-select: none;
          -webkit-user-select: none;
          -webkit-tap-highlight-color: transparent;
        }
        .youpi-checkout-backdrop.active {
          opacity: 1;
        }
        .youpi-checkout-container {
          position: relative;
          width: 440px;
          max-width: 95vw;
          height: 680px;
          max-height: 92vh;
          background: #ffffff;
          border-radius: 14px;
          box-shadow: 0 25px 65px rgba(0, 0, 0, 0.5);
          overflow: hidden;
          transform: translateY(20px) scale(0.98);
          transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
          display: flex;
          flex-direction: column;
          touch-action: auto !important;
          user-select: auto !important;
          -webkit-user-select: auto !important;
        }
        .youpi-checkout-container.active {
          transform: translateY(0) scale(1);
        }
        .youpi-checkout-container.closing {
          transform: translateY(20px) scale(0.96);
        }
        .youpi-checkout-iframe {
          width: 100%;
          height: 100%;
          border: none;
          flex: 1;
          background: #ffffff;
          touch-action: auto !important;
        }
        .youpi-checkout-close-btn {
          position: absolute;
          top: 14px;
          right: 14px;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.2);
          border: none;
          color: #ffffff;
          font-size: 14px;
          cursor: pointer;
          z-index: 10;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.15s;
        }
        .youpi-checkout-close-btn:hover {
          background: rgba(255, 255, 255, 0.4);
        }

        /* DESKTOP / PC MODAL STYLES (Razorpay 2-Column Exact Layout) */
        @media (min-width: 768px) {
          .youpi-checkout-container {
            width: 900px;
            max-width: 95vw;
            height: 600px;
            max-height: 92vh;
            border-radius: 16px;
            box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45);
          }
          .youpi-checkout-close-btn {
            display: none; /* Native in-modal close button inside the checkout header bar */
          }
        }

        /* MOBILE BOTTOM DRAWER / BOTTOM SHEET STYLES */
        @media (max-width: 767px) {
          .youpi-checkout-backdrop {
            align-items: flex-end;
          }
          .youpi-checkout-container {
            width: 100vw;
            max-width: 100vw;
            height: 100dvh;
            height: 100vh;
            height: 100%;
            max-height: 100dvh;
            border-bottom-left-radius: 0;
            border-bottom-right-radius: 0;
            border-top-left-radius: 18px;
            border-top-right-radius: 18px;
            transform: translateY(100%);
            touch-action: auto !important;
            overflow: hidden;
          }
          .youpi-checkout-container.active {
            transform: translateY(0);
          }
          .youpi-checkout-container.closing {
            transform: translateY(100%);
          }
        }
      `;
    }
  }

  // Auto-bind click listener for all [data-youpi-pay] buttons on page
  if (isBrowser) {
    document.addEventListener('click', function (e) {
      const btn = e.target && e.target.closest && e.target.closest('[data-youpi-pay]');
      if (btn) {
        e.preventDefault();
        YoupiCheckout.handleButtonClick(btn);
      }
    });
  }

  // Export globals
  globalScope.YoupiCheckout = YoupiCheckout;
  globalScope.Youpi = YoupiCheckout;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = YoupiCheckout;
    module.exports.YoupiCheckout = YoupiCheckout;
    module.exports.Youpi = YoupiCheckout;
  }
})(typeof window !== 'undefined' ? window : globalThis);
