# BrandalBet — status integrasi, 2 Oktober 2026

Repository: `rkmpbajangda-cmd/brandalbet-backend`  
Backend canonical: `https://playful-biscuit-33cfee.netlify.app`  
Provider game: **GoldslotPalase saja**.  
Working branch: `fix/goldslotpalase-integration-foundation-20261002`.

Dokumen ini sengaja membedakan **source-complete**, **staging verified**, dan **production verified**. Tidak ada fitur finansial yang dinyatakan siap hanya karena source sudah tersedia.

## Source yang sudah tersedia

### Member / wallet

- Firebase Admin ID-token verification server-side.
- RBAC backoffice.
- Member profile, onboarding, rekening bank/e-wallet masked, session aggregate.
- Wallet IDR server-authoritative dengan validasi integritas.
- Ledger immutable/idempotent foundation dan riwayat 50 transaksi terakhir milik UID token.
- Browser tidak memiliki endpoint untuk menambah saldo secara langsung.

### GoldslotPalase

Kontrak canonical proyek adalah `PROVIDER-02-INTEGRATION-SPEC-v1.5.md`.

Source sekarang memiliki:

- base URL tetap `https://agent.goldslotpalase.com`;
- Bearer token hanya server-side;
- redirect ditolak, timeout dibatasi, response dibatasi 2 MB;
- tidak ada retry otomatis untuk mutasi provider;
- envelope sukses menerima integer `result` atau integer `code`; konflik keduanya ditolak;
- explicit provider rejection diperlakukan definitif, sedangkan timeout/response ambigu tetap fail-closed;
- agent info, global Agent RTP, callback test;
- provider catalog, all-games catalog, games-by-provider;
- deterministic member → provider username mapping;
- provider user create/re-resolve;
- protected member game launch;
- validasi launch URL HTTPS;
- launch URL ditandai one-time dengan TTL provider 10 menit;
- per-launch RTP override **tidak dikirim** oleh member workflow;
- transfer-wallet deposit / withdraw / withdraw-all menggunakan payload provider yang terdokumentasi;
- transfer state machine `prepared → succeeded|failed|ambiguous`;
- transfer-in mereservasi `availableMinor` sebelum request provider;
- provider success baru diselesaikan ke ledger/wallet secara atomik;
- explicit rejection melepas hold;
- response ambigu tidak di-retry dan tidak dikredit/debit ulang;
- settlement lokal yang gagal setelah provider success dipaksa `ambiguous`, bukan dianggap gagal;
- satu active provider transfer per member melalui `providerPlayers.activeTransferId`;
- duplicate request ID tidak mengirim ulang mutasi provider.

### Game catalog / member API

Endpoint source:

- `GET /.netlify/functions/games`
- `POST /.netlify/functions/game-launch`
- `POST /.netlify/functions/game-wallet-transfer`
- `POST /.netlify/functions/game-wallet-reconcile`

Katalog hanya mengeluarkan field yang disanitasi. URL gambar hanya HTTPS. Game disabled/launch-disabled tidak dianggap aktif.

### Multi-payment

- Satu manager Payment Gateway untuk banyak provider/merchant.
- Sandbox dan production connection dipisahkan.
- Maksimum 30 credential fields per koneksi.
- Credential values disimpan encrypted AES-256-GCM server-side.
- Browser hanya menerima nama field/status, bukan credential value.
- Provider/mode existing tidak dapat dipindahkan ke koneksi lain lewat edit.
- Optimistic revision mencegah admin saling menimpa perubahan.
- Registry adapter pembayaran nyata masih **kosong**; mengisi merchant ID/private key belum mengaktifkan deposit/withdraw.

## Environment yang dibaca

