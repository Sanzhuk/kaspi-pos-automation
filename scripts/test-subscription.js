#!/usr/bin/env node
/**
 * End-to-end subscription test for tralala@gmail.com
 *
 * Usage:
 *   KASPI_POS_API_KEY=<key> node scripts/test-subscription.js
 *
 * The script authenticates interactively (asks for OTP), creates a
 * subscription, waits for the first payment to complete, then immediately
 * triggers a second one — simulating a 5-minute recurring cycle.
 *
 * Requires the server to be running:  node server.js
 */

import readline from 'readline/promises';
import { stdin, stdout } from 'process';

// ─── Config ─────────────────────────────────────────────────────────────────

const BASE = `http://localhost:${process.env.PORT || 3000}`;

// Merchant phone (Kaspi account that authenticates and sends invoices)
const MERCHANT_PHONE = '77773997075';

// Customer phone that will receive the Kaspi payment notification
// tralala@gmail.com — using merchant's own phone for self-test
const CUSTOMER_PHONE = '77773997075';

const AMOUNT = 100; // KZT — keep small for testing
const BILLING_PERIOD = 'monthly';

const API_KEY = process.env.KASPI_POS_API_KEY;
if (!API_KEY) {
  console.error('❌  KASPI_POS_API_KEY env var is not set.');
  console.error('    Run:  KASPI_POS_API_KEY=<your-key> node scripts/test-subscription.js');
  process.exit(1);
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

const headers = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };

const api = async (method, path, body) => {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`${method} ${path} → HTTP ${resp.status}: ${JSON.stringify(json)}`);
  }
  return json;
};

// ─── Polling helper ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const poll = async (label, fn, { intervalMs = 5000, timeoutMs = 180000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null && result !== undefined && result !== false) return result;
    process.stdout.write(`  ⏳  ${label}...\r`);
    await sleep(intervalMs);
  }
  throw new Error(`Timed out (${timeoutMs / 1000}s) waiting for: ${label}`);
};

// ─── Formatting helpers ──────────────────────────────────────────────────────

const sep = (title) => console.log(`\n${'─'.repeat(50)}\n  ${title}\n${'─'.repeat(50)}`);
const ok = (msg) => console.log(`  ✅  ${msg}`);
const info = (k, v) => console.log(`  ${k.padEnd(18)} ${v}`);

// ─── Step 1: Verify server is up ─────────────────────────────────────────────

const checkServer = async () => {
  try {
    const resp = await fetch(`${BASE}/health`);
    if (!resp.ok) throw new Error();
  } catch {
    console.error(`❌  Server not reachable at ${BASE}`);
    console.error('    Start it first:  node server.js');
    process.exit(1);
  }
};

// ─── Step 2: Full auth flow ───────────────────────────────────────────────────

const authenticate = async (rl) => {
  sep('Step 1 — Kaspi Auth');

  const { processId } = await api('POST', '/api/auth/init', {});
  if (!processId) throw new Error('Auth init failed — no processId returned');
  info('processId:', processId);

  const phoneResp = await api('POST', '/api/auth/send-phone', { phoneNumber: MERCHANT_PHONE, processId });
  if (!phoneResp.success) throw new Error(`send-phone failed: ${JSON.stringify(phoneResp)}`);
  console.log(`  SMS sent to +${MERCHANT_PHONE} — check your Kaspi app or SMS`);

  const otp = await rl.question('\n  Enter OTP: ');

  const session = await api('POST', '/api/auth/verify-otp', { otp: otp.trim(), processId });
  if (!session.success || !session.tokenSN) throw new Error(`OTP verify failed: ${JSON.stringify(session)}`);

  ok('Authenticated');
  info('tokenSN:', session.tokenSN);
  info('profileId:', session.profileId);

  // Attach session credentials to all subsequent requests
  headers['x-token-sn'] = session.tokenSN;
  headers['x-vtoken-secret'] = session.vtokenSecret;
  headers['x-profile-id'] = String(session.profileId);

  return session;
};

// ─── Step 3: Create subscription ─────────────────────────────────────────────

