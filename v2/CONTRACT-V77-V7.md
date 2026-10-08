# Member V77 / Backoffice V7 contract baseline

## Target API contract

Member endpoints:
- `POST /api/auth/register` and `POST /api/auth/login` — V2 returns a server-managed bearer session token.
- `POST /api/auth/logout`, `POST /api/auth/refresh`, `GET /api/me`
- `GET|POST /api/member-session`, `POST /api/member-device-session`
- `GET|PUT /api/member-profile`, `POST /api/member-onboarding`
- `GET|PUT /api/member-bank-account`
- `GET /api/member-config`, `GET /api/member-rewards`
- `GET /api/games`, `POST /api/game-launch`, `GET /api/promotions`
- `GET /api/transactions`, `GET /api/wallet`
- `POST /api/payment-deposit`, `POST /api/payment-withdraw`

Backoffice endpoints:
- `GET /api/backoffice-health`, `GET /api/backoffice-readiness`
- `GET /api/backoffice-dashboard`, `GET|POST /api/backoffice-members`
- `GET /api/backoffice-finance`, `GET /api/backoffice-ledger`, `POST /api/backoffice-ledger/adjust`
- `GET|POST /api/backoffice-game-catalog`, `GET|POST /api/backoffice-game-display`
- `GET|POST /api/backoffice-provider`
- `GET|POST /api/backoffice-payment-connections`
- `GET|POST /api/backoffice-promotions`, `GET|POST /api/backoffice-promotions-content`
- `GET|POST /api/backoffice-rewards`
- `GET|POST /api/backoffice-reports`, `GET /api/backoffice-audit`
- `GET|POST /api/backoffice-website-settings`, `GET|POST /api/backoffice-settings`
- `GET|POST /api/backoffice-master-control`, `GET|POST /api/backoffice-permissions`
- `POST /api/bootstrap-superadmin`

Provider and payment callbacks:
- `POST /api/provider/callback`
- `POST /webhooks/xendit/payment`, `POST /webhooks/xendit/payout`

## Critical compatibility status

The checked-in XML files in this branch are currently named `BRANDALBET_MEMBER_V76_1_STABLE_CLOUDFLARE.xml` and `BRANDALBET_BACKOFFICE_V4_CLOUDFLARE_FIREBASE_PRODUCTION.xml`. They still use the legacy Cloudflare/Firebase authentication flow. They have **not** been migrated to the V2 Node/MySQL bearer-session contract, and they are not compatible with V2 simply by changing the API base URL.

Before cutover, migrate both XML clients so login/register/logout and every protected request use the V2 session token; remove Firebase ID-token assumptions for backend authorization; verify every request/response shape and run browser/device tests. Keep the existing production Worker and live XML unchanged until this is completed.

## Acceptance rules

An endpoint is not production-ready merely because it returns HTTP 200. It must have correct authorization, validation, persistence, idempotency, callback verification and reconciliation. Payment and reward flows must not return fake success or update wallet balances before a verified settlement. Per-member RTP overrides remain disabled to protect fair game odds. Real-money readiness stays false until provider staging, payment webhooks, reversal/idempotency, XML compatibility and regulatory/provider approval are verified.
