# BrandalBet Backend V2

Branch ini adalah backend Node.js + MySQL baru dan sengaja tidak menyentuh main.

Firebase tidak dipakai di V2 production. Blogger Member dan Backoffice tetap menjadi UI client.

Kontrak wajib: auth/session, member/profile/bank, wallet/ledger, deposit/withdrawal, cashback/referral, game catalog/launch, GoldslotPalase callback, payment webhook, RBAC, reports, audit dan system configuration.

Tidak boleh ada fake success, fake balance atau dummy transaction completion.

Cutover ke production hanya setelah contract test terhadap Member V77 dan Backoffice V7 lulus.