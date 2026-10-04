# BrandalBet Backend

Secure server-side backend API untuk BrandalBet.

## Runtime utama

**Cloudflare Workers adalah runtime production/staging utama.** Repository tetap
mempertahankan handler bergaya Netlify sebagai kontrak internal/portable adapter,
tetapi deployment utama menggunakan `cloudflare-worker.js` + `wrangler.jsonc`.

- Worker entrypoint: `cloudflare-worker.js`
- API adapter: `deno-server.js`
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
```

Keduanya dideklarasikan melalui `secrets.required`, sehingga Wrangler menolak deploy
jika secret wajib belum terpasang.

Secret berikut dibutuhkan ketika modul payment nyata diaktifkan:

```text
PAYMENT_CONFIG_ENCRYPTION_KEY
```

Jangan commit `.env`, `.dev.vars`, service-account JSON, private key, API token,
payment credential, atau credential lain ke Git.

## Konfigurasi non-secret Cloudflare

Konfigurasi aman yang versioned antara lain:

```text
FIREBASE_PROJECT_ID=brandal-bet
ALLOWED_MEMBER_ORIGINS=https://brandalbet.blogspot.com
ALLOWED_BACKOFFICE_ORIGINS=https://backoffic.blogspot.com
MEMBER_SINGLE_SESSION_ENABLED=true
BOOTSTRAP_ENABLED=false
GOLDSLOTPALASE_API_URL=https://agent.goldslotpalase.com
GOLDSLOTPALASE_TRANSFER_ENABLED=false
GOLDSLOTPALASE_BALANCE_RECONCILIATION_ENABLED=false
```

Transfer Goldslot dan balance reconciliation sengaja **fail-closed**. Jangan aktifkan
transfer sampai currency/IDR scale dan prosedur reconciliation dibuktikan melalui
staging provider.

## Build, test, dan deploy

Gunakan Node.js 22:

```sh
npm ci
npm run validate
```

`npm run validate` menjalankan:

1. syntax validation;
2. seluruh Node tests;
3. bundling validation handler lama;
4. Cloudflare configuration validation;
5. Wrangler dry-run bundle menggunakan versi Wrangler yang dipin pada script.

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

## API routing

Cloudflare menerima alias `/api/<function>` dan kompatibilitas path lama
`/.netlify/functions/<function>`. Router menggunakan **lazy loading per handler** agar
satu dependency/integrasi yang bermasalah tidak menjatuhkan endpoint lain.

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
- Backoffice memakai Firebase Custom Claims + RBAC.
- Firestore client rules adalah deny-by-default; privileged write/read dilakukan
  server-side melalui Admin credential.
- CORS authenticated API memakai exact origin allowlist, bukan wildcard.
- Single-device session aktif dan session identifier hanya disimpan sebagai hash.
- Wallet adalah server-authoritative.
- Ledger dan provider transfer memakai durable idempotency/state machine.
- Game launch memiliki process-local guard + distributed Firestore lease untuk
  mencegah duplicate launch antar instance.
- Provider token, Firebase credential, dan payment secret tidak dikirim ke Blogger.
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

## Legacy portability

Folder `netlify/functions/` tetap digunakan sebagai handler module layer dan untuk
validation portability. Netlify/Deno bukan lagi source of truth runtime BrandalBet.
Perubahan baru harus diuji terhadap Cloudflare Worker terlebih dahulu.
