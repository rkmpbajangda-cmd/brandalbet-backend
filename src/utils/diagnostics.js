const CODE_INFO = Object.freeze({
  missing_bearer_token: ['AUTHENTICATION','Cloudflare Worker','Bearer token extraction','Token autentikasi tidak dikirim ke Worker.','Kirim ulang request dengan Firebase ID Token yang valid.'],
  invalid_authorization_header: ['AUTHENTICATION','Cloudflare Worker','Authorization header','Format Authorization tidak valid.','Login ulang dan biarkan aplikasi membuat header autentikasi.'],
  invalid_or_expired_id_token: ['FIREBASE_AUTH','Cloudflare Worker','Firebase ID Token verification','Firebase ID Token ditolak karena tidak valid, kedaluwarsa, atau tidak sesuai proyek.','Refresh token Firebase dan pastikan FIREBASE_PROJECT_ID=brandal-bet.'],
  auth_project_mismatch: ['FIREBASE_AUTH','Cloudflare Worker','Firebase project verification','Konfigurasi backend menunjuk ke project Firebase yang berbeda.','Periksa FIREBASE_PROJECT_ID dan gunakan project brandal-bet.'],
  auth_service_unconfigured: ['FIREBASE_AUTH','Cloudflare Worker','Firebase verifier configuration','Konfigurasi verifikasi Firebase backend belum lengkap.','Lengkapi konfigurasi Firebase backend tanpa menaruh secret di Blogger.'],
  auth_verifier_runtime_error: ['FIREBASE_AUTH','Cloudflare Worker','Firebase ID Token verification','Verifier Firebase mengalami kesalahan runtime.','Periksa log Worker menggunakan Request ID yang ditampilkan.'],
  origin_not_allowed: ['CORS','Cloudflare Worker','Origin validation','Origin website belum diizinkan oleh backend.','Pastikan origin Blogger terdaftar pada ALLOWED_MEMBER_ORIGINS atau ALLOWED_BACKOFFICE_ORIGINS.'],
  forbidden: ['AUTHORIZATION','Cloudflare Worker','RBAC authorization','Akun terautentikasi tetapi tidak memiliki hak akses endpoint.','Periksa custom claims dan role akun.'],
  member_session_required: ['MEMBER_DEVICE_SESSION','Cloudflare Worker + Firestore','Member device session','Sesi perangkat member belum aktif atau belum diklaim.','Claim ulang device session lalu ulangi operasi.'],
  member_session_replaced: ['MEMBER_DEVICE_SESSION','Cloudflare Worker + Firestore','Member device session','Sesi member digantikan oleh perangkat lain.','Login kembali pada perangkat yang ingin dipakai.'],
  invalid_member_session: ['MEMBER_DEVICE_SESSION','Cloudflare Worker','Member device session payload','Data sesi perangkat tidak valid.','Buat sesi perangkat baru dan ulangi login.'],
  username_taken: ['ONBOARDING_USERNAME','Firestore','Username transaction','Username sudah digunakan akun lain.','Pilih username lain.'],
  username_locked: ['ONBOARDING_USERNAME','Firestore','Username transaction','Username akun sudah terkunci dan tidak dapat diganti.','Gunakan username yang sudah terkait dengan akun tersebut atau minta operator memeriksa akun.'],
  invalid_referral_code: ['ONBOARDING_REFERRAL','Firestore','Referral validation','Kode referral tidak valid atau tidak aktif.','Kosongkan referral atau gunakan kode referral yang valid.'],
  referral_locked: ['ONBOARDING_REFERRAL','Firestore','Referral transaction','Referral akun sudah terkunci ke referral sebelumnya.','Gunakan referral yang sudah tersimpan atau minta operator memeriksa akun.'],
  self_referral_not_allowed: ['ONBOARDING_REFERRAL','Firestore','Referral validation','Akun mencoba menggunakan referral miliknya sendiri.','Gunakan kode referral milik member lain.'],
  unsupported_payment_provider: ['ONBOARDING_BANK','Backend','Bank/e-wallet validation','Provider pembayaran yang dipilih tidak didukung.','Pilih provider yang tersedia.'],
  invalid_account_number: ['ONBOARDING_BANK','Backend','Bank/e-wallet validation','Nomor rekening atau E-Wallet tidak memenuhi validasi backend.','Periksa nomor rekening/E-Wallet lalu kirim ulang.'],
  invalid_account_name: ['ONBOARDING_BANK','Backend','Bank/e-wallet validation','Nama pemilik rekening/E-Wallet tidak memenuhi validasi backend.','Periksa nama pemilik lalu kirim ulang.'],
  registration_disabled: ['REGISTRATION_CONTROL','Firestore','Master control','Pendaftaran member sedang dinonaktifkan.','Aktifkan registrationEnabled dari Backoffice bila memang ingin menerima pendaftaran.'],
  maintenance_mode: ['REGISTRATION_CONTROL','Firestore','Master control','Sistem sedang dalam maintenance mode.','Tunggu maintenance selesai atau periksa System Control di Backoffice.'],
  onboarding_incomplete: ['MEMBER_SESSION','Firestore','Member profile/onboarding','Akun Firebase ada tetapi profil member belum menyelesaikan onboarding.','Lanjutkan pemulihan pendaftaran dan simpan data profil + bank.'],
  member_backend_unavailable: ['NETWORK','Cloudflare Worker','Member API request','Browser tidak memperoleh respons backend yang dapat diproses.','Periksa koneksi, Worker deployment, CORS, dan Request ID.'],
  service_unavailable: ['BACKEND_RUNTIME','Cloudflare Worker','Backend runtime','Backend mengalami error yang tidak dapat dipetakan sebagai error domain.','Periksa log Cloudflare Worker menggunakan Request ID.'],
  internal_error: ['BACKEND_RUNTIME','Cloudflare Worker','Backend runtime','Terjadi error internal yang tidak aman untuk ditampilkan sebagai stack trace.','Periksa log Worker menggunakan Request ID.'],
  backend_handler_unavailable: ['BACKEND_ROUTER','Cloudflare Worker','Handler loading','Modul endpoint gagal dimuat oleh Worker.','Periksa deployment/bundle Worker menggunakan Request ID.'],
  not_found: ['ROUTING','Cloudflare Worker','API routing','Endpoint yang diminta tidak tersedia.','Periksa path API pada Blogger dan daftar route Worker.'],
  method_not_allowed: ['ROUTING','Cloudflare Worker','HTTP method','Method HTTP tidak didukung endpoint.','Gunakan method yang ditentukan endpoint.'],
  invalid_json: ['REQUEST_VALIDATION','Cloudflare Worker','JSON parser','Body request bukan JSON yang valid.','Kirim payload JSON yang valid.'],
  invalid_onboarding_payload: ['ONBOARDING_VALIDATION','Cloudflare Worker','Onboarding payload','Payload pendaftaran tidak valid.','Periksa seluruh field pendaftaran sebelum mengirim ulang.']
});

