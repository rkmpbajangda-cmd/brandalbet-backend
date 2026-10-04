# BrandalBet Cloudflare Asset Architecture

## Tujuan

Logo, ikon, banner, favicon, dan background tidak ditanam sebagai Base64 atau blob besar di XML Blogger. XML hanya memakai URL aset yang disediakan dari deployment Cloudflare Worker yang sama. Backend API tetap fokus pada auth, wallet, game, dan backoffice.

## Arsitektur produksi

```text
Blogger member/backoffice
        |
        | GET /api/member-config
        v
Cloudflare Worker API
        |
        | returns resolved asset URLs
        v
Cloudflare Workers Static Assets
        |
        v
/assets/...
```

Aset statis disimpan di repository pada `public/assets/` dan di-upload otomatis oleh Wrangler bersama deployment Worker. Tidak memakai R2 dan tidak membutuhkan bucket terpisah.

## Base URL

Secara default tidak ada variable tambahan yang wajib dibuat. Backend mengambil origin request Worker saat ini dan memakai:

```text
https://<worker-aktif>/assets
```

`ASSET_CDN_BASE_URL` tetap didukung sebagai override opsional bila suatu saat ada custom domain CDN khusus. Jangan mengaturnya bila belum diperlukan.

## Struktur repository

```text
public/
  _headers
  assets/
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

Nama file harus versioned. Jika desain berubah, buat `-v2`, jangan overwrite nama file immutable yang sedang dipakai browser.

## Cache

`public/_headers` menerapkan cache panjang pada `/assets/*`:

```text
Cache-Control: public, max-age=31536000, immutable
```

Karena itu setiap perubahan visual harus menggunakan nama file versi baru.

## Website settings

Backoffice menyimpan path relatif, bukan Base64 dan bukan URL penuh:

```text
headerLogoPath = brand/logo-header-v1.svg
brandMarkPath = brand/brand-mark-v1.svg
faviconPath = brand/favicon-v1.png
homeIconPath = icons/home-v1.svg
banner1Path = banners/banner-01-v1.webp
```

Backend menyelesaikannya menjadi URL Worker seperti:

```text
https://<worker-aktif>/assets/brand/logo-header-v1.svg
```

Traversal seperti `../`, backslash, query string, fragment, atau path invalid ditolak.

Absolute HTTPS fields lama tetap dibaca sebagai fallback migrasi, tetapi aset baru harus memakai `*Path`.

## XML Blogger

XML tidak perlu mengetahui Cloudflare account ID, credential, bucket, atau secret apa pun. XML mengambil `member-config`, lalu menggunakan nilai seperti:

- `website.brand.headerLogo`
- `website.brand.mark`
- `website.icons.home`
- `website.icons.wallet`
- `website.banners`
- `website.loading.logo`

Aset header yang terlihat langsung jangan lazy-load. Banner atau background di bawah fold dapat memakai `loading="lazy"` dan `decoding="async"` bila sesuai.

## Batas keamanan

- Hanya aset publik yang boleh masuk `public/assets/`.
- Jangan simpan token provider, Firebase credential, private key, backup, database export, atau data member di folder public.
- Secret tetap berada di Cloudflare Worker secrets.
- Jangan route gambar melalui endpoint wallet/game/auth.
- `ASSET_CDN_BASE_URL` hanya override opsional; default produksi adalah Workers Static Assets pada origin Worker aktif.
