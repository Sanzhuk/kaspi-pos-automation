# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Node.js service that automates Kaspi Pay POS payments by reverse-engineering the Kaspi Pay mobile app API. It exposes a local REST API for initiating QR and invoice payments, tracks payment status via polling, and delivers results via webhooks.

## Commands

```bash
# Run the server
node server.js
# or
npm start

# Run all tests
npm test

# Run a single test file
node --test test/helpers.test.js

# Lint
npm run lint

# Format
npm run format

# Regenerate device identity (deviceId, installId, pinHash → device.json)
npm run regen:device

# Regenerate ECDSA keypair (keypair.json)
npm run regen:keypair
```

## Required Setup

Copy `.env.example` to `.env` and set:

```
TOKEN_SECRET_KEY=<64-char hex>   # Generate: openssl rand -hex 32
PORT=3000
```

`TOKEN_SECRET_KEY` is used for AES-256-GCM encryption of the Kaspi vtoken secret. The server exits immediately if it is missing.

## Architecture

### Startup flow (`server.js`)

1. Express app mounts routes under `/api/{auth,invoice,qr,history,refund,session}`
2. `startPolling()` is called — begins a 3-second setTimeout loop tracking active payments

### Persistent state files (root directory)

| File | Purpose |
|------|---------|
| `keypair.json` | ECDSA P-256 keypair — auto-generated on first start; used to sign every Kaspi API request |
| `ecdh-keypair.json` | Ephemeral ECDH keypair written during auth, read during refresh (SignInLite) |
| `device.json` | Stable device identity (deviceId, installId, pinHash) — regenerate only intentionally |
| `tracked-payments.json` | In-flight payment state, survives restarts |
| `webhook-retries.json` | Failed webhook deliveries queued for retry |
| `webhooks.json` | Webhook subscriptions (copy from `webhooks.example.json`) |

### Authentication flow (`src/routes/auth.js`)

Multi-step session handshake against `entrance-pay.kaspi.kz`:

1. `POST /api/auth/init` — starts an entrance process, gets `processId`
2. `POST /api/auth/send-phone` — submits phone number, triggers SMS OTP
3. `POST /api/auth/verify-otp` — verifies OTP; on success automatically runs `doFinish()` which:
   - Calls `/api/v1/kpentrance/finish` with an ECDSA-signed payload and ECDH public key
   - Completes ECDH key agreement to derive the vtoken shared secret
   - Encrypts the secret with AES-256-GCM → `vtokenSecret`
   - Fetches org context from `mtoken.kaspi.kz`
   - Returns `{ tokenSN, vtokenSecret, profileId, organizationId, ... }` to the caller
4. `POST /api/auth/refresh` — refreshes session via SignInLite (no SMS needed while tokenSN is valid)

The caller must store `tokenSN`, `vtokenSecret`, and `profileId` and pass them as headers on all payment API calls.

### Session headers (payment routes)

Payment routes (`/api/invoice`, `/api/qr`, `/api/refund`, `/api/history`) require:

```
X-Token-SN: <tokenSN>
X-Vtoken-Secret: <vtokenSecret>
X-Profile-ID: <profileId>
```

### Request signing (`src/crypto.js`, `src/helpers.js`)

Every outbound Kaspi API request is signed:

- `X-Sign` — ECDSA-SHA256 signature over selected headers listed in `X-SH`
- `X-Kb-TokenSnMac` — OCRA-1 TOTP (SHA-256, 6 digits) computed from `tokenSN` + ECDH shared secret
- `X-SU` — MD5 of the lowercase URL

The `signedQrPayHeaders()` helper in `src/helpers.js` assembles all required headers for `qrpay.kaspi.kz` calls.

### Payment polling (`src/polling.js`)

- Runs every 3 seconds (non-overlapping setTimeout)
- Tracks payments in a `Map<paymentId, entry>` mirrored to `tracked-payments.json`
- On each cycle, fetches payment status from Kaspi and maps it to one of three webhook events:
  - `payment.success` — terminal success
  - `payment.failed` — all failure/rejection codes
  - `payment.expired` — TTL exceeded or Kaspi `Expired` status
- Webhook delivery uses HMAC-SHA256 signature in `X-Webhook-Signature` header
- Failed webhooks are retried up to 3 times (5s, then 30s delay) via `webhook-retries.json`

### Kaspi API constants (`src/config.js`)

App version, build number, device model strings (`APP` object) and User-Agent strings are **hardcoded intentionally** — Kaspi validates these and rejects unknown values.

Three base URLs used:
- `https://entrance-pay.kaspi.kz` — auth/login flow
- `https://mtoken.kaspi.kz` — token management and org context
- `https://qrpay.kaspi.kz` — QR and invoice payment operations

### Tests

Tests use Node.js built-in `node:test` runner (no Jest/Mocha). Test files must set `TOKEN_SECRET_KEY` via `process.env` before any dynamic import of source modules. See `test/helpers.test.js` for the pattern.
