# BrandalBet Rewards — Cashback 10% & Referral 15%

## Policy

- Weekly timezone: `Asia/Jakarta`.
- Week: Monday 00:00 WIB through next Monday 00:00 WIB.
- Member cashback: 10% of positive settled weekly net loss.
- Cashback minimum: settled weekly net loss >= IDR 500,000.
- Cashback turnover: 10x cashback amount before the cashback principal is withdrawable.
- Promoter referral commission: 15% of the referred member's positive settled weekly net loss.
- Referral commission is not calculated from deposit amount.
- Deposit, withdrawal, wallet transfer, bonus, refund and other non-game movements are not loss inputs.

`netLossMinor = max(0, validSettledBetMinor - validSettledWinMinor)`

Cashback and referral commission are calculated independently from the same settled net-loss basis. Cashback is not deducted before referral commission is calculated.

## Authoritative data flow

1. A verified GoldslotPalase settled-round/report source supplies member UID, provider round ID, valid bet, win and settlement timestamp.
2. `ingestSettledGameRound()` stores the round once in `settledGameRounds` and updates `rewardWeeklyMembers` atomically.
3. Provider round ID + fingerprint protects against duplicate or mutated replay.
4. Valid settled bets advance cashback turnover obligations FIFO.
5. Cloudflare Cron processes the previous closed week in bounded batches.
6. `rewardPayouts` provides reward-level idempotency.
7. Separate immutable ledger entries use `weekly_cashback` and `referral_commission` sources.
8. `rewardWeekFinalizations` stores batch cursor and totals so repeated cron runs continue safely.

Never derive weekly loss from GoldslotPalase wallet transfer-in minus transfer-out. Provider wallet balances may remain in the provider and transfers are not betting settlement records.

## Referral binding

Referral codes live in `referralCodes/{CODE}` and are issued to a promoter by admin/superadmin. During member onboarding the code is resolved server-side and stored as an immutable `referrals/{memberUid}` binding. Unknown, inactive, self-referral, and promoter switching fail closed.

Legacy `users.referralCode` values created before this registry existed must not automatically earn commission. They require a controlled migration/backfill after ownership is verified.

## Turnover and withdrawal

Cashback credits create an obligation in `rewardTurnover/{uid}`:

- `principalMinor`: cashback amount.
- `requiredTurnoverMinor`: cashback x 10.
- `remainingTurnoverMinor`: decreases only from verified settled valid bets.

The wallet carries server-managed `rewardLockedMinor`. The member can use the credited cashback for play, but the cashback principal under turnover is excluded from the server-calculated withdrawable amount.

A concrete withdrawal/disbursement adapter must call `assertRewardWithdrawalAllowed()` before reserving or debiting funds. The repository currently does not contain a real payment-provider withdrawal adapter, so this guard is implemented and tested but cannot be wired to a provider-specific withdrawal flow until that adapter exists.

## API surfaces

### Member

`GET /api/member-rewards`

Returns policy, promoter/referral status, current-week settled projection, pending turnover, reward lock and withdrawable amount. It is member-auth protected.

### Backoffice

`GET /api/backoffice-rewards`

Returns policy and week-finalization state for finance/admin/superadmin roles.

`POST /api/backoffice-rewards`

Supported actions:

- `issue-referral-code` — admin/superadmin.
- `ingest-settled-round` — admin/superadmin staging/manual bridge only.
- `finalize-week` — finance/admin/superadmin; payout remains idempotent.

The manual settled-round action is not a substitute for a verified GoldslotPalase transaction-report/callback adapter.

## Collections

- `referralCodes`
- `referrals`
- `settledGameRounds`
- `rewardWeeklyMembers`
- `rewardTurnover`
- `rewardPayouts`
- `rewardWeekFinalizations`
- existing `ledger`
- existing `wallets`
- existing `auditEvents`

Firestore browser access remains deny-by-default. Reward mutations are server-side only.

## Runtime scheduling

Cloudflare Workers is the canonical runtime. `wrangler.jsonc` configures a cron every six hours. Each invocation processes at most 100 aggregate member rows with bounded concurrency and then persists its cursor. Replays are safe because payout IDs and ledger IDs are deterministic.

## Production gate still required

The reward mathematics, storage, idempotency, referral binding, turnover tracking, Cloudflare scheduling and withdrawal guard are source-complete. Real-money cashback/referral payout must remain gated until the exact GoldslotPalase settled-bet/report source and its authentication/signature semantics are verified in staging. Do not substitute public documentation for another provider.
