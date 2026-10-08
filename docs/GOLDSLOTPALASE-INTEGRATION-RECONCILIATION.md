# GoldslotPalase Integration Reconciliation (v1.5)

Status: implementation plan and release gate. This document does not claim provider staging tests have passed.

## Source of truth and runtime

- Runtime: Cloudflare Workers only (cloudflare-worker.js and cloudflare-router.js).
- Identity and durable member/wallet data: Firebase Auth + Firestore.
- Provider adapter: src/game/goldslotpalase.js.
- Member launch: cloudflare/functions/game-launch.js -> src/game/launch.js.
- Provider callbacks: cloudflare/functions/goldslot-callback.js.
- Catalog snapshot: src/game/catalog.js.
- Provider transaction/reward ingestion: src/game/provider-ledger.js.
- Backoffice provider status/sync: cloudflare/functions/backoffice-provider.js.

Do not treat the separate Node/MySQL V2 branch as deploy-compatible with the Cloudflare/Firebase main branch. Any migration to a different runtime requires an explicit port of routes, Firestore semantics, callback handling, secrets, scheduled jobs, and test suite.

## Wallet mode decision

**BrandalBet's game callback implementation is a Seamless-wallet implementation.** The Firestore wallet is authoritative for authenticate, balance, bet, win, and cancel callback commands.

Rules:
1. Do not mix transfer-wallet deposits/withdrawals during game launch with Seamless callback debits/credits.
2. Do not debit the member wallet again when syncing provider transaction history; provider sync is reconciliation/reward-ingestion, not a second wallet settlement path.
3. Transfer endpoints must remain disabled unless a separately reviewed Transfer Wallet mode is intentionally selected and callback settlement is changed accordingly.
4. In Seamless mode, launch must not require a positive provider-side wallet balance or call provider balance/transfer methods as a precondition.
5. If provider callback contract requires a different balance source or response shape, stop and confirm with the provider rather than guessing.

## API endpoint inventory

The adapter contains methods for the following documented API V4 routes. Method existence alone does not mean a route is exposed in backoffice or enabled for operators.

| Feature | Provider route | Current integration role | Release rule |
|---|---|---|---|
| Agent auth/info | POST /v4/agent/info | Manual admin connectivity check | Verify authenticated staging call |
| Global RTP | POST /v4/agent/rtp | Provider-wide setting | Admin-only; authorized staging test; audit old/new values |
| Callback test | POST /v4/agent/callback-test | Manual callback diagnostic | Do not expose to member UI |
| Providers | POST /v4/game/providers | Explicit catalog sync | Validate schema, status, duplicate IDs |
| Games by provider | POST /v4/game/games | Catalog operation | Validate provider and game IDs |
| All games | POST /v4/game/all | Explicit catalog sync | Publish only complete snapshot |
| Online games | POST /v4/game/online-games | Operational status | Treat unavailable/malformed data as unknown, not online |
| Create user | POST /v4/user/create | Stable per-member provider mapping | Idempotent mapping; reject conflicting user codes |
| User info | POST /v4/user/info | Provider-wallet/diagnostic operation | Not a Seamless launch prerequisite |
| Launch URL | POST /v4/game/game-url | Member presses Play | HTTPS only; no redirect; never cache/reuse launch URL |
| Transfer in/out/out-all | POST /v4/wallet/deposit, /v4/wallet/withdraw, /v4/wallet/withdraw-all | Separate Transfer Wallet capability | Disabled in Seamless mode |
| Transaction cursor | POST /v4/game/transaction-id | Reconciliation sync | Persist cursor only after durable ingestion |
| Transaction time range | POST /v4/game/transaction | Manual reconciliation | Respect provider rate interval |
| Round details | POST /v4/game/round-details | Investigate discrepancies | Admin-only; retention-aware |
| User statistics | POST /v4/statistics/user | Reports/reconciliation | Admin-only; provider time format verified |
| Bonus Call config/start/cancel | /v4/game/call_config, /v4/game/call_start, /v4/game/call_cancel | Optional operator capability | Disabled unless role, audit, idempotency, staging tests pass |
| Free Round create/cancel | /v4/game/freeround/create, /v4/game/freeround/cancel | Optional promotion capability | Disabled unless authorized, audited, and tested |

## Callback contract and invariants

Callback authentication uses the Callback-Token header. The callback endpoint must:
- accept POST + JSON only;
- bound request size and reject malformed shapes;
- compare the secret without ordinary early-exit string comparison;
- resolve the provider account to exactly one active Firebase user;
- validate wallet currency/status/integer minor-unit invariants;
- validate the timestamp when the provider contract supplies one;
- return the provider's documented response envelope and error codes;
- persist the callback event and wallet change in one Firestore transaction;
- return the exact prior response for an exact replay;
- reject the same transaction identifier with different semantics;
- allow only one reversal per original bet/win, enforced atomically against the original event;
- never allow a cancellation to reverse a transaction belonging to another account;
- log sanitized correlation identifiers, not secrets, raw credentials, or full sensitive payloads.

