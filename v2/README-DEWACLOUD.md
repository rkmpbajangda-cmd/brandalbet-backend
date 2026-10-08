# BrandalBet Backend V2 — Dewacloud

This is an isolated Node.js + MySQL implementation on `backend-v2-node-mysql`. The `main` branch remains unchanged. This branch is **not approved for production cutover**.

## Runtime
- Node.js 22+
- MySQL 8.4
- Start: `npm start`
- Migration: `npm run migrate`
- Liveness/database health: `GET /api/health`
- Readiness diagnostics: `GET /api/readiness`

## Required environment
- `DATABASE_URL`
- `CORS_ORIGINS`
- `MEMBER_ORIGINS`
- `BACKOFFICE_ORIGINS`
- `BOOTSTRAP_SUPERADMIN_TOKEN` for one-time bootstrap only

## GoldslotPalase
- `GOLDSLOTPALASE_API_BASE=https://agent.goldslotpalase.com`
- `GOLDSLOTPALASE_API_TOKEN`
- `GOLDSLOTPALASE_CALLBACK_TOKEN`

## Xendit
- `XENDIT_API_KEY`
- `XENDIT_WEBHOOK_TOKEN`
- `XENDIT_API_VERSION` (default is set in config)
- `XENDIT_DEFAULT_CHANNEL`
- `XENDIT_BANK_ROUTING_TYPE` must remain empty unless the exact routing type is confirmed for the supported destination bank. Do not use a blanket SWIFT fallback.
- `PAYMENT_VAULT_KEY`: base64 encoding of exactly 32 random bytes if backoffice payment credentials are stored.

Credentials must stay server-side and must never be placed in Blogger XML.

## First deployment to a non-production environment
1. Create MySQL CE 8.4.11 and a database-only application user.
2. Set environment variables in Dewacloud.
3. Deploy this branch to a staging instance, not the live member site.
4. Run `npm install` and `npm run migrate`.
5. Verify `GET /api/health`, then authenticated backoffice readiness.
6. Run provider callback, game launch, payment webhook, deposit, withdrawal, replay/idempotency, reversal and wallet reconciliation tests using provider sandbox/test credentials.
7. Verify all MySQL ledger balances against provider settlement reports before considering a production cutover.

## Known cutover blockers
- The repository's checked-in Blogger XML files still use the legacy Cloudflare/Firebase auth flow. They have **not** been migrated to the V2 bearer session contract; do not point those XML files at this backend yet.
- End-to-end tests against real GoldslotPalase staging credentials and Xendit webhooks have not been verified in this repository session.
- Reward/cashback/referral payout settlement remains gated until an authoritative, authenticated settled-round source is verified. The backend must not calculate commissions from wallet transfers or unverified raw activity.
- Per-member RTP overrides are intentionally disabled; game odds must not be manipulated per account.
- Real-money readiness deliberately remains `false` until the integration, reconciliation, and regulatory/provider approval gates are confirmed.
- A successful CI run verifies code/schema checks only; it does not prove provider credentials, payment webhooks, XML compatibility, or production readiness.

## Security
- Sessions are server-side hashed tokens; only token hashes are stored.
- Passwords are Argon2-hashed.
- Wallet movements use transactions, row locks, unique ledger references and reserved-balance checks.
- Provider and payment callbacks require server-side callback tokens and are designed to be idempotent.
- Ambiguous payout timeouts keep funds reserved until the result is reconciled.
- Superadmin bootstrap requires `X-Bootstrap-Token` and is guarded against concurrent duplicate creation.
