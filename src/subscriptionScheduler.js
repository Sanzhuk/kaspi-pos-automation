import fetch from 'node-fetch';
import { KASPI_QRPAY_URL } from './config.js';
import { signedQrPayHeaders } from './helpers.js';
import { decryptSecret } from './crypto.js';
import { getWebhooksByEvent } from './webhookStore.js';
import { trackPayment, sendWebhooks } from './polling.js';
import { getSubscription, updateSubscription, listSubscriptions, loadSubscriptions } from './subscriptionStore.js';
import { logger } from './logger.js';

// ─── Constants ───

const BILLING_PERIODS = new Set(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']);
export { BILLING_PERIODS };

const MAX_FAILED_ATTEMPTS = 3;
const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const PAYMENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const SCHEDULER_INTERVAL_MS = 60 * 1000; // 1 minute

// ─── Date arithmetic ───

export const addPeriod = (isoDate, period) => {
  const d = new Date(isoDate);
  switch (period) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'biweekly':
      d.setDate(d.getDate() + 14);
      break;
    case 'monthly':
      d.setMonth(d.getMonth() + 1);
      break;
    case 'quarterly':
      d.setMonth(d.getMonth() + 3);
      break;
    case 'yearly':
      d.setFullYear(d.getFullYear() + 1);
      break;
    default:
      d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString();
};

// ─── Webhook delivery ───

const sendSubscriptionWebhook = (event, sub, extra = {}) => {
  const payload = {
    event,
    subscriptionId: sub.id,
    phoneNumber: sub.phoneNumber,
    amount: sub.amount,
    billingPeriod: sub.billingPeriod,
    status: sub.status,
    ...extra,
    timestamp: new Date().toISOString(),
  };
  sendWebhooks(event, payload);
};

// ─── Create Kaspi invoice for a subscription billing cycle ───

const createSubscriptionInvoice = async (sub) => {
  let decryptedSecret;
  try {
    decryptedSecret = decryptSecret(sub.sessionHeaders.vtokenSecret);
  } catch {
    logger.error('SUBSCRIPTION', `sub ${sub.id}: failed to decrypt session — re-authenticate`);
    return { error: 'session_expired' };
  }

  const session = {
    tokenSN: sub.sessionHeaders.tokenSN,
    decryptedSecret,
    profileId: sub.sessionHeaders.profileId,
  };

  const url = `${KASPI_QRPAY_URL}/v01/remote/create`;
  const headers = { ...signedQrPayHeaders(url, session), 'Content-Type': 'application/json' };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        PhoneNumber: sub.phoneNumber,
        Amount: Number(sub.amount),
        Comment: sub.comment || '',
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return await resp.json();
  } catch (err) {
    logger.error('SUBSCRIPTION', `sub ${sub.id}: invoice creation failed`, err.message);
    return { error: err.message };
  }
};

// ─── Handle a resolved subscription payment ───

export const handleSubscriptionPaymentResult = (subscriptionId, event, data) => {
  const sub = getSubscription(subscriptionId);
  if (!sub) {
    logger.warn('SUBSCRIPTION', `Received result for unknown subscription ${subscriptionId}`);
    return;
  }

  const invoiceEntry = {
    paymentId: sub.currentPaymentId,
    amount: sub.amount,
    status: event === 'payment.success' ? 'success' : 'failed',
    billedAt: sub.billingStartedAt,
    resolvedAt: new Date().toISOString(),
    kaspiStatus: data?.Status || '',
    kaspiStatusDesc: data?.StatusDesc || '',
  };

  const invoices = [...(sub.invoices || []), invoiceEntry];

  if (event === 'payment.success') {
    const updated = updateSubscription(subscriptionId, {
      currentPaymentId: null,
      billingStartedAt: null,
      failedAttempts: 0,
      inGracePeriod: false,
      gracePeriodStartedAt: null,
      lastBilledAt: new Date().toISOString(),
      nextBillingAt: addPeriod(new Date().toISOString(), sub.billingPeriod),
      invoices,
    });
    logger.info('SUBSCRIPTION', `sub ${subscriptionId}: payment succeeded, next billing at ${updated.nextBillingAt}`);
    sendSubscriptionWebhook('subscription.payment_succeeded', updated, {
      paymentId: invoiceEntry.paymentId,
      receiptUrl: data?.ReceiptUrl || null,
    });
    return;
  }

  // payment.failed or payment.expired
  const failedAttempts = (sub.failedAttempts || 0) + 1;
  const updates = {
    currentPaymentId: null,
    billingStartedAt: null,
    failedAttempts,
    invoices,
  };

  if (!sub.inGracePeriod && failedAttempts >= MAX_FAILED_ATTEMPTS) {
    updates.inGracePeriod = true;
    updates.gracePeriodStartedAt = new Date().toISOString();
    const updated = updateSubscription(subscriptionId, updates);
    logger.warn('SUBSCRIPTION', `sub ${subscriptionId}: max failures reached, grace period started`);
    sendSubscriptionWebhook('subscription.payment_failed', updated, {
      failedAttempts,
      kaspiStatus: data?.Status,
    });
    sendSubscriptionWebhook('subscription.grace_period_started', updated, {
      gracePeriodEndsAt: new Date(Date.now() + GRACE_PERIOD_MS).toISOString(),
    });
  } else {
    // Retry in 24 hours
    updates.nextBillingAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const updated = updateSubscription(subscriptionId, updates);
    logger.warn(`SUBSCRIPTION`, `sub ${subscriptionId}: payment failed (attempt ${failedAttempts}), retry at ${updated.nextBillingAt}`);
    sendSubscriptionWebhook('subscription.payment_failed', updated, {
      failedAttempts,
      kaspiStatus: data?.Status,
    });
  }
};

