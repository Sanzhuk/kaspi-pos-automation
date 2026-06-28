import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.TOKEN_SECRET_KEY = 'a'.repeat(64);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUBSCRIPTIONS_FILE = path.join(__dirname, '..', 'subscriptions.json');

const { addPeriod, BILLING_PERIODS, handleSubscriptionPaymentResult } = await import(
  '../src/subscriptionScheduler.js'
);
const { createSubscription, getSubscription } = await import('../src/subscriptionStore.js');

after(() => {
  try {
    fs.unlinkSync(SUBSCRIPTIONS_FILE);
  } catch {}
});

// ─── Helpers ───

const makeActiveSub = (overrides = {}) =>
  createSubscription({
    phoneNumber: '87001234567',
    amount: 5000,
    billingPeriod: 'monthly',
    status: 'active',
    sessionHeaders: { tokenSN: 'TSN', vtokenSecret: 'enc', profileId: 'P1' },
    nextBillingAt: new Date().toISOString(),
    lastBilledAt: null,
    failedAttempts: 0,
    inGracePeriod: false,
    gracePeriodStartedAt: null,
    currentPaymentId: 'pay_123',
    billingStartedAt: new Date().toISOString(),
    invoices: [],
    ...overrides,
  });

// ─── addPeriod ───

describe('addPeriod', () => {
  const base = '2026-01-15T12:00:00.000Z';

  it('daily: adds exactly 1 day', () => {
    const result = addPeriod(base, 'daily');
    assert.equal(result.slice(0, 10), '2026-01-16');
  });

  it('weekly: adds exactly 7 days', () => {
    const result = addPeriod(base, 'weekly');
    assert.equal(result.slice(0, 10), '2026-01-22');
  });

  it('biweekly: adds exactly 14 days', () => {
    const result = addPeriod(base, 'biweekly');
    assert.equal(result.slice(0, 10), '2026-01-29');
  });

  it('monthly: advances by 1 calendar month', () => {
    const result = addPeriod(base, 'monthly');
    assert.equal(result.slice(0, 10), '2026-02-15');
  });

  it('quarterly: advances by 3 calendar months', () => {
    const result = addPeriod(base, 'quarterly');
    assert.equal(result.slice(0, 10), '2026-04-15');
  });

  it('yearly: advances by 1 calendar year', () => {
    const result = addPeriod(base, 'yearly');
    assert.equal(result.slice(0, 10), '2027-01-15');
  });

  it('returns an ISO string', () => {
    const result = addPeriod(base, 'monthly');
    assert.ok(!isNaN(Date.parse(result)));
  });

  it('does not mutate the input date', () => {
    const frozen = '2026-06-01T00:00:00.000Z';
    addPeriod(frozen, 'monthly');
    assert.equal(frozen, '2026-06-01T00:00:00.000Z');
  });

  it('handles month-end overflow (Jan 31 + 1 month → Mar 3, JS Date roll-over)', () => {
    // JS Date rolls Jan 31 + 1 month to March 3 (Feb has 28 days, 31-28=3)
    const result = addPeriod('2026-01-31T00:00:00.000Z', 'monthly');
    assert.equal(result.slice(0, 10), '2026-03-03');
  });
});

// ─── BILLING_PERIODS ───

describe('BILLING_PERIODS', () => {
  it('contains all expected periods', () => {
    for (const p of ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']) {
      assert.ok(BILLING_PERIODS.has(p), `missing period: ${p}`);
    }
  });

  it('contains exactly 6 periods', () => {
    assert.equal(BILLING_PERIODS.size, 6);
  });
});

// ─── handleSubscriptionPaymentResult — success ───

describe('handleSubscriptionPaymentResult: payment.success', () => {
  it('should clear currentPaymentId and billingStartedAt', () => {
    const sub = makeActiveSub();
    handleSubscriptionPaymentResult(sub.id, 'payment.success', { Status: 'Processed' });
    const updated = getSubscription(sub.id);
    assert.equal(updated.currentPaymentId, null);
    assert.equal(updated.billingStartedAt, null);
  });

  it('should reset failedAttempts and inGracePeriod', () => {
    const sub = makeActiveSub({ failedAttempts: 2, inGracePeriod: false });
    handleSubscriptionPaymentResult(sub.id, 'payment.success', { Status: 'Processed' });
    const updated = getSubscription(sub.id);
    assert.equal(updated.failedAttempts, 0);
    assert.equal(updated.inGracePeriod, false);
  });

  it('should set lastBilledAt to a recent timestamp', () => {
    const before = Date.now();
    const sub = makeActiveSub();
    handleSubscriptionPaymentResult(sub.id, 'payment.success', { Status: 'Processed' });
    const updated = getSubscription(sub.id);
    const billedMs = new Date(updated.lastBilledAt).getTime();
    assert.ok(billedMs >= before, 'lastBilledAt should be at or after test start');
    assert.ok(billedMs <= Date.now(), 'lastBilledAt should not be in the future');
  });

  it('should set nextBillingAt to approximately 1 month from now for monthly subs', () => {
    const sub = makeActiveSub({ billingPeriod: 'monthly' });
    handleSubscriptionPaymentResult(sub.id, 'payment.success', { Status: 'Processed' });
    const updated = getSubscription(sub.id);
    const diff = new Date(updated.nextBillingAt).getTime() - Date.now();
    const oneMonthMs = 28 * 24 * 60 * 60 * 1000;
    assert.ok(diff > oneMonthMs, 'nextBillingAt should be more than 28 days away');
  });

  it('should append a success entry to invoices', () => {
    const sub = makeActiveSub();
    handleSubscriptionPaymentResult(sub.id, 'payment.success', { Status: 'Processed' });
    const updated = getSubscription(sub.id);
    assert.equal(updated.invoices.length, 1);
    assert.equal(updated.invoices[0].status, 'success');
    assert.equal(updated.invoices[0].paymentId, 'pay_123');
  });
});

