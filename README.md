# BrandalBet Backend

Secure server-side backend API untuk BrandalBet.

## Runtime utama

**Cloudflare Workers adalah satu-satunya runtime backend production/staging.**
Seluruh API berjalan melalui `cloudflare-worker.js` + `cloudflare-router.js` dan konfigurasi deployment berada di `wrangler.jsonc`.

- Worker entrypoint: `cloudflare-worker.js`
- Cloudflare API router: `cloudflare-router.js`
- Production branch: `main`
- Node.js compatibility: melalui Cloudflare compatibility date `2026-10-03`
- Firebase Admin: server-side only
- Firestore: menggunakan `initializeFirestore(..., { preferRest: true })`

`wrangler.jsonc` adalah source of truth konfigurasi Cloudflare. Secret tidak boleh berada di file tersebut.

## Cloudflare secrets

Secret yang **wajib untuk base Worker deploy**:

```text
FIREBASE_SERVICE_ACCOUNT_JSON
GOLDSLOTPALASE_API_TOKEN
```

Secret yang **feature-scoped** dan tidak boleh memblokir base deploy:

```text
BOOTSTRAP_SUPERADMIN_UID
PAYMENT_CONFIG_ENCRYPTION_KEY
```

`BOOTSTRAP_SUPERADMIN_UID` hanya diperlukan ketika `BOOTSTRAP_ENABLED=true` untuk bootstrap claim superadmin. Nilainya tidak boleh ditaruh di XML Blogger, Firestore client, `wrangler.jsonc`, source Git, atau response API.

`PAYMENT_CONFIG_ENCRYPTION_KEY` hanya diperlukan ketika backoffice menyimpan credential payment ke vault. Tidak adanya key ini harus membuat fitur payment fail-closed, bukan menjatuhkan deployment seluruh Worker.

Jangan commit `.env`, `.dev.vars`, service-account JSON, private key, API token, payment credential, UID bootstrap, atau credential lain ke Git.

## Konfigurasi non-secret Cloudflare

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

`GOLDSLOTPALASE_IDR_SCALE=0` berarti skala IDR belum diverifikasi. Transfer, reconciliation, transaction sync, dan reward payout tetap fail-closed sampai staging/live provider membuktikan kontraknya.

## Bootstrap superadmin

Runtime normal harus mempertahankan:

```text
BOOTSTRAP_ENABLED=false
```

Untuk bootstrap terkontrol, simpan UID Firebase Auth target sebagai Cloudflare Secret `BOOTSTRAP_SUPERADMIN_UID`, lalu sementara ubah `BOOTSTRAP_ENABLED=true`. Endpoint hanya menerima ID token dari UID yang sama. Setelah claim berikut terpasang:

```json
{
  "backoffice": true,
  "role": "superadmin"
}
```

kembalikan `BOOTSTRAP_ENABLED=false`. Backoffice V5.2 akan mencoba endpoint bootstrap otomatis hanya ketika health backoffice membalas 403.

## Build, test, dan deploy

Gunakan Node.js 22:

```sh
npm ci
npm run validate
```

`npm run validate` menjalankan syntax validation, seluruh test, Cloudflare configuration/runtime validation, dan Wrangler dry-run bundle.

Perintah deploy:

```sh
npm run deploy:cloudflare
```

## Health checks

Worker liveness:

```text
GET /health
```

Adapter/API liveness:

```text
GET /api/health
```

Firebase/Auth/Firestore tetap harus diverifikasi melalui protected endpoint dengan ID Token valid setelah deployment.

Backoffice admin/superadmin dapat memakai readiness endpoint untuk melihat boolean status Firebase, project match, bootstrap target, Goldslot, IDR scale, dan payment vault. Nilai secret tidak pernah dikembalikan.

## Security model

- Firebase ID Token diverifikasi server-side dengan revocation check.
- `FIREBASE_SERVICE_ACCOUNT_JSON.project_id` harus sama dengan `FIREBASE_PROJECT_ID`.
- Backoffice memakai Firebase Custom Claims + RBAC.
- Firestore client rules deny-by-default; privileged access melalui Admin SDK.
- CORS authenticated API memakai exact origin allowlist.
- Single-device session aktif.
- Wallet server-authoritative.
- Bootstrap default OFF dan UID target hanya diterima dari server-side environment.
- Provider token, Firebase credential, UID bootstrap, dan payment secret tidak dikirim ke Blogger.

## GoldslotPalase call policy

- Member `GET /games` membaca persistent snapshot lokal.
- Backoffice catalog GET membaca snapshot lokal.
- Fetch katalog provider hanya melalui explicit admin sync.
- Game launch realtime saat member menekan Play.
- Transfer/reconciliation tidak diaktifkan sebelum currency dan IDR scale terverifikasi.

## Production readiness

`readyForRealMoney` tetap `false` sampai Firebase live auth/RBAC, Goldslot authenticated connectivity, currency/IDR scale, transfer/reconciliation, concrete payment adapter, browser E2E, dan backup/monitoring semuanya PASS.

## Cloudflare-only runtime

Netlify dan Deno tidak digunakan sebagai runtime production. Semua API production melalui Cloudflare Worker dan secret production disimpan sebagai Cloudflare Secrets.