// ─── Check for grace period expiries ───

const checkGracePeriodExpiries = () => {
  const now = Date.now();
  const inGrace = listSubscriptions().filter((s) => s.status === 'active' && s.inGracePeriod && s.gracePeriodStartedAt);

  for (const sub of inGrace) {
    const started = new Date(sub.gracePeriodStartedAt).getTime();
    if (now - started >= GRACE_PERIOD_MS) {
      const updated = updateSubscription(sub.id, { status: 'expired' });
      logger.warn('SUBSCRIPTION', `sub ${sub.id}: grace period expired — subscription terminated`);
      sendSubscriptionWebhook('subscription.expired', updated);
    }
  }
};

// ─── Scheduler tick ───

const tick = async () => {
  checkGracePeriodExpiries();

  const now = Date.now();
  const candidates = listSubscriptions().filter(
    (s) =>
      s.status === 'active' &&
      !s.inGracePeriod &&
      !s.currentPaymentId &&
      s.nextBillingAt &&
      new Date(s.nextBillingAt).getTime() <= now,
  );

  // Detect stuck payments (currentPaymentId set but billing started > PAYMENT_TIMEOUT_MS ago)
  const stuck = listSubscriptions().filter((s) => s.status === 'active' && s.currentPaymentId && s.billingStartedAt);
  for (const sub of stuck) {
    const elapsed = now - new Date(sub.billingStartedAt).getTime();
    if (elapsed > PAYMENT_TIMEOUT_MS) {
      logger.warn('SUBSCRIPTION', `sub ${sub.id}: payment ${sub.currentPaymentId} timed out after 30min`);
      handleSubscriptionPaymentResult(sub.id, 'payment.failed', {
        Status: 'Timeout',
        StatusDesc: 'Payment tracking timed out',
      });
    }
  }

  for (const sub of candidates) {
    logger.info('SUBSCRIPTION', `sub ${sub.id}: billing due, creating invoice for ${sub.phoneNumber}`);

    const kaspiResp = await createSubscriptionInvoice(sub);

    if (kaspiResp.error) {
      handleSubscriptionPaymentResult(sub.id, 'payment.failed', {
        Status: 'InvoiceCreationFailed',
        StatusDesc: kaspiResp.error,
      });
      continue;
    }

    const d = kaspiResp.Data;
    if (!d || !d.Id || d.Status !== 'RemotePaymentCreated') {
      logger.error('SUBSCRIPTION', `sub ${sub.id}: unexpected Kaspi response`, kaspiResp);
      handleSubscriptionPaymentResult(sub.id, 'payment.failed', {
        Status: 'UnexpectedResponse',
        StatusDesc: JSON.stringify(kaspiResp),
      });
      continue;
    }

    updateSubscription(sub.id, {
      currentPaymentId: String(d.Id),
      billingStartedAt: new Date().toISOString(),
    });

    trackPayment(
      d.Id,
      'invoice',
      {
        tokenSN: sub.sessionHeaders.tokenSN,
        vtokenSecret: sub.sessionHeaders.vtokenSecret,
        profileId: sub.sessionHeaders.profileId,
      },
      {
        amount: d.Amount,
        subscriptionId: sub.id,
        clientMobile: d.ClientMobile,
        receiptUrl: d.ReceiptUrl,
        orderNumber: d.OrderNumber,
      },
    );

    logger.info('SUBSCRIPTION', `sub ${sub.id}: invoice ${d.Id} created, tracking payment`);
  }
};

// ─── Start / stop ───

let schedulerTimer = null;

export const startSubscriptionScheduler = () => {
  if (schedulerTimer) return;

  loadSubscriptions();

  const run = async () => {
    try {
      await tick();
    } catch (err) {
      logger.error('SUBSCRIPTION', 'Unexpected scheduler error', err.message);
    }
    schedulerTimer = setTimeout(run, SCHEDULER_INTERVAL_MS);
  };

  schedulerTimer = setTimeout(run, SCHEDULER_INTERVAL_MS);
  logger.info('SUBSCRIPTION', 'Scheduler started (interval: 60s)');
};

export const stopSubscriptionScheduler = () => {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  logger.info('SUBSCRIPTION', 'Scheduler stopped');
};
