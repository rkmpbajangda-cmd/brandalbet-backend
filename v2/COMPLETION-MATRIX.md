# BrandalBet V2 Completion Matrix

Scope: `backend-v2-node-mysql` and the Member V77 / Backoffice V7 Blogger contract.

This document is a delivery checklist, not a claim that features are production-ready. A module is only marked complete after implementation review, automated tests, staging integration tests, and (where applicable) provider reconciliation.

## Current release gate

- [x] Keep the legacy `main` branch isolated from V2 work.
- [x] Keep real-money readiness explicitly disabled until external gates pass.
- [ ] Run and verify the latest V2 CI workflow (syntax, unit tests, MySQL schema migration twice).
- [ ] Deploy a non-production DwaCloud staging instance with Node 22 and MySQL 8.4.
- [ ] Migrate the Member and Backoffice XML from legacy Firebase/Cloudflare auth to the V2 Bearer-session API contract.
- [ ] Verify data migration and reconcile all opening wallet balances and ledger entries.
- [ ] Complete GoldslotPalase sandbox callback, launch, idempotency, cancellation/reversal and settlement tests.
- [ ] Complete Xendit test-mode deposit, payout, webhook replay, timeout, failure and reconciliation tests.
- [ ] Verify backup restoration, monitoring, TLS, CORS allowlists and operational rollback.
- [ ] Obtain required provider, legal and operational approvals before real-money use.

## Module-by-module acceptance checklist

| Module | Present in code/schema | Still required before complete |
| --- | --- | --- |
| Authentication and sessions | Routes and hashed server-side sessions exist | Register/login/logout/refresh contract tests; session expiry/revocation; device policy tests; XML compatibility |
| Member profile and bank details | Profile, onboarding and bank-account routes exist | Input validation; duplicate/primary account behavior; safe account masking; verify each XML request/response |
| Wallet and ledger | Wallet, ledger, row locks and unique references exist | Concurrent debit/credit tests; ledger-to-wallet reconciliation; adjustment approval and audit tests |
| Deposits | Xendit adapter and payment/webhook storage exist | Callback auth, duplicate/out-of-order webhook tests, provider status reconciliation and end-to-end test mode |
| Withdrawals | Reserved balance, password check and payout adapter exist | Success/failure/unknown timeout/replay tests; verify no double debit/release; destination routing validation |
| Games and provider | Catalog sync, launch and callback routes exist | Real sandbox tests for user mapping, game launch, bets, wins, cancel, duplicate IDs, status query and settlement |
| Catalog display controls | Display tables and Backoffice endpoints exist | Validate referenced IDs; verify hidden/visible/order persistence and Member output after reload |
| Promotions and website settings | Routes and tables exist | Validate fields and date windows; test XML rendering and malformed settings behavior |
| Cashback/referrals | Referral tracking and reward policy storage exist | Trusted settled-round source; deterministic weekly calculation; idempotent payout; disputes/reversals; statements and reports |
| Backoffice roles | Role checks and permissions schema exist | Enforce least privilege per endpoint and test forbidden access for every role |
| Audit and reporting | Audit/report endpoints exist | Verify all mutations are audited; CSV correctness/escaping; sensitive fields excluded |
| Operations | Health/readiness and migration script exist | CI proof, staging deployment, backup/restore drill, logs/alerts, rollback and incident procedure |

## Critical implementation issues fixed on the hardening branch

- The game-launch success path referenced an undeclared `gameSymbol` identifier while writing its audit log. The audit metadata now uses the already validated `symbol` value, with a regression test.
- `ensureProviderUser()` did not return the provider account code even though the game-launch handler requires that return value. As a result, game launch could fail after account mapping was successfully created or found. The helper now returns the existing or newly created mapping and has a regression test.

## Contract evidence limitation

The XML files currently checked into this repository are named `BRANDALBET_MEMBER_V76_1_STABLE_CLOUDFLARE.xml` and `BRANDALBET_BACKOFFICE_V4_CLOUDFLARE_FIREBASE_PRODUCTION.xml`. They are not named V77/V7, and they use the legacy Firebase/Cloudflare authentication contract. Do not treat route-name overlap as compatibility. The exact production XML versions must be supplied/audited and migrated to the V2 Bearer-session contract before cutover.

## Rules for marking a feature complete

1. The API contract is documented and matches the Member/Backoffice XML.
2. Validation and authorization are enforced server-side.
3. State changes are transactional and idempotent where retries are possible.
4. Failure, timeout, duplicate and reversal cases are tested.
5. Sensitive credentials never appear in Blogger XML or responses.
6. External payment/provider features pass staging tests and reconciliation.
7. No dummy/fallback data may disguise an unavailable integration.
8. Real-money readiness remains false until all operational and approval gates are explicitly verified.
