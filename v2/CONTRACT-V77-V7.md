# Member V77 / Backoffice V7 contract baseline

Member routes observed in the audited XML:
- /api/member-session
- /api/member-device-session
- /api/member-onboarding
- /api/member-profile
- /api/member-bank-account
- /api/member-config
- /api/member-rewards
- /api/games
- /api/game-launch
- /api/promotions
- /api/transactions
- /api/wallet
- payment/deposit/withdrawal flows

Backoffice routes observed:
- /api/backoffice-health
- /api/backoffice-readiness
- /api/backoffice-dashboard
- /api/backoffice-members
- /api/backoffice-finance
- /api/backoffice-ledger
- /api/backoffice-game-catalog
- /api/backoffice-provider
- /api/backoffice-payment-connections
- /api/backoffice-promotions
- /api/backoffice-rewards
- /api/backoffice-reports
- /api/backoffice-audit
- /api/backoffice-website-settings
- /api/backoffice-master-control
- /api/bootstrap-superadmin
- provider/game wallet/callback routes

Rule: an endpoint is not considered production-ready merely because it returns HTTP 200. It must have the correct authorization, validation, persistence, idempotency and external-provider verification required by the XML contract.