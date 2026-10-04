# BrandalBet Cloudflare Asset Architecture

## Tujuan

Logo, ikon, banner, favicon, dan background tidak ditanam sebagai Base64 atau blob besar di XML Blogger. XML hanya memakai URL CDN. Backend API tetap fokus pada auth, wallet, game, dan backoffice.

## Arsitektur

```text
Blogger member/backoffice
        |
        | GET /api/member-config
        v
Cloudflare Worker API
        |
        | returns resolved immutable asset URLs
        v
Cloudflare R2 + CDN/custom domain
```

Static objects tidak diproxy melalui Worker API utama. Browser mengambil objek langsung dari Cloudflare CDN/R2.

## Environment

Tambahkan satu variable non-secret di Cloudflare Worker:

```text
ASSET_CDN_BASE_URL=https://<domain-cdn-anda>
```

Gunakan HTTPS. Jangan menambahkan slash akhir. Nilai ini bukan secret.

Contoh custom domain yang direkomendasikan jika domain BrandalBet sudah tersedia:

```text
https://assets.brandalbet.com
```

Jangan hardcode domain yang belum benar-benar dibuat.

## Bucket

Gunakan bucket terpisah, misalnya:

```text
brandalbet-assets
```

Jangan simpan service-account, token provider, private key, file backup, database export, atau dokumen sensitif di bucket public ini.

## Struktur objek

```text
brand/
  logo-header-v1.svg
  brand-mark-v1.svg
  favicon-v1.png

icons/
  home-v1.svg
  promo-v1.svg
  wallet-v1.svg
  profile-v1.svg
  coin-v1.svg

banners/
  banner-01-v1.webp
  banner-02-v1.webp
  banner-03-v1.webp

backgrounds/
  auth-v1.webp
  member-v1.webp

seo/
  cover-v1.webp
```

Nama object harus versioned. Jika desain berubah, buat `-v2`, jangan overwrite object immutable yang sudah dipakai browser.

## Cache

Untuk object versioned, gunakan metadata HTTP:

```text
Cache-Control: public, max-age=31536000, immutable
```

Gunakan Content-Type yang benar, misalnya `image/svg+xml`, `image/webp`, dan `image/png`.

## Website settings

Backoffice menyimpan path relatif, bukan URL penuh:

```text
headerLogoPath = brand/logo-header-v1.svg
brandMarkPath = brand/brand-mark-v1.svg
faviconPath = brand/favicon-v1.png
homeIconPath = icons/home-v1.svg
banner1Path = banners/banner-01-v1.webp
```

Backend menggabungkan path dengan `ASSET_CDN_BASE_URL`. Traversal seperti `../`, backslash, query string, fragment, atau path invalid ditolak.

Absolute HTTPS fields lama tetap dibaca sebagai fallback untuk migrasi, tetapi produksi baru harus memakai `*Path`.

## XML Blogger

XML tidak perlu mengetahui bucket, account ID, R2 credentials, atau secret apa pun. XML mengambil `member-config`, lalu menggunakan URL yang sudah diselesaikan backend seperti `website.brand.headerLogo`, `website.icons.home`, dan `website.banners`.

Aset hero/header yang terlihat langsung jangan memakai lazy loading. Banner di bawah fold dapat memakai `loading="lazy"` dan `decoding="async"`.

## Batas keamanan

- R2 public bucket hanya untuk aset publik.
- Tidak ada directory listing dari aplikasi.
- Jangan gunakan signed URL untuk logo publik; itu hanya menambah overhead.
- Secret tetap berada di Cloudflare Worker secrets.
- Jangan route gambar melalui endpoint wallet/game/auth.
- Bila memakai custom domain, aktifkan HTTPS dan cache Cloudflare normal.
