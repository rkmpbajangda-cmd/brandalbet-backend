# Konfigurasi multi-payment Brandalbet

Satu menu **Payment Gateway** mengelola banyak koneksi merchant. Integrasi game tetap hanya GoldslotPalase.

## Cara kerja

Admin dapat menambah koneksi terpisah untuk setiap layanan, merchant, dan mode sandbox/produksi. Field yang disediakan: Merchant ID, Private Key, API Key, Public Key, dan Webhook Secret. Hanya isi field yang diminta dokumentasi layanan. Daftar field wajib berasal dari adapter terdaftar.

`POST /.netlify/functions/backoffice-payment-connections` menyimpan konfigurasi. `GET` menampilkan daftar tanpa nilai kredensial. Akses hanya admin/superadmin. Perubahan kredensial memerlukan login baru, maksimal 10 menit sejak autentikasi Firebase.

Kolom credential kosong saat edit berarti mempertahankan nilai lama. Untuk mengganti kunci, isi kunci baru dan simpan. Label boleh diubah; provider/mode tidak boleh berubah pada koneksi existing. Setiap edit menggunakan revisi untuk mencegah penimpaan perubahan admin lain. Audit hanya menyimpan nama field yang berubah, bukan nilainya.

## Persiapan server satu kali

Atur `PAYMENT_CONFIG_ENCRYPTION_KEY` di secret/environment server sebagai base64 kanonis dari 32 byte acak kriptografis. Nilai ini bukan private key merchant dan bukan private key Firebase. Server menolak menyimpan kredensial jika kunci enkripsi belum valid.

Simpan cadangan kunci di pengelola rahasia; jangan menggantinya sembarangan karena data lama akan tidak terbaca. Rotasi master key memerlukan migrasi/re-enkripsi data. Terapkan `firestore.rules` deny-all untuk client SDK. Admin SDK server tetap dapat mengakses `paymentConnections` dan `auditEvents`.

Semua kredensial, termasuk merchant ID, disimpan sebagai satu envelope AES-256-GCM dengan IV acak per penyimpanan dan authenticated data terikat ID koneksi. Token/key tidak dikembalikan ke browser atau audit log. Jangan aktifkan logging request body pada endpoint ini.

## Batas integrasi

Saat ini registry adapter pembayaran kosong. Konfigurasi boleh disimpan tetapi status akan menunjukkan bahwa layanan belum tersedia, dan `operational` selalu false. Memilih mode produksi tidak mengaktifkan pembayaran.

Setiap gateway membutuhkan adapter khusus untuk autentikasi/signature, pembuatan pembayaran, callback, status query, nominal/mata uang, error mapping, idempotency dan rekonsiliasi. Tidak ada skema universal yang dapat bekerja untuk semua gateway hanya dari merchant ID/private key.

Adapter yang lulus verifikasi didaftarkan dalam `src/payment/registry.js`. Adapter harus membaca kredensial hanya di server. Tidak ada URL API arbitrer dari browser. Kredensial sandbox dan produksi tidak boleh dicampur, dan order harus mengikat satu koneksi/revisi supaya callback diproses dengan identitas yang tepat.

Tahap ini menyelesaikan pengelolaan konfigurasi, bukan deposit/withdraw live, routing transaksi, callback verifier, atau failover pembayaran. Pengujian langsung gateway diperlukan sebelum aktivasi. Jangan mengulang transaksi pembayaran yang timeout secara otomatis; periksa status dan rekonsiliasi terlebih dahulu.
