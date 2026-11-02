import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const files = ['packages/merchant-sdk/src/youpi-checkout.js', 'packages/merchant-sdk/src/youpi.js', 'apps/checkout-portal/src/sdk/youpi-checkout.js', 'apps/checkout-portal/src/sdk/youpi.js'];
for (const file of files) {
  function setup() {
    const timers = [];
    const window = {location: {href: 'https://store.test/', origin: 'https://store.test'}, addEventListener() {}, removeEventListener() {}};
    const document = {currentScript: null, querySelector: () => null, addEventListener() {}, dispatchEvent() {}};
    const source = readFileSync(file, 'utf8').replace(/^export .*$/gm, '');
    vm.runInNewContext(source, {window, document, URL, console, CustomEvent: class {constructor(name,options) {this.type=name;this.detail=options.detail;}}, setTimeout: cb => timers.push(cb)});
    const c = new window.YoupiCheckout();
    c.constructor._ensureStyles = () => {};
    const nodes = [];
    c._injectModal = () => {
      const node = {connected: true, classList: {remove() {}, add() {}}};
      node.parentNode = {removeChild(n) {n.connected = false;}};
      c.backdrop = node; c.container = node; c.iframe = {};nodes.push(node);
    };
    return {c, timers, nodes};
  }
  test(`${file}: success auto-close must not close a new modal`, () => {
    const {c, timers, nodes} = setup();
    c.open();
    const success = {event: 'youpi.payment_success', data: {orderId: 'first'}};
    c._iframe = {contentWindow: {}}; c._iframeOrigin = 'https://checkout.test';
    c._handleMessage({source: c._iframe.contentWindow, origin: c._iframeOrigin, data: success});
    c.close(); c.open();
    timers[0]();
    assert.equal(c.isOpen, true, 'an older payment success must not close the reopened checkout');
    assert.equal(nodes[1].connected, true);
  });
  test(`${file}: reopening from onSuccess invalidates the old auto-close`, () => {
    const {c, timers, nodes} = setup();
    c.options.onSuccess = () => { c.close(); c.open(); };
    c.open(); c._iframe = {contentWindow: {}}; c._iframeOrigin = 'https://checkout.test';
    c._handleMessage({source: c._iframe.contentWindow, origin: c._iframeOrigin, data: {event: 'youpi.payment_success', data: {orderId: 'first'}}});
    // onSuccess schedules old-modal cleanup first, then the handler schedules auto-close.
    timers[0](); timers[1]();
    assert.equal(c.isOpen, true);
    assert.equal(c.backdrop, nodes[1]);
    assert.equal(nodes[0].connected, false);
    assert.equal(nodes[1].connected, true);
  });
  test(`${file}: duplicate success timers cannot close a later checkout`, () => {
    const {c, timers, nodes} = setup();
    c.open(); c._iframe = {contentWindow: {}}; c._iframeOrigin = 'https://checkout.test';
    const message = {source: c._iframe.contentWindow, origin: c._iframeOrigin, data: {event: 'youpi.payment_success', data: {orderId: 'first'}}};
    c._handleMessage(message); c._handleMessage(message);
    timers[0](); // First success timer closes the first checkout.
    c.open();
    timers[1](); // Duplicate success timer belongs to that first checkout, too.
    assert.equal(c.isOpen, true);
    assert.equal(c.backdrop, nodes[1]);
    assert.equal(nodes[1].connected, true);
  });
  test(`${file}: ordinary success still closes the original modal`, () => {
    const {c, timers} = setup();
    c.open(); c._iframe = {contentWindow: {}}; c._iframeOrigin = 'https://checkout.test';
    c._handleMessage({source: c._iframe.contentWindow, origin: c._iframeOrigin, data: {event: 'youpi.payment_success', data: {orderId: 'first'}}});
    timers[0](); assert.equal(c.isOpen, false);
  });
}
