# Security baseline

Status: initial scaffold; only public GET health is implemented. The following
requirements are mandatory acceptance gates for future authenticated features,
not a claim that those features already exist.

- Firebase Admin runs only in backend functions; never bundle it into member or backoffice UI.
- Each future authenticated endpoint must verify the Firebase ID Token with Firebase Admin,
  including revocation for sensitive operations. Missing/invalid/revoked tokens fail closed.
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
- Sensitive administrative actions require durable audit records with actor, action, target,
  outcome, timestamp, and correlation ID. Never log tokens, keys, or raw sensitive payloads.
- Validate inputs, bound payload sizes, apply rate limits, and use explicit origin allowlists.
  CORS is not authentication. Trust no role, wallet amount, or authorization decision from UI.
- Secrets come from Netlify environment settings or managed secret storage. Never commit
  secrets, service-account JSON, private keys, or .env files. No credentials are provisioned here.

This stage intentionally has no authenticated routes, Firebase initialization,
wallet/payment/game logic, database writes, or administrative operations.
