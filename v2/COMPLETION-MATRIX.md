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
- [ ] Obtain and archive the current GoldslotPalase V4 Swagger/OpenAPI specification or written provider guide; verify launch URL TTL/single-use semantics, player creation, response envelopes, callback auth, transaction/reversal behavior, and balance units.\n- [ ] Complete GoldslotPalase sandbox callback, launch, idempotency, cancellation/reversal and settlement tests.
- [x] Separate catalog refresh from launch: member GET reads MySQL only; provider catalog requests happen on explicit Backoffice sync; launch URL is requested only on the member's Main Game action.
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
| Games and provider | Explicit Backoffice catalog sync; Member GET reads MySQL only; launch endpoint requests URL on Main Game click; provider-user creation deferred to launch | Real sandbox tests for user mapping, game launch, bets, wins, cancel, duplicate IDs, status query and settlement; ensure deployed XML uses these exact routes and generates a new launchRequestId per intentional launch |
| Catalog display controls | Display tables and Backoffice endpoints exist | Validate referenced IDs; verify hidden/visible/order persistence and Member output after reload |
| Promotions and website settings | Routes and tables exist | Validate fields and date windows; test XML rendering and malformed settings behavior |
| Cashback/referrals | Referral tracking and reward policy storage exist | Trusted settled-round source; deterministic weekly calculation; idempotent payout; disputes/reversals; statements and reports |
| Backoffice roles | Role checks and permissions schema exist | Enforce least privilege per endpoint and test forbidden access for every role |
| Audit and reporting | Audit/report endpoints exist | Verify all mutations are audited; CSV correctness/escaping; sensitive fields excluded |
| Operations | Health/readiness and migration script exist | CI proof, staging deployment, backup/restore drill, logs/alerts, rollback and incident procedure |

## Critical implementation issues fixed on the hardening branch

- The game-launch success path referenced an undeclared `gameSymbol` identifier while writing its audit log. The audit metadata now uses the already validated `symbol` value, with a regression test.
- `ensureProviderUser()` did not return the provider account code even though the game-launch handler requires that return value. As a result, game launch could fail after account mapping was successfully created or found. The helper now returns the existing or newly created mapping and has a regression test.
- A post-hardening review found provider-account creation was still called during login; that call is now removed and provider-user creation occurs only in the explicit game-launch handler.
- MySQL numeric boolean values (`0`/`1`) are now handled explicitly for registration, wallet/payment gates, withdrawal-password policy, and provider/game active flags. Regression coverage was added.
- The duplicate `/api/backoffice-provider` `sync` action is now rejected with a clear instruction to use the canonical `/api/backoffice-game-catalog` sync endpoint, preventing the old route from updating games without updating provider records.

## GoldslotPalase contract verification gate

The repository's Goldslot client is server-to-server and keeps the provider token off the browser. Catalog normalization now accepts the observed V4 field names `provider_id`, `provider_name`, `status`, `game_code`, `game_name`, `locale_name`, `game_image_narrow`, `game_image`, and `launch_enable`. Provider status `2` is treated as unavailable for launch (fail-closed); the exact meaning must still be confirmed with the provider's current specification.

**Important:** the official Swagger UI currently fails to load its API definition because `/swagger/v4/swagger.json` returns Not Found. Therefore the following details are not certified from a currently accessible official spec and must not be treated as production-verified:
- whether the returned game URL is single-use, reusable, and/or expires, and its actual TTL;
- whether `/v4/user/create` is required before first launch, and the provider's duplicate-name/idempotency behavior;
- exact launch response envelope and required/optional `/v4/game/game-url` fields;
- status code meanings and provider maintenance semantics;
- callback authentication header, transaction/cancel idempotency, and exact balance units.

Until the provider supplies a working current Swagger/OpenAPI file or written integration guide, do not infer these items from another provider's documentation. Keep live-money readiness disabled and run only mocked tests. The local ten-minute launch expiry is currently an application-side guard, not proof of GoldslotPalase's actual URL expiry.

## Contract evidence limitation

The XML files currently checked into this repository are named `BRANDALBET_MEMBER_V76_1_STABLE_CLOUDFLARE.xml` and `BRANDALBET_BACKOFFICE_V4_CLOUDFLARE_FIREBASE_PRODUCTION.xml`. They are not named V77/V7, and they use the legacy Firebase/Cloudflare authentication contract. Do not treat route-name overlap as compatibility. The exact production XML versions must be supplied/audited and migrated to the V2 Bearer-session contract before cutover.

## V2 game-flow hardening applied on `fix/v2-goldslot-game-flow`

- Game launch claims a unique request ID in MySQL before making the provider call, preventing concurrent retries from issuing multiple launch URLs. Replays check both member ownership and game identity.
- Launch attempts are marked `pending`, `issued`, or `failed`; failed attempts require a fresh request ID rather than silently replaying a potentially ambiguous provider request.
- The launch request no longer sends `rtp: 0`; provider defaults remain authoritative until the exact GoldslotPalase launch contract is verified.
- Callback payload hashing is canonical across object-key order, and reusing an event key with changed payload or a provider transaction ID with a different command is rejected.
- These are code-level hardening changes only; CI, database-backed concurrency tests, and authenticated GoldslotPalase staging tests remain release gates.

## Rules for marking a feature complete

1. The API contract is documented and matches the Member/Backoffice XML.
2. Validation and authorization are enforced server-side.
3. State changes are transactional and idempotent where retries are possible.
4. Failure, timeout, duplicate and reversal cases are tested.
5. Sensitive credentials never appear in Blogger XML or responses.
6. External payment/provider features pass staging tests and reconciliation.
7. No dummy/fallback data may disguise an unavailable integration.
8. Real-money readiness remains false until all operational and approval gates are explicitly verified.

## Catalog and game launch contract

1. `GET /api/games` is read-only against MySQL and has short HTTP caching. It must never call GoldslotPalase catalog methods.
2. `POST /api/backoffice-game-catalog` with `{ "action": "sync" }` is the manual catalog synchronization action. Only an authorized admin/superadmin may invoke it. A normal GET of the Backoffice catalog must remain read-only.
3. Opening a game card or detail popup is a local UI action using the already loaded catalog row. It must not call `/api/game-launch`.
4. When, and only when, the member clicks **Main Game**, the Member XML calls `POST /api/game-launch` with the authenticated bearer token and `{ "providerId": "<provider_id>", "gameSymbol": "<game_code>", "launchRequestId": "<fresh unique ID>" }`. A retry of the same request must reuse that ID; a new intentional launch must generate a new ID.
5. The backend verifies the member, checks game visibility/activity and launch settings, ensures/reuses the provider user mapping, requests the provider URL, validates that it is HTTPS, stores the launch audit record, and returns `game.launchUrl`. The XML then navigates/opens that returned URL. It must never build a provider URL itself or call the provider directly.
6. A repeated request ID cannot be reused for a different game; an expired launch request returns a conflict so the client can start a new launch with a new ID.
7. Do not call provider account creation during member login. That call is deferred until the member explicitly starts a game.
8. This backend contract does not prove the currently deployed Blogger XML uses it. The checked-in legacy XML still needs to be migrated and tested against the V2 bearer-session contract before cutover.
