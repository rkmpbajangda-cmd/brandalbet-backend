# BrandalBet Backend

Secure server-side backend API untuk BrandalBet.

## Runtime utama

**Cloudflare Workers adalah satu-satunya runtime backend production/staging.**
Seluruh API berjalan melalui `cloudflare-worker.js` + `cloudflare-router.js` dan
konfigurasi deployment berada di `wrangler.jsonc`.

- Worker entrypoint: `cloudflare-worker.js`
- Cloudflare API router: `cloudflare-router.js`
- Production branch: `main`
- Node.js compatibility: melalui Cloudflare compatibility date `2026-10-03`
- Firebase Admin: server-side only
- Firestore: dipaksa menggunakan HTTP/1.1 REST transport dengan
  `initializeFirestore(..., { preferRest: true })`; backend tidak memakai
  `onSnapshot()` sehingga tidak bergantung pada gRPC transport.

`wrangler.jsonc` adalah source of truth konfigurasi Cloudflare. Secret tidak boleh
berada di file tersebut.

## Cloudflare secrets wajib

Nilai berikut harus disimpan sebagai **Cloudflare Secret**, bukan plaintext variable:

```text
FIREBASE_SERVICE_ACCOUNT_JSON
GOLDSLOTPALASE_API_TOKEN
BOOTSTRAP_SUPERADMIN_UID
PAYMENT_CONFIG_ENCRYPTION_KEY
```

`BOOTSTRAP_SUPERADMIN_UID` adalah UID Firebase Authentication dari satu akun yang
ditetapkan sebagai target bootstrap superadmin. Nilainya tidak boleh ditaruh di XML
Blogger, Firestore client, `wrangler.jsonc`, source Git, atau response API.

`PAYMENT_CONFIG_ENCRYPTION_KEY` dipakai untuk vault kredensial koneksi payment di
backoffice. Adanya secret ini tidak otomatis mengaktifkan deposit/withdraw karena
adapter payment produksi tetap harus tersedia dan lolos verifikasi.

Jangan commit `.env`, `.dev.vars`, service-account JSON, private key, API token,
payment credential, UID bootstrap, atau credential lain ke Git.

## Konfigurasi non-secret Cloudflare

Konfigurasi aman yang versioned dan dikunci build validation:

```text
FIREBASE_PROJECT_ID=brandal-bet
ALLOWED_MEMBER_ORIGINS=https://brandalbet.blogspot.com
ALLOWED_BACKOFFICE_ORIGINS=https://backoffic.blogspot.com
MEMBER_SINGLE_SESSION_ENABLED=true
BOOTSTRAP_ENABLED=false
GOLDSLOTPALASE_API_URL=https://agent.goldslotpalase.com
GOLDSLOTPALASE_IDR_SCALE=0
GOLDSLOTPALASE_TRANSFER_ENABLED=false
GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED=false
GOLDSLOTPALASE_TRANSACTION_SYNC_ENABLED=false
REWARDS_PAYOUT_ENABLED=false
REWARDS_MANUAL_INGEST_ENABLED=false
```

`GOLDSLOTPALASE_IDR_SCALE=0` berarti skala IDR **belum diverifikasi**. Transfer Goldslot,
balance reconciliation, transaction sync, dan reward payout sengaja **fail-closed**.
Jangan mengubah IDR scale menjadi `1` atau mengaktifkan transfer/reconciliation sampai
currency/scale dan prosedur reconciliation dibuktikan terhadap akun provider nyata.

## Bootstrap superadmin

Bootstrap hanya untuk pemberian claim awal. Runtime normal harus mempertahankan:

```text
BOOTSTRAP_ENABLED=false
```

Untuk bootstrap terkontrol, operator Cloudflare harus sementara mengubah
`BOOTSTRAP_ENABLED=true` sementara secret `BOOTSTRAP_SUPERADMIN_UID` sudah berisi UID
Firebase Auth target. Endpoint menolak UID lain. Setelah claim berikut terpasang:

```json
{
  "backoffice": true,
  "role": "superadmin"
}
```

`BOOTSTRAP_ENABLED` harus dikembalikan ke `false`. Secret UID boleh tetap tersimpan
server-side agar target bootstrap terdokumentasi di environment tanpa mengeksposnya ke
frontend.

## Build, test, dan deploy

Gunakan Node.js 22:

```sh
npm ci
npm run validate
```

`npm run validate` menjalankan:

1. syntax validation;
2. seluruh Node tests;
3. Cloudflare configuration/runtime validation;
4. Wrangler dry-run bundle menggunakan versi Wrangler yang dipin pada script.

Perintah penting:

```sh
npm run build
npm run bundle:cloudflare
npm run deploy:cloudflare
```

`npm run build` sengaja ringan untuk Cloudflare Builds. `npm run bundle:cloudflare`
melakukan Wrangler dry-run dan dipakai CI untuk menangkap dependency/bundling error
sebelum deployment. `npm run deploy:cloudflare` adalah jalur deploy reproducible.

## Health checks

Worker-level liveness:

```text
GET /health
```

Expected:

```json
{"ok":true,"service":"brandalbet-backend","runtime":"cloudflare-workers"}
```

Adapter/API liveness:

```text
GET /api/health
```

Expected:

```json
{"ok":true,"service":"brandalbet-backend"}
```

`/health` hanya membuktikan entrypoint Worker hidup. `/api/health` juga membuktikan
adapter dan handler API dapat dimuat. Firebase/Auth/Firestore tetap harus diverifikasi
melalui protected endpoint dengan ID Token yang valid setelah deployment.

Backoffice admin/superadmin dapat memakai readiness endpoint untuk melihat **boolean
status** konfigurasi Firebase, bootstrap target, provider, IDR scale, dan payment vault.
Nilai secret tidak pernah dikembalikan.

## API routing

Cloudflare menerima API hanya melalui `/api/<function>`. Router menggunakan **lazy loading per handler** agar satu dependency/integrasi yang bermasalah tidak menjatuhkan endpoint lain.

Endpoint utama meliputi:

- public/member: `health`, `games`, `promotions`, `member-config`;
- authenticated member: `me`, profile/onboarding, bank account, wallet,
  transactions, member session/device session;
- game: `game-launch`, `game-wallet-status`, `game-wallet-transfer`,
  `game-wallet-reconcile`;
- backoffice: dashboard, members, finance, ledger, audit, game catalog,
  provider, readiness, reports, promotions, payment connections, website settings,
  dan master control.

## Security model

- Firebase ID Token diverifikasi server-side dengan revocation check.
- `FIREBASE_SERVICE_ACCOUNT_JSON.project_id` harus sama dengan `FIREBASE_PROJECT_ID`;
  mismatch gagal tertutup sebelum token dipakai.
- Backoffice memakai Firebase Custom Claims + RBAC.
- Firestore client rules adalah deny-by-default; privileged write/read dilakukan
  server-side melalui Admin credential.
- CORS authenticated API memakai exact origin allowlist, bukan wildcard.
- Single-device session aktif dan session identifier hanya disimpan sebagai hash.
- Wallet adalah server-authoritative.
- Ledger dan provider transfer memakai durable idempotency/state machine.
- Game launch memiliki process-local guard + distributed Firestore lease untuk
  mencegah duplicate launch antar instance.
- Provider token, Firebase credential, UID bootstrap, dan payment secret tidak dikirim ke Blogger.
- Bootstrap superadmin default OFF dan build validation menolak source config yang
  mengaktifkannya.
- Request body adapter dibatasi 128 KiB dan launch URL provider wajib HTTPS.

## GoldslotPalase call policy

Katalog provider tidak boleh dipanggil pada setiap reload/member request.

- Member `GET /games` membaca persistent snapshot lokal.
- Backoffice catalog GET membaca snapshot lokal.
- Fetch katalog provider hanya melalui explicit admin sync.
- Provider health call hanya melalui explicit admin check.
- Game launch adalah realtime saat member menekan Play.
- Financial/provider balance/transfer tidak memakai cache multi-hari.
- Transfer mutation tidak di-retry secara buta setelah response ambigu.

## Production readiness

Source mempunyai foundation untuk auth, RBAC, member, wallet/ledger, persistent game
catalog, protected game launch, provider transfer state machine, backoffice, dan
multi-payment connection manager.

Namun **`readyForRealMoney` tetap sengaja `false`** sampai semua bukti staging/live
berikut PASS:

- Firebase Auth + Firestore pada runtime Cloudflare;
- authenticated Goldslot agent connectivity;
- provider currency dan IDR scale;
- catalog/player/launch terhadap agent nyata;
- controlled transfer in/out/out-all dan ambiguous reconciliation;
- concrete payment adapter + callback verification + deposit settlement + withdrawal;
- browser end-to-end member dan backoffice;
- backup/restore serta operational monitoring.

Tidak boleh mengubah gate finansial hanya untuk membuat demo terlihat aktif.

## Cloudflare-only runtime

Netlify dan Deno tidak digunakan sebagai runtime, deployment target, atau public API alias.
Folder handler production berada di `cloudflare/functions/`, scheduler menggunakan Cloudflare Cron Triggers, dan semua secret production disimpan sebagai Cloudflare Secrets.
