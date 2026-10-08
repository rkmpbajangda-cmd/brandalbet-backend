# BrandalBet Rewards — Policy and V2 Implementation Status

## Intended policy

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

## Authoritative data requirements

1. A verified GoldslotPalase settled-round/report source must provide member identity, provider round ID, valid settled bet, win, reversal/cancel state and settlement timestamp.
2. Provider round ID plus a canonical payload fingerprint must prevent duplicate or mutated replay.
3. Cashback turnover must advance only from verified settled valid bets.
4. A weekly settlement batch must have a durable cursor, deterministic payout IDs, immutable ledger entries and a reversal path.
5. Provider wallet transfer-in/out must never be treated as betting settlement data.

## Current V2 backend status

The active `backend-v2-node-mysql` branch is a Node.js + MySQL implementation. It currently stores referral attribution and exposes referral counts/policy in member and backoffice reward responses. Reward payouts are deliberately gated: `POST /api/backoffice-rewards` with `action: "finalize-week"` returns `503 reward_payout_disabled`.

The V2 SQL schema does **not yet** contain the authoritative settled-round, weekly reward aggregation, turnover-obligation and reward-payout ledger tables required by the policy above. Do not calculate commissions from `provider_transactions` alone: the callback table contains individual activity and is not proof that a round is fully settled. Do not enable real-money reward payout until the exact provider report, authentication/signature semantics, duplicate replay behavior and reversal handling are verified in staging.

## Referral binding

- Referral codes are generated or issued server-side.
- Registration validates the code, requires an active member owner, and stores both `users.referred_by` and the immutable `referrals` relation in the registration transaction.
- Unknown, inactive, non-member and malformed codes fail closed.
- Existing legacy referral codes require controlled ownership verification before any reward eligibility is granted.

## Production gate

Reward math and payout settlement are **not source-complete in V2**. Real-money cashback/referral payout remains disabled until the verified settled-round source and full financial ledger/reversal implementation are completed and tested. CI success does not establish that provider credentials, settlement data, payout or regulatory/provider approval is ready.
