# BrandalBet Backend V2 — Dewacloud

This branch is the isolated Node.js + MySQL implementation. `main` remains unchanged.

## Runtime
- Node.js 22+
- MySQL 8.4
- Start: `npm start`
- Migration: `npm run migrate`
- Health: `GET /api/health`
- Readiness: `GET /api/readiness`

## Dewacloud environment variables
Required:
- `DATABASE_URL`
- `CORS_ORIGINS`
- `MEMBER_ORIGINS`
- `BACKOFFICE_ORIGINS`

Provider:
- `GOLDSLOTPALASE_API_BASE=https://agent.goldslotpalase.com`
- `GOLDSLOTPALASE_API_TOKEN`
- `GOLDSLOTPALASE_CALLBACK_TOKEN`

Payment vault:
- `PAYMENT_VAULT_KEY`: base64 encoding of exactly 32 random bytes.
- Payment provider API variables stay empty until the official gateway API contract and credentials are supplied.

## First deployment
1. Create MySQL CE 8.4.11 in the Dewacloud environment.
2. Create database `brandalbet` and an application user with database-only privileges.
3. Set `DATABASE_URL` on the Node.js application.
4. Deploy branch `backend-v2-node-mysql`.
5. Run `npm install`.
6. Run `npm run migrate`.
7. Run `npm start` through the Node.js application/process manager.
8. Verify `/api/health` and `/api/readiness`.

Do not point the live Blogger XML at this backend until these checks pass.

## Security
- Provider and payment credentials never belong in Blogger.
- Provider callbacks require `Callback-Token`.
- Wallet changes use database transactions and row locks.
- Provider/payment events are idempotent.
- Payment credentials stored through the backoffice are encrypted at rest with AES-256-GCM.
- Withdrawal holds are written to wallet ledger atomically.
- Superadmin bootstrap requires `X-Bootstrap-Token` and is single-use.
