import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// polling.js pulls in config → crypto, which needs a token secret key at import.
process.env.TOKEN_SECRET_KEY = 'a'.repeat(64);

const { resolveEvent } = await import('../src/polling.js');

describe('resolveEvent — status → webhook event mapping', () => {
  it('maps known final statuses to terminal events (invoice)', () => {
    assert.equal(resolveEvent('invoice', 'Processed'), 'payment.success');
    assert.equal(resolveEvent('invoice', 'RemotePaymentCanceled'), 'payment.failed');
    assert.equal(resolveEvent('invoice', 'RemotePaymentRejected'), 'payment.failed');
    assert.equal(resolveEvent('invoice', 'Expired'), 'payment.expired');
  });

  it('maps known final statuses to terminal events (qr)', () => {
    assert.equal(resolveEvent('qr', 'Processed'), 'payment.success');
    assert.equal(resolveEvent('qr', 'CancelledByUser'), 'payment.failed');
    assert.equal(resolveEvent('qr', 'Expired'), 'payment.expired');
  });

  it('keeps polling on the explicit intermediate statuses', () => {
    assert.equal(resolveEvent('invoice', 'RemotePaymentCreated'), null);
    assert.equal(resolveEvent('qr', 'QrTokenCreated'), null);
    // "Wait" is a pending status the backend also recognises — it must NOT be
    // treated as a failure for invoices (this is the regression we are fixing).
    assert.equal(resolveEvent('invoice', 'Wait'), null);
    assert.equal(resolveEvent('qr', 'Wait'), null);
  });

  it('does NOT declare a spurious failure for an unrecognised status', () => {
    // The previous `|| "payment.failed"` fallback fired payment.failed here,
    // deleted the tracked payment, and lost the later real Processed status —
    // i.e. the customer paid but access was never granted.
    assert.equal(resolveEvent('invoice', 'SomeFutureKaspiStatus'), null);
    assert.equal(resolveEvent('qr', 'SomeFutureKaspiStatus'), null);
  });
});
