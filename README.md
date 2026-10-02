# brandalbet-backend

Secure server-side backend API for Brandalbet.

Repository ini berdiri sendiri untuk backend Netlify Functions + Firebase Admin.
Tahap autentikasi backend menyediakan health-check publik serta endpoint protected
`me`, `backoffice-health`, dan bootstrap superadmin yang fail-closed. Firebase Admin
hanya diinisialisasi saat endpoint authenticated memerlukannya dan semua credential
tetap berasal dari Netlify Environment Variables. Wallet, payment, dan integrasi game
belum diimplementasikan. Prinsip keamanan ada di `docs/security.md`.

## Runtime dan dependency

- Node.js **22.x**, ditetapkan melalui `.nvmrc`, `package.json`, dan `netlify.toml`.
- `firebase-admin`: SDK backend; belum digunakan oleh endpoint health.
- `netlify-cli`: development lokal.
- `@netlify/zip-it-and-ship-it`: validasi bundling function dengan esbuild.
- `package-lock.json`: versi dependency terkunci untuk `npm ci`.

## Struktur

```text
brandalbet-backend/
├── .gitignore
├── .nvmrc
├── README.md
├── package.json
├── package-lock.json
├── netlify.toml
├── netlify/functions/
│   ├── health.js
│   ├── me.js
│   ├── backoffice-health.js
│   ├── bootstrap-superadmin.js
│   └── _shared/
├── src/
│   ├── config/
│   ├── auth/authenticate.js
│   ├── rbac/roles.js
│   ├── firebase/admin.js
│   ├── audit/logger.js
│   ├── security/cors.js
│   ├── utils/http.js
│   ├── wallet/
│   ├── ledger/
│   ├── payment/
│   └── game/
├── scripts/
│   ├── check.mjs
│   └── build.mjs
├── tests/
│   ├── health.test.js
│   └── auth-rbac.test.js
├── docs/security.md
└── public/.gitkeep
```

Folder kosong disimpan dengan `.gitkeep`. `public/` adalah direktori publish
kosong agar source backend tidak menjadi file statis yang dapat diunduh.

## Local development

Gunakan Node.js 22 (misalnya `nvm install` lalu `nvm use`):

```sh
npm ci
npm run validate
npm run dev
```

Buka `http://localhost:8888/.netlify/functions/health` atau jalankan:

```sh
curl --fail http://localhost:8888/.netlify/functions/health
```

`GET` menghasilkan status 200 dan JSON:

```json
{"ok":true,"service":"brandalbet-backend"}
```

Metode lain menghasilkan 405. Health tidak memerlukan environment variable atau
koneksi Firebase, dan hanya menunjukkan proses API hidup, bukan kesiapan database.
`npm run validate` menjalankan syntax check, contract tests, dan bundling function.
Output bundling validasi berada di `.netlify/validation-functions/` dan diabaikan Git.

## Deploy ke Netlify

1. Import repository GitHub **private** `brandalbet-backend` ke Netlify dengan
   akses hanya ke repository ini. Gunakan production branch `main`.
2. Gunakan konfigurasi dari `netlify.toml`: build `npm run validate`, publish
   `public`, functions `netlify/functions`, dan Node.js 22.
3. Pastikan runtime Functions mengikuti Node.js 22 dari build dan tidak ada
   pengaturan runtime situs lama yang menimpanya.
4. Deploy, lalu akses `/.netlify/functions/health` pada URL situs Netlify.
5. Verifikasi status 200 dan response JSON persis seperti di atas.

Health dapat dideploy tanpa Firebase. Protected endpoint fail closed sampai Firebase
Admin dan origin allowlist dikonfigurasi di Netlify Environment Variables.

Referensi konfigurasi: https://docs.netlify.com/build/functions/configuration/

## Security principles

- Firebase Admin hanya server-side.
- Endpoint authenticated memverifikasi Firebase ID Token dengan revocation check.
- RBAC berdasarkan Firebase Custom Claims dengan role `member`, `operator`,
  `finance`, `admin`, `superadmin`; default deny dan least privilege.
- Backoffice memerlukan `backoffice=true` **dan** role backoffice yang dikenal.
- Tidak ada UID admin yang di-hardcode sebagai bypass atau satu-satunya keamanan.
- Wallet mutation hanya server-side; ledger append-only dan immutable.
- Payment webhook dan game callback wajib memiliki verifikasi signature/auth,
  replay protection, dan idempotency yang durable sebelum diaktifkan.
- Protected access menghasilkan structured security audit log tanpa token/private key.
- Secret hanya dari Netlify Environment Variables / managed secret storage.
- Origin allowlist bukan pengganti authentication/authorization.

Kontrol transaksi, wallet, payment, webhook, dan game provider belum diimplementasikan.

## Environment variable names

Nama saja, tanpa nilai. Health-check publik tidak memerlukan nilai ini:

```text
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
ALLOWED_MEMBER_ORIGINS
ALLOWED_BACKOFFICE_ORIGINS
BOOTSTRAP_SUPERADMIN_UID
BOOTSTRAP_ENABLED
```

Masukkan nilai melalui pengaturan environment Netlify atau secret storage;
jangan menuliskannya di README, source, `netlify.toml`, test, log, atau GitHub.

## Larangan secret di Git

Jangan membuat atau commit `.env`, password, token, API key, Firebase private key,
service-account JSON, payment/game-provider/webhook secret, atau credential lain.
`.gitignore` menolak pola secret yang diminta. Pengecualian `.env.example` hanya
tersedia sesuai konfigurasi; file tersebut tidak dibuat pada tahap ini.
`.gitignore` bukan secret scanner: selalu periksa staged diff sebelum commit dan
jangan gunakan `git add -f` untuk melewati pengabaian file sensitif.

Repository wajib PRIVATE, default branch `main`, dan tanpa file lisensi.
`private: true` pada package mencegah publikasi npm; privasi GitHub tetap harus
dikonfirmasi tersendiri melalui pengaturan repository.

## Protected endpoint contracts

- `GET /.netlify/functions/me` memerlukan Firebase ID Token dan hanya mengembalikan `uid`, role yang dikenal, serta status backoffice.
- `GET /.netlify/functions/backoffice-health` memerlukan `backoffice=true` dan role `operator`, `finance`, `admin`, atau `superadmin`.
- `POST /.netlify/functions/bootstrap-superadmin` hanya aktif saat `BOOTSTRAP_ENABLED=true`, UID token sama dengan `BOOTSTRAP_SUPERADMIN_UID`, dan harus dinonaktifkan kembali setelah bootstrap berhasil.
- Missing/invalid token fail closed. Credential tidak pernah dikembalikan dalam response atau log.


<!-- deploy-preview: goldslot-v4-hotfix -->
