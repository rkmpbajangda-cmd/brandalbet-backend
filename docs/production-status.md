# BrandalBet — status integrasi, 4 Oktober 2026

Repository: `rkmpbajangda-cmd/brandalbet-backend`  
Runtime canonical: **Cloudflare Workers**  
Production branch: `main`  
Provider game: **GoldslotPalase saja**

Dokumen ini membedakan **source-complete**, **runtime verified**, **staging verified**,
dan **production/real-money verified**. Tidak ada fitur finansial yang dinyatakan siap
hanya karena source atau deployment sudah tersedia.

## Cloudflare runtime foundation

- Entrypoint: `cloudflare-worker.js`.
- API router: `cloudflare-router.js`.
- Router menggunakan lazy loading per endpoint.
- `/health` memverifikasi Worker entrypoint tanpa memuat backend graph penuh.
- `/api/health` memverifikasi Cloudflare router + health handler.
- Compatibility date `2026-10-03` menggunakan Node.js compatibility default modern.
- `process.env` digunakan oleh handler lama dan tersedia pada runtime Cloudflare dengan
  compatibility date tersebut.
- Firestore Admin dipaksa menggunakan HTTP/1.1 REST transport melalui
  `initializeFirestore(..., { preferRest: true })`; source tidak menggunakan
  `onSnapshot()` sehingga backend tidak membutuhkan Firestore gRPC listener.
- Cloudflare config menyimpan konfigurasi non-secret saja.
- `FIREBASE_SERVICE_ACCOUNT_JSON` dan `GOLDSLOTPALASE_API_TOKEN` dideklarasikan
  sebagai required secrets.
- Cloudflare build validation menolak accidental plaintext secret, bootstrap aktif,
  transfer aktif, atau reconciliation aktif di source config.
- CI melakukan syntax tests, Node tests, legacy handler bundling, Cloudflare validation,
  dan Wrangler dry-run bundle sebelum source dianggap deployable.

## Member / auth / wallet source

- Firebase Admin ID-token verification server-side dengan revocation check.
- RBAC backoffice berbasis Custom Claims.
- CORS exact allowlist untuk member/backoffice.
- Firestore client rules deny-by-default.
- Member profile, onboarding, rekening bank/e-wallet masked, dan session aggregate.
- Single-device member session dengan session hash dan replacement semantics.
- Wallet IDR server-authoritative dengan validasi integritas.
- Ledger immutable/idempotent foundation dan transaction history milik UID token.
- Browser tidak memiliki endpoint untuk menambah saldo secara langsung.

## GoldslotPalase source

Source menyediakan:

- base URL `https://agent.goldslotpalase.com`;
- Bearer token server-side only;
- timeout/response limits dan redirect rejection;
- tidak ada blind retry untuk provider mutation;
- agent info/provider health explicit check;
- persistent provider catalog snapshot;
- member game catalog membaca snapshot lokal, bukan provider per reload;
- admin explicit catalog sync sebagai jalur normal provider catalog fetch;
- deterministic member → provider player mapping dengan cache/revalidation;
- protected member game launch;
- validasi launch URL HTTPS;
- local + distributed Firestore launch guard untuk duplicate/concurrent launch;
- transfer-wallet deposit / withdraw / withdraw-all state machine;
- state `prepared → succeeded|failed|ambiguous`;
- durable request idempotency;
- satu active provider transfer per member;
- atomic local wallet/ledger settlement;
- ambiguous provider response tidak di-retry secara buta;
- balance/reconciliation gate fail-closed.

## Game-call policy

- Member reload, search, filter, scroll, dan navigation tidak boleh fetch provider catalog.
- `GET /api/games` membaca stored snapshot.
- Backoffice Game Catalog GET membaca stored snapshot.
- Catalog provider call hanya melalui explicit admin sync.
- Provider health call hanya melalui explicit admin check.
- Launch provider call hanya ketika member menekan Play.
- Player mapping tidak dibuat ulang pada setiap launch.
- Financial balance/transfer tetap realtime/authoritative dan tidak memakai cache 7 hari.

## Multi-payment

Source mempunyai multi-payment connection manager:

- sandbox dan production connection dipisahkan;
- credential values terenkripsi server-side;
- browser tidak menerima raw credential;
- optimistic revision mencegah overwrite antar admin.

Namun registry adapter pembayaran nyata masih **belum lengkap**. Merchant ID/private
key saja tidak cukup untuk membuat universal gateway. Adapter konkret harus mengikuti
kontrak provider tertentu.

## Environment / secret model

### Cloudflare Secret wajib sekarang

```text
FIREBASE_SERVICE_ACCOUNT_JSON
GOLDSLOTPALASE_API_TOKEN
```

### Secret saat payment diaktifkan

```text
PAYMENT_CONFIG_ENCRYPTION_KEY
```

### Non-secret config utama

```text
FIREBASE_PROJECT_ID
ALLOWED_MEMBER_ORIGINS
ALLOWED_BACKOFFICE_ORIGINS
MEMBER_SINGLE_SESSION_ENABLED
BOOTSTRAP_ENABLED
GOLDSLOTPALASE_API_URL
GOLDSLOTPALASE_TRANSFER_ENABLED
GOLDSLOTPALASE_IDR_SCALE
GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED
```

## Transfer-wallet safety gates

Provider money contract harus dibuktikan sebelum transfer aktif. Default source:

```text
GOLDSLOTPALASE_TRANSFER_ENABLED=false
GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED=false
```

`GOLDSLOTPALASE_IDR_SCALE=1` hanya boleh diset setelah staging membuktikan bahwa amount
provider benar-benar kompatibel 1:1 dengan unit integer IDR internal.

## Yang masih harus dibuktikan setelah Cloudflare deploy

1. `/health` PASS pada Worker production URL.
2. `/api/health` PASS dan adapter dapat dimuat.
3. Firebase ID-token verification PASS pada `/api/me` dengan token valid.
4. Firestore read/write/transaction PASS melalui REST transport Cloudflare.
5. Backoffice RBAC: member biasa DENIED, admin/superadmin ALLOWED.
6. Single-device session replacement PASS pada dua perangkat.
7. `GET /api/games` membaca stored snapshot tanpa provider call.
8. Explicit Goldslot agent health/check PASS dari network Cloudflare.
9. Explicit admin catalog sync PASS dan snapshot terbaca oleh member.
10. Real provider player mapping + controlled game launch PASS.
11. Provider currency dan exact IDR scale dibuktikan.
12. Controlled transfer in/out/out-all + ambiguous reconciliation PASS sebelum gate transfer diaktifkan.
13. Concrete payment adapter, callback verification, deposit settlement, withdrawal/disbursement, dan reconciliation PASS.
14. End-to-end Blogger member + backoffice PASS terhadap Cloudflare base URL.
15. Backup/restore dan operational monitoring diuji.

## Current release status

- Cloudflare architecture/source: **READY FOR DEPLOYMENT VALIDATION**.
- Auth/RBAC/session source: **SOURCE COMPLETE, RUNTIME TEST REQUIRED**.
- Game catalog/launch protection source: **SOURCE COMPLETE, PROVIDER TEST REQUIRED**.
- Wallet/ledger/provider transfer state machine: **SOURCE COMPLETE, FINANCIAL GATES OFF**.
- Payment real adapter: **PENDING CONCRETE PROVIDER**.
- `readyForRealMoney`: **false** by design.

Cloudflare deployment yang berhasil tidak otomatis mengubah status finansial menjadi
production verified. Gate transaksi hanya boleh diaktifkan setelah bukti staging di atas
PASS dan secret lama/terekspos telah dirotasi.