export function requestIdFromEvent(event) {
  const raw = event?.headers?.['x-request-id'] ?? event?.headers?.['X-Request-ID'] ?? event?.headers?.['X-Request-Id'];
  if (typeof raw === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(raw)) return raw;
  return crypto.randomUUID();
}

export function diagnosticFor(error, { event, scope = 'member', actor = null, operation = null, stage = null, component = null, statusCode = null } = {}) {
  const code = String(error?.code || 'internal_error');
  const info = CODE_INFO[code];
  const path = event?.path || event?.rawUrl || 'unknown endpoint';
  const httpStatus = Number(error?.statusCode || statusCode || 500);
  const fallbackStage = scope === 'backoffice' ? 'BACKOFFICE_API' : 'MEMBER_API';
  const inferred = info || [fallbackStage, 'Cloudflare Worker', operation || path, 'Backend mengembalikan error.', 'Periksa detail error dan Request ID.'];
  const uid = typeof actor?.uid === 'string' ? actor.uid : null;
  const role = typeof actor?.role === 'string' ? actor.role : (typeof actor?.claims?.role === 'string' ? actor.claims.role : null);
  return {
    code,
    httpStatus,
    stage: stage || inferred[0],
    component: component || inferred[1],
    operation: operation || inferred[2] || path,
    requestId: requestIdFromEvent(event),
    timestamp: new Date().toISOString(),
    message: typeof error?.safeMessage === 'string' ? error.safeMessage : inferred[3],
    cause: typeof error?.causeCode === 'string' ? error.causeCode : code,
    action: typeof error?.action === 'string' ? error.action : inferred[4],
    safeContext: {
      scope,
      uid,
      role,
      firebaseAuthenticated: Boolean(actor?.uid),
      memberSession: code === 'member_session_replaced' ? 'replaced' : code === 'member_session_required' ? 'required' : 'not_reported'
    }
  };
}

export function diagnosticResponse(error, options = {}) {
  const diagnostic = diagnosticFor(error, options);
  return { ok: false, error: diagnostic.code, diagnostic };
}
