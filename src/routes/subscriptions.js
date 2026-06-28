import { Router } from 'express';
import { decryptSecret } from '../crypto.js';
import { BILLING_PERIODS, addPeriod } from '../subscriptionScheduler.js';
import {
  createSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription,
} from '../subscriptionStore.js';

const router = Router();

// ─── Auth middleware ───

const requireAuth = (req, res, next) => {
  const tokenSN = req.headers['x-token-sn'];
  const vtokenSecret = req.headers['x-vtoken-secret'];
  if (!tokenSN) return res.status(401).json({ error: 'Missing X-Token-SN header.' });
  if (!vtokenSecret) return res.status(401).json({ error: 'Missing X-Vtoken-Secret header.' });
  try {
    decryptSecret(vtokenSecret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired vtokenSecret. Re-authenticate.' });
  }
  next();
};

// ─── Safe view (strip stored session credentials) ───

const safeView = (sub) => {
  const { sessionHeaders: _s, ...rest } = sub;
  return rest;
};

// ─── List subscriptions ───

router.get('/', (req, res) => {
  const { status } = req.query;
  const all = listSubscriptions(status ? { status } : {});
  res.json(all.map(safeView));
});

// ─── Create subscription ───

router.post('/', requireAuth, (req, res) => {
  const { phoneNumber, amount, billingPeriod, comment, startDate, meta } = req.body;

  if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' });
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0)
    return res.status(400).json({ error: 'amount must be a positive number' });
  if (!billingPeriod || !BILLING_PERIODS.has(billingPeriod))
    return res.status(400).json({ error: `billingPeriod must be one of: ${[...BILLING_PERIODS].join(', ')}` });

  const now = new Date().toISOString();
  const firstBillingAt = startDate ? new Date(startDate).toISOString() : now;

  const sub = createSubscription({
    phoneNumber,
    amount: Number(amount),
    billingPeriod,
    comment: comment || '',
    status: 'active',
    sessionHeaders: {
      tokenSN: req.headers['x-token-sn'],
      vtokenSecret: req.headers['x-vtoken-secret'],
      profileId: req.headers['x-profile-id'] || null,
    },
    nextBillingAt: firstBillingAt,
    lastBilledAt: null,
    failedAttempts: 0,
    inGracePeriod: false,
    gracePeriodStartedAt: null,
    currentPaymentId: null,
    billingStartedAt: null,
    pausedAt: null,
    cancelledAt: null,
    createdAt: now,
    meta: meta || {},
    invoices: [],
  });

  res.status(201).json(safeView(sub));
});

// ─── Get subscription ───

router.get('/:id', (req, res) => {
  const sub = getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  res.json(safeView(sub));
});

// ─── Update subscription ───

router.put('/:id', requireAuth, (req, res) => {
  const sub = getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  if (sub.status === 'cancelled' || sub.status === 'expired')
    return res.status(400).json({ error: `Cannot update a ${sub.status} subscription` });

  const updates = {};

  if (req.body.amount !== undefined) {
    if (isNaN(Number(req.body.amount)) || Number(req.body.amount) <= 0)
      return res.status(400).json({ error: 'amount must be a positive number' });
    updates.amount = Number(req.body.amount);
  }

  if (req.body.billingPeriod !== undefined) {
    if (!BILLING_PERIODS.has(req.body.billingPeriod))
      return res.status(400).json({ error: `billingPeriod must be one of: ${[...BILLING_PERIODS].join(', ')}` });
    updates.billingPeriod = req.body.billingPeriod;
  }

  if (req.body.comment !== undefined) updates.comment = req.body.comment;
  if (req.body.meta !== undefined) updates.meta = req.body.meta;

  // Refresh session credentials if provided
  const tokenSN = req.headers['x-token-sn'];
  const vtokenSecret = req.headers['x-vtoken-secret'];
  const profileId = req.headers['x-profile-id'];
  if (tokenSN && vtokenSecret) {
    updates.sessionHeaders = {
      tokenSN,
      vtokenSecret,
      profileId: profileId || sub.sessionHeaders?.profileId || null,
    };
  }

  const updated = updateSubscription(req.params.id, updates);
  res.json(safeView(updated));
});

// ─── Pause ───

router.post('/:id/pause', (req, res) => {
  const sub = getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  if (sub.status !== 'active') return res.status(400).json({ error: 'Only active subscriptions can be paused' });

  const updated = updateSubscription(req.params.id, {
    status: 'paused',
    pausedAt: new Date().toISOString(),
  });
  res.json(safeView(updated));
});

// ─── Resume ───

router.post('/:id/resume', (req, res) => {
  const sub = getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  if (sub.status !== 'paused') return res.status(400).json({ error: 'Only paused subscriptions can be resumed' });

  const updated = updateSubscription(req.params.id, {
    status: 'active',
    pausedAt: null,
    // Reset grace period + failed attempts so billing resumes cleanly
    inGracePeriod: false,
    gracePeriodStartedAt: null,
    failedAttempts: 0,
    nextBillingAt: addPeriod(new Date().toISOString(), sub.billingPeriod),
  });
  res.json(safeView(updated));
});

// ─── Cancel ───

router.post('/:id/cancel', (req, res) => {
  const sub = getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  if (sub.status === 'cancelled') return res.status(400).json({ error: 'Subscription is already cancelled' });
  if (sub.status === 'expired') return res.status(400).json({ error: 'Subscription is already expired' });

  const updated = updateSubscription(req.params.id, {
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
  });
  res.json(safeView(updated));
});

// ─── Force trigger (testing / manual retry) ───

router.post('/:id/trigger', (req, res) => {
  const sub = getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  if (sub.status !== 'active') return res.status(400).json({ error: 'Only active subscriptions can be triggered' });
  if (sub.currentPaymentId) return res.status(409).json({ error: 'A payment is already in progress', paymentId: sub.currentPaymentId });

  const updated = updateSubscription(req.params.id, {
    nextBillingAt: new Date().toISOString(),
    inGracePeriod: false,
    gracePeriodStartedAt: null,
    failedAttempts: 0,
  });
  res.json({ message: 'Next billing scheduled immediately — will fire on next scheduler tick (≤60s)', subscription: safeView(updated) });
});

// ─── Billing history ───

router.get('/:id/invoices', (req, res) => {
  const sub = getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  res.json(sub.invoices || []);
});

export default router;
