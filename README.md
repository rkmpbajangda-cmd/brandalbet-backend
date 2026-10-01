# brandalbet-backend

Secure server-side backend API for Brandalbet.

Repository ini berdiri sendiri untuk backend Netlify Functions + Firebase Admin.
Tahap awal hanya menyediakan health-check publik. Firebase belum diinisialisasi;
tidak ada credential, endpoint authenticated, wallet, payment, atau integrasi game.
Prinsip keamanan untuk tahap berikutnya tertulis di `docs/security.md`.

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
│   └── _shared/
├── src/
│   ├── config/
│   ├── auth/
│   ├── rbac/roles.js
│   ├── firebase/
│   ├── wallet/
│   ├── ledger/
│   ├── payment/
│   ├── game/
│   ├── audit/
│   ├── security/
│   └── utils/
├── scripts/
│   ├── check.mjs
│   └── build.mjs
├── tests/health.test.js
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

Instruksi deploy disediakan untuk tahap pengguna berikutnya; scaffold ini tidak
membuat akun Netlify, mengatur credential, atau menjalankan deployment produksi.
Health dapat dideploy tanpa Firebase. Jangan menambahkan credential hanya untuk
menjalankan health-check.

Referensi konfigurasi: https://docs.netlify.com/build/functions/configuration/

## Security principles

- Firebase Admin hanya server-side.
- Endpoint authenticated mendatang wajib memverifikasi Firebase ID Token.
- RBAC berdasarkan Firebase Custom Claims dengan role `member`, `operator`,
  `finance`, `admin`, `superadmin`; default deny dan least privilege.
- Tidak ada UID admin yang di-hardcode sebagai bypass atau satu-satunya keamanan.
- Wallet mutation hanya server-side; ledger append-only dan immutable.
- Payment webhook dan game callback wajib memiliki verifikasi signature/auth,
  replay protection, dan idempotency yang durable sebelum diaktifkan.
- Semua tindakan administratif sensitif wajib menghasilkan audit log.
- Secret hanya dari Netlify Environment Variables / managed secret storage.
- Origin allowlist bukan pengganti authentication/authorization.

Ini adalah baseline untuk implementasi tahap berikutnya. Kontrol transaksi,
webhook, auth, dan audit belum diimplementasikan karena belum ada endpoint terkait.

## Environment variable names

Nama saja, tanpa nilai. Belum diperlukan oleh health-check:

```text
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
ALLOWED_MEMBER_ORIGINS
ALLOWED_BACKOFFICE_ORIGINS
```

Masukkan nilai kelak melalui pengaturan environment Netlify atau secret storage;
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
