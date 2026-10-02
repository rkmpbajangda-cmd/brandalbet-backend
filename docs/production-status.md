# Brandalbet — status integrasi, 2 Oktober 2026

Base repository: `rkmpbajangda-cmd/brandalbet-backend`, main `4a90f81b1bf1f2cd5f35d18d8eb5d99555c63b4e`.
Provider game dipilih pengguna: **GoldslotPalase saja**. Tidak ada adapter NexusGGR dalam perubahan ini.

## Perubahan yang tersedia di source

- Wallet menolak data rusak, mata uang salah, saldo negatif, dan status tidak dikenal; tidak lagi menampilkan data rusak sebagai saldo nol/aktif.
- Pembuatan profil menggunakan transaksi untuk mencegah konflik saat dua login pertama berjalan bersamaan.
- Primitive ledger server-only: saldo dan entry dicatat atomik, ID operasi unik, duplikat identik deterministik, konflik ID ditolak, saldo kurang dan integer overflow ditolak. Tidak ada endpoint yang mengizinkan browser menambah saldo.
- Riwayat transaksi membaca 50 entry terbaru milik UID token, beserta konfigurasi index Firestore yang dibutuhkan.
- Promosi public/admin, validasi periode/URL, kontrol role, revisi untuk mencegah penimpaan edit, dan audit mutation atomik. Batas daftar 200 item; pagination lanjutan belum dibuat.
- Endpoint readiness hanya admin/superadmin; menampilkan nama konfigurasi dan status keberadaan, tidak nilainya, dan tidak menyatakan siap uang nyata.
- Template backoffice dalam repository memakai backend aktif, mencegah login/entry ganda dan HTML injection pada pesan, serta mengirim revision ketika menyimpan promosi.
- Client GoldslotPalase memakai base URL tetap, Bearer server-side, timeout, batas response, penolakan redirect, validasi response, tanpa retry otomatis. Agent info, provider list, create user, user info, dan request launch tersedia sebagai fungsi internal; belum terhubung ke alur member.

## Konfigurasi yang benar-benar dibaca kode

| Variabel | Fungsi |
|---|---|
| FIREBASE_PROJECT_ID | Identitas proyek Firebase |
| FIREBASE_CLIENT_EMAIL | Identitas service account |
| FIREBASE_PRIVATE_KEY | Secret Firebase Admin; hanya server |
| ALLOWED_MEMBER_ORIGINS | Origin member yang boleh mengakses API |
| ALLOWED_BACKOFFICE_ORIGINS | Origin backoffice yang boleh mengakses API |
| BOOTSTRAP_ENABLED | Aktif hanya selama bootstrap admin |
| BOOTSTRAP_SUPERADMIN_UID | UID yang diizinkan bootstrap |
| GOLDSLOTPALASE_API_TOKEN | Secret Agent API GoldslotPalase; hanya server |
| PAYMENT_CONFIG_ENCRYPTION_KEY | Kunci enkripsi server 32-byte base64 untuk konfigurasi multi-gateway |

Menambahkan token tidak otomatis mengaktifkan permainan. Tidak ada placeholder secret dalam source dan tidak ada credential dipindahkan dari chat.

## Bukti produksi yang diperiksa pada sesi ini

- `GET https://verdant-tiramisu-efb2f9.netlify.app/.netlify/functions/health`: HTTP 200.
- `GET .../backoffice-health` tanpa token: HTTP 401 `missing_bearer_token`.
- `GET .../promotions` dan `GET .../games`: HTTP 404 pada deployment sebelum perubahan ini.
- Pemeriksaan wallet live tidak mendapat hasil karena kendala konektivitas; tidak dinyatakan PASS.
- Login member dan superadmin live, saldo, permainan, serta pembayaran belum diuji dengan akun produksi.

## Sumber kontrak GoldslotPalase

