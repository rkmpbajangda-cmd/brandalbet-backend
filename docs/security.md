# BrandalBet Security Baseline

Status: Cloudflare Worker, Firebase Admin authentication, RBAC, member session,
wallet/ledger foundation, game catalog/launch protection, Goldslot transfer state machine,
dan backoffice security controls sudah tersedia di source. Financial activation tetap
fail-closed sampai staging/live evidence PASS.

## Runtime dan secret boundary

- Runtime utama adalah **Cloudflare Workers**.
- Firebase Admin, Goldslot token, payment credential, dan seluruh secret hanya server-side.
- `FIREBASE_SERVICE_ACCOUNT_JSON` dan `GOLDSLOTPALASE_API_TOKEN` adalah Cloudflare
  required secrets; jangan simpan nilainya di `wrangler.jsonc`, source, test, log, atau Blogger.
- Firestore menggunakan Admin credential hanya di backend dan dipaksa memakai HTTP/1.1
  REST transport (`preferRest: true`) agar tidak bergantung pada gRPC listener di Workers.
- Client Firestore Rules tetap deny-by-default. Firebase Admin bypass Rules, sehingga semua
  authorization/validation backend tetap wajib.
- `.env`, `.dev.vars`, service-account JSON, PEM/private key, dan credential lain wajib
  diabaikan Git dan tidak boleh dipaste ke source/documentation.

## Authentication dan authorization

- Protected endpoint memverifikasi Firebase ID Token server-side dengan revocation check.
- Missing, malformed, expired, revoked, atau project-mismatched token fail closed.
- Backoffice memerlukan `backoffice=true` **dan** role yang diizinkan.
- Roles: `member`, `operator`, `finance`, `admin`, `superadmin`.
- Operasi sensitif mempunyai pemeriksaan per-action; role backoffice umum tidak otomatis
  mendapatkan hak admin.
- Tidak ada hardcoded UID bypass.
- Bootstrap superadmin default OFF dan source config validation menolak bootstrap aktif.

## Member session

- Single-device session aktif.
- Session ID tidak disimpan plaintext; backend menyimpan hash.
- Login interaktif perangkat baru dapat mengganti session lama.
- Background restore tidak boleh mencuri session aktif perangkat lain.
- Logout hanya menutup session yang cocok.

## CORS dan request handling

- CORS authenticated API memakai exact origin allowlist untuk member dan backoffice.
- Tidak memakai wildcard CORS pada protected API.
- CORS bukan authentication atau authorization.
- Adapter membatasi request body 128 KiB; handler JSON dapat menerapkan limit yang lebih kecil.
- Error response publik tidak membocorkan token/private key/provider payload sensitif.

## Wallet dan ledger

- Wallet mutation hanya server-side.
- Wallet/ledger menggunakan Firestore transaction dan durable idempotency.
- Ledger diperlakukan append-only/immutable; koreksi menggunakan compensating entry.
- Browser tidak dapat mengirim role atau amount lalu langsung mengubah saldo.
- Concurrent debit, replay, overflow, wallet lock, dan corruption harus fail closed.

## GoldslotPalase

- Provider Bearer token hanya server-side.
- Provider request memiliki timeout, response-size boundary, redirect rejection, dan redacted errors.
- Catalog provider tidak dipanggil dari reload/member traffic; member membaca persistent snapshot.
- Provider catalog sync dan provider health check adalah explicit admin actions.
- Game launch URL wajib HTTPS dan diperlakukan one-time/short-lived.
- Duplicate launch dibatasi process-local dan distributed Firestore lease.
- Provider mutation tidak di-blind-retry setelah timeout/response ambigu.
- Transfer state machine menggunakan durable request ID dan status
  `prepared -> succeeded|failed|ambiguous`.
- `GOLDSLOTPALASE_TRANSFER_ENABLED`, `GOLDSLOTPALASE_IDR_SCALE`, dan reconciliation
  harus tetap fail-closed sampai staging membuktikan currency/amount contract.

## Payment

- Multi-payment connection manager menyimpan credential encrypted server-side.
- UI tidak menerima raw credential value.
- Payment connection configuration **bukan** payment adapter universal.
- Sebelum transaksi nyata diaktifkan, adapter konkret wajib mempunyai provider-documented:
  authentication/signature verification, original-body verification bila diperlukan,
  replay protection, idempotency, amount/currency validation, status query, callback settlement,
  withdrawal/disbursement, dan timeout reconciliation.

## Audit dan observability

- Protected access dan administrative changes menghasilkan structured security events.
- Jangan log bearer token, API token, private key, PIN, full bank account, atau raw payment secret.
- Cloudflare observability aktif untuk deployment diagnostics.
- Request/correlation ID digunakan untuk menelusuri kegagalan tanpa memasukkan secret.

## Release rule

Deployment Cloudflare yang berhasil tidak otomatis berarti real-money ready.
`readyForRealMoney` harus tetap false sampai Firebase runtime, Goldslot staging,
financial reconciliation, payment adapter, browser E2E, backup/restore, dan monitoring
production semuanya terverifikasi.
