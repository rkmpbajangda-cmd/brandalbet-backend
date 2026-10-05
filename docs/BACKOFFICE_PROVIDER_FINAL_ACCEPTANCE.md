# BrandalBet Backoffice — Provider Final Acceptance

Production authority: Firebase Auth + Cloudflare Worker + Firestore + GoldslotPalase.

## Backoffice provider controls

The operator console must expose only server-authorized controls:

- Provider snapshot status and last catalog sync.
- Manual GoldslotPalase health check (`agent/info`) for admin/superadmin.
- Explicit catalog sync for admin/superadmin. Normal page loads must read the persistent catalog snapshot and make zero live catalog calls.
- Transaction synchronization and reconciliation status.
- Global/provider-supported RTP control only. Do not present unsupported persistent per-game RTP or scatter controls as provider capabilities.
- Wallet transfer/reconciliation controls only when the corresponding server-side capability flags are enabled and the production account supports the mode.
- No provider token, payment secret, Firebase private credential, PIN, or other authority may be sent to Blogger/client code.

## Required production environment

Secrets/variables are configured in Cloudflare, never in Blogger or this repository:

- `GOLDSLOTPALASE_API_URL`
- `GOLDSLOTPALASE_API_TOKEN` (secret)
- `GOLDSLOTPALASE_TRANSFER_ENABLED`
- `GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED`
- `GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED`
- `GOLDSLOTPALASE_IDR_SCALE`

Capability flags must remain fail-closed when configuration is absent or unsupported.

## Production acceptance sequence

Do not mark the integration LIVE VERIFIED until all applicable steps pass against production:

1. Firebase admin/superadmin login succeeds.
2. Backoffice request carries a valid Firebase ID token.
3. Cloudflare RBAC authorizes the operator.
4. Provider GET status loads from the stored snapshot without a live provider call.
5. Manual provider check succeeds against GoldslotPalase.
6. Explicit catalog sync succeeds.
7. A subsequent catalog read succeeds from the stored snapshot without another live provider catalog call.
8. Provider and game counts are non-zero when the provider account exposes catalog data.
9. Member login succeeds and BrandalSession is valid.
10. Member selects an active game from the stored catalog.
11. Firebase UID resolves to the correct GoldslotPalase `user_code`; email is never used as financial identity.
12. The launch request is uniquely identified/idempotent.
13. A fresh `/v4/game/game-url` request succeeds.
14. The returned game URL is not cached/reused for a later launch.
15. The real game opens successfully.
16. If transfer mode is enabled, a small controlled wallet transfer succeeds exactly once.
17. Provider transaction synchronization records the resulting provider activity.
18. Reconciliation reaches a non-ambiguous state; timed-out/ambiguous mutations are not blindly retried.
19. Ledger/audit records contain request/actor/result identifiers without secrets.
20. Member, finance, game catalog, game launch, wallet, provider, reports and settings regression checks pass.

## Status policy

Use only PASS / FAIL / BLOCKED / UNVERIFIED. Repository tests can prove code behavior; they cannot prove live provider connectivity. GoldslotPalase connectivity, real game launch and real wallet behavior remain UNVERIFIED until the production acceptance sequence is actually executed.