// ─── handleSubscriptionPaymentResult — failure (under max) ───

describe('handleSubscriptionPaymentResult: payment.failed (under max attempts)', () => {
  it('should increment failedAttempts', () => {
    const sub = makeActiveSub({ failedAttempts: 0 });
    handleSubscriptionPaymentResult(sub.id, 'payment.failed', { Status: 'InsufficientFunds' });
    assert.equal(getSubscription(sub.id).failedAttempts, 1);
  });

  it('should clear currentPaymentId', () => {
    const sub = makeActiveSub({ failedAttempts: 0 });
    handleSubscriptionPaymentResult(sub.id, 'payment.failed', { Status: 'InsufficientFunds' });
    assert.equal(getSubscription(sub.id).currentPaymentId, null);
  });

  it('should schedule retry ~24h from now', () => {
    const sub = makeActiveSub({ failedAttempts: 1 });
    const before = Date.now();
    handleSubscriptionPaymentResult(sub.id, 'payment.failed', { Status: 'Rejected' });
    const updated = getSubscription(sub.id);
    const retryMs = new Date(updated.nextBillingAt).getTime();
    const diff = retryMs - before;
    const twentyFourH = 24 * 60 * 60 * 1000;
    assert.ok(diff >= twentyFourH - 1000, 'retry should be ~24h from now');
    assert.ok(diff < twentyFourH + 5000, 'retry should not be much more than 24h');
  });

  it('should not set inGracePeriod when under max attempts', () => {
    const sub = makeActiveSub({ failedAttempts: 0 });
    handleSubscriptionPaymentResult(sub.id, 'payment.failed', { Status: 'Rejected' });
    assert.equal(getSubscription(sub.id).inGracePeriod, false);
  });

  it('should append a failed entry to invoices', () => {
    const sub = makeActiveSub({ failedAttempts: 1, invoices: [] });
    handleSubscriptionPaymentResult(sub.id, 'payment.failed', { Status: 'Rejected' });
    const updated = getSubscription(sub.id);
    assert.equal(updated.invoices.length, 1);
    assert.equal(updated.invoices[0].status, 'failed');
  });
});

// ─── handleSubscriptionPaymentResult — grace period trigger ───

describe('handleSubscriptionPaymentResult: payment.failed (at max attempts → grace period)', () => {
  it('should set inGracePeriod to true when failedAttempts reaches max', () => {
    // failedAttempts = 2, so after this failure it becomes 3 = MAX_FAILED_ATTEMPTS
    const sub = makeActiveSub({ failedAttempts: 2 });
    handleSubscriptionPaymentResult(sub.id, 'payment.failed', { Status: 'InsufficientFunds' });
    assert.equal(getSubscription(sub.id).inGracePeriod, true);
  });

  it('should set gracePeriodStartedAt to a recent timestamp', () => {
    const before = Date.now();
    const sub = makeActiveSub({ failedAttempts: 2 });
    handleSubscriptionPaymentResult(sub.id, 'payment.failed', { Status: 'InsufficientFunds' });
    const updated = getSubscription(sub.id);
    const gpMs = new Date(updated.gracePeriodStartedAt).getTime();
    assert.ok(gpMs >= before);
    assert.ok(gpMs <= Date.now());
  });

  it('should record failedAttempts = 3 in the subscription', () => {
    const sub = makeActiveSub({ failedAttempts: 2 });
    handleSubscriptionPaymentResult(sub.id, 'payment.failed', { Status: 'InsufficientFunds' });
    assert.equal(getSubscription(sub.id).failedAttempts, 3);
  });

  it('should still append a failed invoice entry', () => {
    const sub = makeActiveSub({ failedAttempts: 2, invoices: [] });
    handleSubscriptionPaymentResult(sub.id, 'payment.failed', { Status: 'InsufficientFunds' });
    const updated = getSubscription(sub.id);
    assert.equal(updated.invoices.length, 1);
    assert.equal(updated.invoices[0].status, 'failed');
  });
});

// ─── handleSubscriptionPaymentResult — unknown subscription ───

describe('handleSubscriptionPaymentResult: unknown subscriptionId', () => {
  it('should not throw for an unknown subscriptionId', () => {
    assert.doesNotThrow(() => {
      handleSubscriptionPaymentResult('sub_does_not_exist', 'payment.success', { Status: 'Processed' });
    });
  });
});

// ─── handleSubscriptionPaymentResult — payment.expired treated as failure ───

describe('handleSubscriptionPaymentResult: payment.expired', () => {
  it('should increment failedAttempts same as a failed payment', () => {
    const sub = makeActiveSub({ failedAttempts: 0 });
    handleSubscriptionPaymentResult(sub.id, 'payment.expired', { Status: 'Expired' });
    assert.equal(getSubscription(sub.id).failedAttempts, 1);
  });

  it('should clear currentPaymentId', () => {
    const sub = makeActiveSub({ failedAttempts: 0 });
    handleSubscriptionPaymentResult(sub.id, 'payment.expired', { Status: 'Expired' });
    assert.equal(getSubscription(sub.id).currentPaymentId, null);
  });
});
