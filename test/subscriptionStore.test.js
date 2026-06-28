import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.TOKEN_SECRET_KEY = 'a'.repeat(64);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUBSCRIPTIONS_FILE = path.join(__dirname, '..', 'subscriptions.json');

const { createSubscription, getSubscription, listSubscriptions, updateSubscription } = await import(
  '../src/subscriptionStore.js'
);

after(() => {
  try {
    fs.unlinkSync(SUBSCRIPTIONS_FILE);
  } catch {}
});

const makeSub = (overrides = {}) => ({
  phoneNumber: '87001234567',
  amount: 5000,
  billingPeriod: 'monthly',
  status: 'active',
  sessionHeaders: { tokenSN: 'TSN123', vtokenSecret: 'enc_secret', profileId: 'P1' },
  nextBillingAt: new Date().toISOString(),
  failedAttempts: 0,
  inGracePeriod: false,
  currentPaymentId: null,
  invoices: [],
  ...overrides,
});

describe('createSubscription', () => {
  it('should assign a unique sub_ prefixed id', () => {
    const sub = createSubscription(makeSub());
    assert.match(sub.id, /^sub_[0-9a-f-]{36}$/);
  });

  it('should assign different ids on each call', () => {
    const a = createSubscription(makeSub());
    const b = createSubscription(makeSub());
    assert.notEqual(a.id, b.id);
  });

  it('should persist all provided fields', () => {
    const sub = createSubscription(makeSub({ phoneNumber: '87009876543', amount: 1500, billingPeriod: 'weekly' }));
    assert.equal(sub.phoneNumber, '87009876543');
    assert.equal(sub.amount, 1500);
    assert.equal(sub.billingPeriod, 'weekly');
  });

  it('should write subscriptions.json to disk', () => {
    createSubscription(makeSub());
    assert.ok(fs.existsSync(SUBSCRIPTIONS_FILE));
  });

  it('should write valid JSON to subscriptions.json', () => {
    createSubscription(makeSub());
    const raw = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
  });
});

describe('getSubscription', () => {
  it('should return the subscription by id', () => {
    const created = createSubscription(makeSub());
    const found = getSubscription(created.id);
    assert.equal(found.id, created.id);
    assert.equal(found.phoneNumber, created.phoneNumber);
  });

  it('should return null for an unknown id', () => {
    assert.equal(getSubscription('sub_does_not_exist'), null);
  });
});

describe('listSubscriptions', () => {
  it('should return all subscriptions when no filter is given', () => {
    const before = listSubscriptions().length;
    createSubscription(makeSub({ status: 'active' }));
    createSubscription(makeSub({ status: 'paused' }));
    assert.equal(listSubscriptions().length, before + 2);
  });

  it('should filter by status', () => {
    createSubscription(makeSub({ status: 'cancelled' }));
    const cancelled = listSubscriptions({ status: 'cancelled' });
    assert.ok(cancelled.length >= 1);
    assert.ok(cancelled.every((s) => s.status === 'cancelled'));
  });

  it('should not include other statuses when filtering', () => {
    createSubscription(makeSub({ status: 'active' }));
    const expired = listSubscriptions({ status: 'expired' });
    assert.ok(expired.every((s) => s.status === 'expired'));
  });
});

describe('updateSubscription', () => {
  it('should merge updates into the existing subscription', () => {
    const sub = createSubscription(makeSub({ amount: 5000 }));
    const updated = updateSubscription(sub.id, { amount: 9000, status: 'paused' });
    assert.equal(updated.amount, 9000);
    assert.equal(updated.status, 'paused');
  });

  it('should not modify fields that are not in updates', () => {
    const sub = createSubscription(makeSub({ phoneNumber: '87001111111' }));
    updateSubscription(sub.id, { amount: 100 });
    const fetched = getSubscription(sub.id);
    assert.equal(fetched.phoneNumber, '87001111111');
  });

  it('should return null for an unknown id', () => {
    assert.equal(updateSubscription('sub_unknown', { amount: 1 }), null);
  });

  it('should make the updated value visible via getSubscription', () => {
    const sub = createSubscription(makeSub());
    updateSubscription(sub.id, { failedAttempts: 3 });
    assert.equal(getSubscription(sub.id).failedAttempts, 3);
  });

  it('should persist updates to subscriptions.json', () => {
    const sub = createSubscription(makeSub());
    updateSubscription(sub.id, { amount: 7777 });
    const disk = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
    assert.equal(disk[sub.id].amount, 7777);
  });
});