const createSub = async () => {
  sep('Step 2 — Create Subscription');

  const sub = await api('POST', '/api/subscriptions', {
    phoneNumber: CUSTOMER_PHONE,
    amount: AMOUNT,
    billingPeriod: BILLING_PERIOD,
    comment: 'Test subscription — tralala@gmail.com',
  });

  ok('Subscription created');
  info('id:', sub.id);
  info('phone:', `+${sub.phoneNumber}`);
  info('amount:', `${sub.amount} KZT`);
  info('period:', sub.billingPeriod);
  info('first billing:', sub.nextBillingAt);

  return sub;
};

// ─── Wait for a payment cycle to complete ────────────────────────────────────

const waitForPayment = async (subId, expectedInvoiceCount) => {
  // 1. Wait for invoice to be created (currentPaymentId appears)
  const withInvoice = await poll(
    'waiting for invoice to be created (scheduler fires in ≤60s)',
    async () => {
      const s = await api('GET', `/api/subscriptions/${subId}`);
      return s.currentPaymentId ? s : null;
    },
    { intervalMs: 4000, timeoutMs: 120000 },
  );
  console.log(`\n  📨  Invoice ${withInvoice.currentPaymentId} sent → approve in Kaspi app`);

  // 2. Wait for payment to resolve (currentPaymentId clears, new invoice entry appears)
  const resolved = await poll(
    'waiting for customer to approve payment',
    async () => {
      const s = await api('GET', `/api/subscriptions/${subId}`);
      const inv = await api('GET', `/api/subscriptions/${subId}/invoices`);
      return inv.length >= expectedInvoiceCount && s.currentPaymentId === null ? { sub: s, invoices: inv } : null;
    },
    { intervalMs: 4000, timeoutMs: 300000 },
  );

  return resolved;
};

// ─── Print invoice table ──────────────────────────────────────────────────────

const printInvoices = (invoices) => {
  console.log(`\n  Billing history (${invoices.length} entry/entries):`);
  invoices.forEach((inv, i) => {
    const status = inv.status === 'success' ? '✅ SUCCESS' : '❌ FAILED ';
    console.log(`    #${i + 1}  ${status}  id=${inv.paymentId}  billed=${inv.billedAt?.slice(0, 19)}Z`);
  });
};

// ─── Main ─────────────────────────────────────────────────────────────────────

const run = async () => {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    await checkServer();
    await authenticate(rl);
    rl.close();

    const sub = await createSub();

    // ── Payment 1 ──
    sep('Step 3 — First Payment');
    console.log('  Scheduler fires within 60s and sends an invoice to the customer.');
    console.log(`  Customer (+${CUSTOMER_PHONE}) must approve it in the Kaspi app.\n`);

    const { sub: s1, invoices: inv1 } = await waitForPayment(sub.id, 1);
    console.log();
    ok('First payment resolved!');
    info('lastBilledAt:', s1.lastBilledAt);
    info('nextBillingAt:', s1.nextBillingAt);
    printInvoices(inv1);

    // ── Payment 2 (triggered immediately) ──
    sep('Step 4 — Second Payment (immediate trigger)');
    await api('POST', `/api/subscriptions/${sub.id}/trigger`);
    console.log('  nextBillingAt set to now — scheduler fires in ≤60s.\n');

    const { sub: s2, invoices: inv2 } = await waitForPayment(sub.id, 2);
    console.log();
    ok('Second payment resolved!');
    info('lastBilledAt:', s2.lastBilledAt);
    info('nextBillingAt:', s2.nextBillingAt);
    printInvoices(inv2);

    // ── Summary ──
    sep('Done');
    console.log(`  Subscription ${sub.id} is active.`);
    console.log(`  Next automatic billing at: ${s2.nextBillingAt}\n`);
    console.log(`  To cancel:  curl -X POST ${BASE}/api/subscriptions/${sub.id}/cancel \\`);
    console.log(`                   -H "x-api-key: $KASPI_POS_API_KEY"`);
  } catch (err) {
    console.error(`\n❌  ${err.message}`);
    process.exit(1);
  } finally {
    rl.close();
  }
};

run();
