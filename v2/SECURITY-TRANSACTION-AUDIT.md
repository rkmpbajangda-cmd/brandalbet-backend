# BrandalBet V2 Authentication, Game, Wallet and Payment Audit

**Audit date:** 2026-10-09  
**Scope:** `v2/` on `fix/v2-goldslot-game-flow` only.  
**Architecture:** Node.js 22 + MySQL 8.4. Legacy Cloudflare/Deno/Firebase backend was not modified. No merge or deployment was performed.

## Verified in code and regression tests

- **Login/provider account mapping:** member login resolves or creates a GoldslotPalase account before issuing a member session when the provider is configured; unavailable mapping fails closed. Existing provider mappings are reused and duplicate mapping races resolve to the stored mapping.
- **Game launch:** verifies active provider/game and numeric provider/user codes, reserves the request ID before calling the provider, rejects conflicting reuse, never replays a previously issued one-time URL, checks HTTPS URL shape, and does not send an unconfigured RTP override.
- **Provider callbacks:** callback token is checked; supported commands are allowlisted; canonical payload hashes detect changed payloads; transaction IDs are checked against command, account, user and amount; status lookup is scoped to the mapped user.
- **Wallet ledger:** same-reference operations are rechecked after locking the wallet with a current locking read, which avoids stale-snapshot behavior under MySQL REPEATABLE READ. Reusing a reference with a different user, amount or direction returns an idempotency conflict.
- **Withdrawal settlement:** settlement/release lock withdrawal before wallet, consistent with payout webhook processing, and ignore already-terminal withdrawals. This prevents double release/settlement races.
- **Locked wallet behavior:** new provider bets are rejected, while provider wins/cancellations and confirmed deposit credits can still be recorded.
- **Automated integration coverage:** real MySQL 8.4 tests exercise competing wallet debits, duplicate wallet references, conflicting references, successful Xendit payment webhook replay, and successful payout webhook replay.

## CI evidence

The V2 workflow run **37928297328** completed successfully on the hardening branch:
- `npm run check`: passed
- Database schema migration before tests: passed
- Test suite: **41 passed, 0 failed**
- Migration idempotency check (second migration): passed

The latest report/documentation-only commit may trigger a fresh CI run; the code/test commit above is the verified green run.

## Release blockers — not verified and not approved for real-money use

1. **GoldslotPalase sandbox E2E remains outstanding:** actual provider login/account creation, launch URL TTL/single-use behavior, authenticate/balance/bet/win/cancel/status callbacks, retries, settlement and reconciliation have not been run against a live sandbox from this environment.
2. **Xendit test-mode API E2E remains outstanding:** payment request creation and payout API calls, gateway timeouts, provider failures, late/out-of-order events and external reconciliation still need a test-mode staging run. The current MySQL tests exercise webhook handlers, not Xendit network calls.
3. **Payment reversal needs an explicit operations workflow:** a reversal webhook currently moves the order/deposit to `reversal_pending`; it does not automatically debit the member wallet. Do not treat that state as reconciled. Define and test a controlled review/hold/reversal workflow before enabling real-money transactions.
4. **Client idempotency contract:** member/backoffice clients must send a stable `Idempotency-Key` for each intended deposit/withdrawal action and a fresh `launchRequestId` for each intentional game launch. The deployed Blogger XML contract has not been verified against V2.
5. **Operational readiness:** staging deployment, opening-balance/ledger reconciliation, backup restoration, monitoring, TLS/CORS, rollback, provider approvals and legal/operational approvals remain outstanding.

The readiness endpoint must continue to report `readyForRealMoney: false` until these blockers are closed and verified. Do not merge or deploy based solely on CI success.