Dokumen pengguna `PROVIDER-02-INTEGRATION-SPEC-v1.4.md` telah dibaca penuh, dan client existing platform-core dipakai sebagai referensi tambahan.
URL spec: https://agent.goldslotpalase.com/swagger/v4/swagger.json.
Akses spec langsung saat sesi ini mendapat HTTP 403; schema terbaru tidak berhasil diverifikasi ulang.
Dokumen menegaskan Transfer Wallet berbeda dari deposit/withdraw payment gateway, `result=0` sukses, Bearer token, dan konflik `rtp` vs `win_ratio`.

## Penghambat yang masih nyata — BUKAN release selesai

1. GoldslotPalase: verifikasi schema request/response penuh terbaru untuk catalog, transfer dan status transfer; konfirmasi mode transfer dan unit uang/IDR pada akun agen.
2. Transfer provider belum diimplementasikan: perlu reserve/settle/release, penyimpanan status, rekonsiliasi hasil timeout dan idempotency provider yang terbukti. Jangan meniru retry semua POST dari client lama: dapat menggandakan transfer.
3. Client launch belum dipasang ke endpoint member: masih perlu player mapping permanen, catalog validation, validasi URL keluaran, rate limit terdistribusi, dan pengecekan status member.
4. Pengelola konfigurasi multi-gateway/multi-merchant sudah tersedia dengan kredensial terenkripsi dan satu menu backoffice. Adapter layanan pembayaran nyata, verifikasi callback, deposit, withdrawal approval/disbursement, serta rekonsiliasi belum tersedia. Mengisi kredensial belum mengaktifkan transaksi.
5. Banyak menu backoffice V18 masih placeholder; bukan dashboard bisnis lengkap.
6. Firestore rules/indexes harus diterapkan dan diuji; primitive ledger baru diuji dengan transactional test double, bukan Firestore emulator/live concurrency.
7. `balanceMinor` sudah ada di baseline tetapi skala rupiahnya belum dibuktikan. Jangan konversi ke angka provider/payment sebelum unit tersertifikasi dan saldo lama diaudit.
8. Rate limiting terdistribusi, App Check, MFA admin, backup/restore, pemantauan, serta transaksi gagal/pending belum melewati uji operasional.
9. Perubahan ini harus melewati runtime Node 22 dan staging; browser end-to-end serta deployment produksi belum dinyatakan berhasil.

**Status: implementasi parsial untuk review/staging. Belum siap member bermain dengan uang nyata.**

## Validasi perubahan pada sesi ini

- 33/33 Node test lulus pada Node v24.19.0.
- 13 Netlify functions berhasil dibundle dengan target Node 22. Target bundler bukan bukti test runtime Node 22.
- Backoffice XML parse dan JavaScript syntax lulus. Browser login/end-to-end belum diuji.
- Source scan tidak menemukan marker private key.
- Secret produksi tidak diakses atau disalin ke repository.
- Source disiapkan untuk review/staging; tidak mengaktifkan deposit, withdraw, game-launch atau transfer uang nyata.

## Tambahan multi-payment, 2 Oktober 2026 sore

- Satu menu Payment Gateway untuk banyak layanan/merchant, termasuk koneksi sandbox dan produksi terpisah.
- Kredensial AES-256-GCM server-side, authenticated data terikat ID koneksi; daftar API hanya mengembalikan nama field yang terisi.
- Penyimpanan memerlukan admin/superadmin dengan login kurang dari 10 menit, revisi sesuai, dan encryption key server valid.
- Mode/provider koneksi existing tidak dapat diubah agar kredensial tidak berpindah ke layanan lain. Buat koneksi terpisah.
- Form menghapus isi kredensial setelah submit dan saat logout, tidak menyimpan ke localStorage.
- 42/42 pengujian backend lulus menggunakan `node --test --test-isolation=none` pada Node 24.19.0.
- 14 Netlify functions berhasil dibundle dengan target Node 22. Runtime Node 22 belum diuji pada sesi ini.
- XML dan sintaks JavaScript lulus. Browser test belum berjalan karena executable Chromium tidak tersedia.
- Belum ada adapter payment produksi terdaftar. Status readiness tetap false; tidak ada endpoint mutasi saldo dari konfigurasi ini.
