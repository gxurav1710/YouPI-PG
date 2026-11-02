import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database, runMigrations, PaymentSessionRepository } from '@youpi/db';
import { TimingEngine } from '../timing-engine.js';

test('failed cancel transaction preserves an actual ACTIVE session and deadline', () => {
  const db = new Database({ inMemory: true });
  const merchant = runMigrations(db).defaultMerchant;
  const repo = new PaymentSessionRepository(db);
  const session = repo.create({ merchantId: merchant.id, receivingAccountId: '00000000-0000-0000-0000-000000000002', orderId: 'CANCEL-ROLLBACK', amountPaise: 10000n });
  repo.acquireSlotAtomic(session.id, session.receivingAccountId, 60000);
  const engine = new TimingEngine({ sessionRepo: repo, queueEngine: {} });
  engine.startActiveTimer(session.id, new Date(Date.now() + 60000));
  const before = engine.activeTimers.get(session.id);
  const transaction = db.transaction;
  db.transaction = () => { throw new Error('temporary cancel transaction failure'); };
  try {
    assert.throws(() => engine.handleCancel(session.id), /temporary cancel transaction failure/);
    assert.equal(repo.findById(session.id).status, 'ACTIVE');
    assert.equal(engine.activeTimers.get(session.id), before);
  } finally {
    db.transaction = transaction;
    engine.destroy();
    db.close();
  }
});

test('failed cancel still expires at the original active deadline', async () => {
  let status = 'ACTIVE';
  const engine = new TimingEngine({
    sessionRepo: {
      findById: () => ({ status, receivingAccountId: 'account' }),
      transitionToTerminal(_id, target) {
        if (target === 'CANCELLED') throw new Error('cancel failed');
        status = target;
      }
    },
    queueEngine: { promoteNext() {} }
  });
  engine.startActiveTimer('session', new Date(Date.now() + 20));
  try {
    assert.throws(() => engine.handleCancel('session'), /cancel failed/);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(status, 'EXPIRED');
  } finally { engine.destroy(); }
});

test('successful cancel still clears the active timer and promotes the queue', () => {
  let promoted = 0;
  const engine = new TimingEngine({
    sessionRepo: {
      findById: () => ({ status: 'ACTIVE', receivingAccountId: 'account' }),
      transitionToTerminal: () => ({ status: 'CANCELLED' })
    },
    queueEngine: { promoteNext() { promoted++; } }
  });
  engine.startActiveTimer('session', new Date(Date.now() + 60000));
  try {
    assert.equal(engine.handleCancel('session').status, 'CANCELLED');
    assert.equal(engine.activeTimers.has('session'), false);
    assert.equal(promoted, 1);
  } finally { engine.destroy(); }
});