Canonicalize JSON before computing an idempotency fingerprint so key ordering alone does not turn an otherwise identical retry into a conflict. A semantically different retry for the same provider transaction ID must still be rejected.

## Durable provider transaction ledger

Provider history may have a limited retention window. A weekly reward aggregate is not an accounting ledger.

The durable normalized record should retain at least:
- provider name and provider transaction ID;
- provider user code and mapped Firebase UID;
- round ID, provider ID, game code;
- transaction type and exact amount in verified canonical units;
- provider timestamp, import timestamp, source/sync cursor;
- normalized fingerprint and processing status;
- duplicate/conflict/reversal relationship where applicable;
- reconciliation outcome and any anomaly reference.

Use deterministic document IDs based on provider + provider transaction ID. Same ID + same fingerprint is a duplicate; same ID + different fingerprint is an integrity conflict that must block affected reconciliation and create an alert. Do not delete the durable ledger when a round is aggregated. Pending round documents may be compacted after settlement, but keep a durable transaction ledger and immutable financial entries under an explicit retention policy.

Provider sync must not mutate the wallet balance. Seamless callbacks settle the wallet; provider sync validates the record and computes reward/turnover only once. A mismatch between callback and provider transaction ledger should create a reconciliation alert rather than silently applying a second debit/credit.

## Catalog and launch rules

- Member-facing catalog reads the Firestore snapshot only; it must not fan out to provider API on page load.
- Only explicit, authorized admin sync calls the provider catalog endpoints.
- Publish a new snapshot only after all provider/game pages and validations succeed.
- Keep the last valid snapshot if a sync fails; never replace it with an empty catalog due to upstream failure.
- Normalize provider/game IDs strictly and deduplicate stable identifiers.
- Treat maintenance/offline states conservatively.
- Launch only a game present in the published snapshot and explicitly launch-enabled.
- Launch URLs are sensitive, short-lived, single-use URLs: do not persist, cache, prefetch, or retry them blindly.
- Ensure provider user mapping is stable and reverse-mapped to exactly one member.

## RTP, Bonus Call, Free Round, and unsupported controls

- Global RTP may be available through the agent-level endpoint, but only use it for authorized operator actions with an audit trail and staging verification.
- Per-launch RTP is **disabled** until the provider resolves the documented rtp vs win_ratio field conflict in an authenticated staging test. Do not send rtp: 0 as a substitute for omitting the field.
- Do not invent per-game RTP, persistent per-user RTP, scatter control, or other unsupported endpoints.
- Bonus Call and Free Round methods must remain disabled by default until backoffice route wiring, role restrictions, idempotency, audit log, limits, and staging regression tests are complete.
- Never expose provider tokens or arbitrary provider URLs to Blogger/member clients.

## Failure and concurrency policy

- Never automatically retry a provider mutation when the outcome is ambiguous.
- Mark ambiguous outcomes and require a provider lookup/reconciliation before another mutation.
- Apply idempotency at the provider transaction ID level, not only at the callback command + ID level.
- Enforce single-use reversal atomically.
- Use a shared/distributed lock or Firestore transaction for cross-isolate mutations; an in-memory lock alone is insufficient.
- Honor provider rate limits and avoid overlapping transaction scans.
- Keep provider timeouts within the documented callback budget and return only contract-compliant responses.
- Fail closed when currency, scale, response schema, or provider status is unverified.

## Release gate

Do not mark the integration production-ready until all applicable tests pass in authorized staging and the deployment runtime is confirmed:

- [ ] Cloudflare Worker build and deployment dry run
- [ ] Firebase Auth token verification, RBAC, and Firestore connectivity
- [ ] Provider agent auth/info and IP whitelist
- [ ] Provider/game catalog normalization and snapshot atomicity
- [ ] Per-member user creation, stable mapping, and reverse mapping
- [ ] Launch URL HTTPS validation, expiry, and replay test
- [ ] Seamless authenticate/balance/bet/win/cancel callback contract
- [ ] Wrong token, malformed JSON, invalid timestamp, inactive member, and insufficient balance
- [ ] Duplicate callback and same-ID/different-payload conflict
- [ ] Two concurrent cancellation requests against one original transaction
- [ ] Callback retry after timeout and ambiguous mutation reconciliation
- [ ] Currency/IDR scale and decimal precision confirmed by provider
- [ ] Durable provider transaction ledger, duplicate ingestion, and conflict alert
- [ ] Provider sync does not double-settle wallet balance
- [ ] Maintenance/offline game handling
- [ ] Global RTP verified in staging; individual RTP disabled unless field is confirmed
- [ ] Bonus Call and Free Round either pass staging tests or remain disabled
- [ ] Browser E2E for member launch and backoffice controls
- [ ] Monitoring, backup, audit retention, and rollback plan

Until these checks pass, readyForRealMoney must remain false and all unverified money-moving/provider mutation features must remain disabled.
