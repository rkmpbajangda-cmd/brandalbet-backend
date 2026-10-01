# Security baseline

Status: Firebase Admin / authentication / RBAC foundation implemented. Public health
remains credential-free. Protected routes verify Firebase ID Tokens, backoffice access
requires both the backoffice claim and an allowed role, and bootstrap is disabled unless
explicitly enabled through server-side environment configuration.

- Firebase Admin runs only in backend functions; never bundle it into member or backoffice UI.
- Each authenticated endpoint verifies the Firebase ID Token with Firebase Admin,
  including revocation for protected routes. Missing/invalid/revoked tokens fail closed.
- Authorization uses verified Firebase Custom Claims and explicit per-action permissions.
  Prepared roles: member, operator, finance, admin, superadmin. Unknown/missing roles and
  unlisted actions are denied. No implicit role hierarchy or hardcoded admin UID bypass.
- Apply least privilege to service accounts and operators. Firebase Admin bypasses Firestore
  Rules, so backend authorization and validation remain mandatory. Client database access
  must be deny-by-default; clients cannot write wallets, ledger, claims, or audit records.
- Wallet mutations are server-only, transactional, and coupled to immutable append-only ledger
  entries. Corrections require compensating entries; no ledger edit/delete endpoints.
- Before enabling payment webhooks or game callbacks, implement provider-documented
  authentication/signature verification over original request bytes, constant-time comparisons,
  replay protection, and durable transactional idempotency. Duplicate events cannot credit twice.
  Fail closed when provider configuration is absent. No fake providers or callbacks exist here.
- Protected access emits structured security audit events with actor, action, outcome, timestamp,
  and correlation ID. Before sensitive administrative mutations go live, attach a durable audit
  sink. Never log tokens, keys, or raw sensitive payloads.
- Validate inputs, bound payload sizes, apply rate limits, and use explicit origin allowlists.
  CORS is not authentication. Trust no role, wallet amount, or authorization decision from UI.
- Secrets come from Netlify environment settings or managed secret storage. Never commit
  secrets, service-account JSON, private keys, or .env files. No credentials are provisioned here.

This stage intentionally has no wallet/payment/game logic or provider callbacks.
Firebase Admin initializes lazily from server-side environment values only. Structured
security audit events are emitted without bearer tokens or private keys.