| Variable | Kegunaan |
|---|---|
| `FIREBASE_PROJECT_ID` | Firebase project |
| `FIREBASE_CLIENT_EMAIL` | Firebase Admin service account |
| `FIREBASE_PRIVATE_KEY` | Firebase Admin private key, server only |
| `ALLOWED_MEMBER_ORIGINS` | CORS member |
| `ALLOWED_BACKOFFICE_ORIGINS` | CORS backoffice |
| `BOOTSTRAP_ENABLED` | Temporary admin bootstrap switch |
| `BOOTSTRAP_SUPERADMIN_UID` | UID bootstrap |
| `GOLDSLOTPALASE_API_TOKEN` | GoldslotPalase Agent API Bearer token |
| `GOLDSLOTPALASE_TRANSFER_ENABLED` | Explicit provider transfer-wallet activation gate |
| `GOLDSLOTPALASE_IDR_SCALE` | Must equal `1` only after staging proves provider amount = internal IDR integer unit |
| `GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED` | Optional balance-only reconciliation gate; keep OFF until staging procedure is proven |
| `PAYMENT_CONFIG_ENCRYPTION_KEY` | 32-byte base64 master key for encrypted multi-payment configuration |

## Transfer-wallet safety gates

Provider OpenAPI represents money as numeric/double. Internal BrandalBet accounting uses safe integers.

Therefore transfer wallet remains disabled unless:

1. `GOLDSLOTPALASE_TRANSFER_ENABLED=true`;
2. staging proves the agent currency/amount scale is exactly compatible with internal integer IDR;
3. only then set `GOLDSLOTPALASE_IDR_SCALE=1`.

Balance-only reconciliation is **not trusted by default** because concurrent game activity could change provider balance and create a false conclusion. `GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED` must remain false until a staging procedure proves it safe, or exact provider transaction identity reconciliation is implemented.

## Provider facts retained from v1.5

- API Base URL: `https://agent.goldslotpalase.com`.
- Bearer authentication.
- Transfer Wallet differs from website payment-gateway deposit/withdraw.
- Indonesian language code: `9`.
- Launch URL: one-time, valid approximately 10 minutes.
- Global Agent RTP endpoint is documented.
- Per-launch field accepted by provider is `rtp`, but BrandalBet does not expose ordinary per-member RTP control.
- Callback auth uses `Callback-Token`.
- Callback commands documented: authenticate, balance, bet, win, cancel, status.
- Callback retries: 4 attempts, 5-second interval, provider timeout 15 seconds.
- Provider callback source-IP list is unavailable.
- Provider transaction history is short-lived; BrandalBet must persist its own ledger.

## Yang masih harus dibuktikan di staging/live

1. Authenticated `agent/info` from the actual Netlify/runtime network.
2. GoldslotPalase agent currency and exact integer/decimal scale.
3. Assigned provider + game catalog response against the real agent.
4. Provider user mapping and launch against a real staging member.
5. Transfer in/out/out-all with small controlled staging amounts.
6. Timeout/ambiguous transfer operational reconciliation.
7. Firestore rules and indexes applied to the real Firebase project.
8. Concurrent wallet/ledger behavior using emulator/live contention tests.
9. Browser end-to-end V39: login, register, onboarding, bank, wallet, game catalog, launch, logout/login again.
10. App Check / distributed abuse controls / admin MFA / backup-restore / monitoring.
11. A concrete payment gateway adapter, callback verifier, deposit settlement and withdrawal/disbursement adapter.

## Payment status

Multi-payment configuration is structurally ready, but **no universal payment adapter exists** because payment providers do not share one authentication/signature/callback contract.

Do not invent a generic live adapter from merchant ID/private key alone. Once a concrete gateway is selected, its adapter must implement:

- create payment;
- signature/authentication;
- callback verification;
- idempotency;
- status query;
- amount/currency validation;
- deposit settlement to ledger;
- withdrawal/disbursement;
- timeout reconciliation.

## Current release status

`readyForRealMoney` intentionally remains **false**.

Source now contains the member/game workflows and fail-closed financial state machine, but production activation still requires the staging evidence above. Deploying this code alone does not enable provider transfer or payment transactions.
