import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const files = ['packages/merchant-sdk/src/youpi-checkout.js', 'packages/merchant-sdk/src/youpi.js', 'apps/checkout-portal/src/sdk/youpi-checkout.js', 'apps/checkout-portal/src/sdk/youpi.js'];
for (const file of files) {
  function setup() {
    const timers = [];
    const window = {location: {href: 'https://store.test/', origin: 'https://store.test'}, addEventListener() {}, removeEventListener() {}};
    const document = {currentScript: null, querySelector: () => null, addEventListener() {}};
    const source = readFileSync(file, 'utf8').replace(/^export .*$/gm, '');
    vm.runInNewContext(source, {window, document, URL, console, setTimeout: cb => timers.push(cb)});
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
  test(`${file}: an old close must not remove a reopened modal`, () => {
    const {c, timers, nodes} = setup();
    c.open(); c.close(); c.open(); const activeIframe = c.iframe;
    timers.shift()();
    assert.equal(nodes[0].connected, false);
    assert.equal(nodes[1].connected, true);
    assert.equal(c.backdrop, nodes[1]);
    assert.equal(c.iframe, activeIframe);
    assert.equal(c.isOpen, true);
  });
  test(`${file}: repeated close/open cycles clean up only their own nodes`, () => {
    const {c, timers, nodes} = setup();
    let closed = 0; c.options.onClose = () => closed++;
    c.open(); c.close(); c.open(); c.close(); c.open();
    timers.shift()(); timers.shift()();
    assert.deepEqual(nodes.map(n => n.connected), [false, false, true]);
    assert.equal(c.backdrop, nodes[2]);
    assert.equal(closed, 2);
    c.close(); timers.shift()();
    assert.equal(nodes[2].connected, false);
    assert.equal(c.backdrop, null);assert.equal(c.iframe, null);assert.equal(closed, 3);
  });
  test(`${file}: an ordinary close preserves callbacks and cleans up once`, () => {
    const {c, timers, nodes} = setup();
    const calls = []; c.options.onClose = () => calls.push('onClose');
    c.open(); c.close(() => calls.push('callback')); c.close();
    assert.equal(timers.length, 1);timers.shift()();
    assert.equal(nodes[0].connected, false);
    assert.equal(c.backdrop, null);assert.equal(c.iframe, null);assert.equal(c.isOpen, false);
    assert.deepEqual(calls, ['onClose', 'callback']);
  });
}
