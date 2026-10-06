# 🚀 BRANDALBET BACKEND - COMPLETE DEPLOYMENT GUIDE

**Project**: Brandalbet Gaming Platform  
**Backend**: Cloudflare Workers  
**Database**: Firebase Firestore  
**Authentication**: Firebase Auth  
**Member Domain**: https://brandalbet.blogspot.com  
**Backoffice Domain**: https://backoffic.blogspot.com  
**Worker URL**: https://brandalbet-backend.rkmpbajangda.workers.dev

---

## 📋 PRE-DEPLOYMENT CHECKLIST

### ✅ Secrets Verification (CRITICAL)

All 3 secrets MUST be set in Cloudflare before any deployment:

```bash
# Verify in Cloudflare Dashboard
# Workers → brandalbet-backend → Settings → Variables → Secrets
```

Required secrets:
- [ ] `FIREBASE_SERVICE_ACCOUNT_JSON` ✓ SET
  - Must be valid JSON
  - Must contain: `project_id`, `private_key`, `client_email`
  - `project_id` must equal `brandal-bet`
  - NOT null or empty
  
- [ ] `GOLDSLOTPALASE_API_TOKEN` ✓ SET
  - Must not be empty
  - Must be valid token from provider
  
- [ ] `GOLDSLOTPALASE_CALLBACK_TOKEN` ✓ SET
  - Must not be empty
  - Used for webhook validation

**If any secret is missing or invalid, worker will fail with 503 errors.**

### ✅ Environment Variables

Check `wrangler.jsonc` for correct configuration:

```json
{
  "FIREBASE_PROJECT_ID": "brandal-bet",
  "ALLOWED_MEMBER_ORIGINS": "https://brandalbet.blogspot.com",
  "ALLOWED_BACKOFFICE_ORIGINS": "https://backoffic.blogspot.com",
  "MEMBER_SINGLE_SESSION_ENABLED": "true",
  "BOOTSTRAP_ENABLED": "false"
}
```

- [ ] Firebase Project ID: `brandal-bet` ✓
- [ ] Member origin: `https://brandalbet.blogspot.com` ✓
- [ ] Backoffice origin: `https://backoffic.blogspot.com` ✓
- [ ] Single session: `true` (one device per member)
- [ ] Bootstrap: `false` (production safe)

### ✅ Firebase Configuration

- [ ] Firebase project `brandal-bet` created
- [ ] Firebase Auth enabled
- [ ] Firestore database in production mode
- [ ] Service account with Firestore Admin permissions
- [ ] Collections created (see section 2.1)
- [ ] Security rules deployed
- [ ] Backup enabled
- [ ] Audit logging enabled

### ✅ Firestore Collections (MUST EXIST)

Create all these collections in Firestore (can be empty):

```
users                      # Member profiles
wallets                    # Member account balances
ledger                     # Transaction history
sessions                   # Device/session tracking
providerPlayers            # Goldslot member mapping
providerPlayerCodes        # Reverse lookup cache
providerGameRounds         # Game round state
providerSyncStates         # Sync cursor & lease state
settledGameRounds          # Finalized game records
rewardWeeklyMembers        # Weekly cashback aggregates
rewardTurnover             # Reward obligation tracking
rewardPayouts              # Payout history
rewardWeekFinalizations    # Batch finalization state
referrals                  # Promoter/member bindings
referralCodes              # Referral code registry
promotions                 # Active campaigns
auditEvents                # Admin action audit log
```

**Create via Firebase Console**:
1. Firestore Database
2. Create Collection (each name above)
3. Add at least 1 document in each (can be minimal data)

### ✅ Firestore Security Rules

Deploy security rules to protect collections:

```bash
firebase deploy --only firestore:rules --project=brandal-bet
```

**Rules must**:
- Allow Firebase Admin SDK full access
- Block client-side access (deny by default)
- Allow Auth endpoints only
- Validate ID tokens

---

## 🔧 STEP 1: LOCAL VALIDATION

### Install Dependencies

```bash
cd brandalbet-backend
npm ci
```

### Run Full Validation

```bash
npm run validate
```

This runs:
- `npm run check` - Syntax validation
- `npm test` - Unit tests
- `npm run build:cloudflare` - Build worker
- `npm run bundle:cloudflare` - Dry-run bundle

**Expected**: All checks pass ✓

If validation fails:
```bash
# Check error details
npm run check        # Syntax issues?
npm test             # Test failures?
npm run build:cloudflare  # Build errors?
```

### Common Validation Errors

**Error: Firebase config missing**
```
FirebaseConfigError: Firebase Admin configuration is incomplete
```
**Fix**: Verify secrets are set correctly in Cloudflare

**Error: Module not found**
```
Cannot find module 'firebase-admin'
```
**Fix**: Run `npm ci` again to install dependencies

**Error: Build failed**
```
wrangler build returned non-zero exit code
```
**Fix**: Check `cloudflare-worker.js` and `cloudflare-router.js` syntax

---

## 🚀 STEP 2: DEPLOY TO CLOUDFLARE

### Deploy Command

```bash
npm run deploy:cloudflare
```

**Expected output**:
```
✓ Deployed brandalbet-backend successfully
  https://brandalbet-backend.rkmpbajangda.workers.dev
```

### Verify Deployment

```bash
# Check worker is live
curl -i https://brandalbet-backend.rkmpbajangda.workers.dev/health

# Expected response (HTTP 200):
# {
#   "ok": true,
#   "service": "brandalbet-backend",
#   "runtime": "cloudflare-workers"
# }
```

If deployment fails:
```bash
# Check build
npm run build:cloudflare

# Check wrangler config
wrangler publish --dry-run

# View logs
wrangler tail
```

---

## ✅ STEP 3: POST-DEPLOYMENT VERIFICATION

### 3.1 Health Endpoints

**Public health (no auth required)**:
```bash
curl https://brandalbet-backend.rkmpbajangda.workers.dev/health
curl https://brandalbet-backend.rkmpbajangda.workers.dev/api/health
```

Both should return:
```json
{ "ok": true }
```

### 3.2 CORS Validation

**Test member origin**:
```bash
curl -H "Origin: https://brandalbet.blogspot.com" \
     -H "Access-Control-Request-Method: GET" \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/health

# Should include header:
# Access-Control-Allow-Origin: https://brandalbet.blogspot.com
```

**Test backoffice origin**:
```bash
curl -H "Origin: https://backoffic.blogspot.com" \
     -H "Access-Control-Request-Method: GET" \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/health

# Should include header:
# Access-Control-Allow-Origin: https://backoffic.blogspot.com
```

**Test invalid origin (should fail)**:
```bash
curl -H "Origin: https://evil.com" \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/me

# Should return 403 Forbidden
```

### 3.3 Firebase Authentication

Test with valid Firebase ID token:

```bash
# 1. Get ID token from Firebase
# From member app: firebase.auth().currentUser.getIdToken()
# Store in variable: ID_TOKEN="eyJhbGc..."

# 2. Test member endpoint
curl -H "Authorization: Bearer $ID_TOKEN" \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/me

# Expected: Member data with uid, email, etc.
```

### 3.4 Run Full Test Suite

```bash
# Without tokens (basic tests only)
node scripts/test-api.mjs

# With member token
node scripts/test-api.mjs "eyJhbGc..."

# With member + admin tokens
node scripts/test-api.mjs "eyJhbGc..." "eyJhbGc..."
```

---

## 📝 STEP 4: CONFIGURE PULL REQUESTS

### PR #29: Recovery - Restore Backend Validation Baseline

**Status**: Ready to merge  
**Branch**: `recovery/production-stabilization-20261006`

```bash
# Verify branch is clean
git checkout recovery/production-stabilization-20261006
npm run validate

# Merge to main
git checkout main
git pull origin main
git merge recovery/production-stabilization-20261006

# Push
git push origin main

# Verify deployed
curl https://brandalbet-backend.rkmpbajangda.workers.dev/health
```

### PR #28: Harden Firebase + Cloudflare Architecture

**Status**: DRAFT (needs completion)  
**Branch**: `audit/backoffice-v6-operator-console`

```bash
# Checkout branch
git checkout audit/backoffice-v6-operator-console

# Implement CORS helper (already in src/middleware/cors.js)
# Run validation
npm run validate

# If passes: mark PR ready for review
# After review: merge to main
git checkout main
git merge audit/backoffice-v6-operator-console
git push origin main
```

---

## 🧪 STEP 5: COMPREHENSIVE TESTING

### 5.1 Member Login Flow

```javascript
// web-member/src/pages/Login.js
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '../config/firebase';

async function handleLogin(email, password) {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const idToken = await userCredential.user.getIdToken();
    
    // Test backend API
    const response = await fetch(
      'https://brandalbet-backend.rkmpbajangda.workers.dev/api/me',
      {
        headers: {
          'Authorization': `Bearer ${idToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (response.ok) {
      const memberData = await response.json();
      console.log('✓ Backend connected:', memberData);
      return memberData;
    } else {
      console.error('✗ Backend error:', response.status);
    }
  } catch (error) {
    console.error('✗ Login failed:', error);
  }
}
```

### 5.2 Backoffice Admin Flow

```javascript
// backoffice/src/pages/Admin.js
async function loadAdminDashboard() {
  const idToken = await getAdminToken(); // Get admin ID token
  
  const response = await fetch(
    'https://brandalbet-backend.rkmpbajangda.workers.dev/api/backoffice-dashboard',
    {
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  if (response.ok) {
    const dashboard = await response.json();
    console.log('✓ Admin dashboard loaded:', dashboard);
    return dashboard;
  } else if (response.status === 403) {
    console.error('✗ Admin access denied - check custom claims');
  } else if (response.status === 401) {
    console.error('✗ Token invalid or expired');
  }
}
```

### 5.3 Key Endpoints to Test

**Member endpoints**:
- `GET /api/me` - Get member profile
- `GET /api/wallet` - Get wallet balance
- `GET /api/games` - Get available games
- `GET /api/transactions` - Get transaction history
- `POST /api/member-profile` - Update profile
- `GET /api/member-device-session` - Current device session

**Backoffice endpoints**:
- `GET /api/backoffice-health` - Admin health check
- `GET /api/backoffice-dashboard` - Dashboard metrics
- `GET /api/backoffice-members` - Member list
- `GET /api/backoffice-ledger` - Ledger view
- `GET /api/backoffice-reports` - Reports

**Provider endpoints** (Goldslot):
- `POST /api/goldslot-callback` - Provider webhook
- `GET /api/games` - Game catalog (member)
- `GET /api/backoffice-game-catalog` - Catalog (admin)

---

## 🔐 STEP 6: SECURITY VALIDATION

### 6.1 ID Token Validation

Verify all member requests are validated:

```bash
# Should fail: no token
curl https://brandalbet-backend.rkmpbajangda.workers.dev/api/me
# Expected: 401 Unauthorized

# Should fail: invalid token
curl -H "Authorization: Bearer invalid" \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/me
# Expected: 401 Unauthorized

# Should fail: expired token
curl -H "Authorization: Bearer $EXPIRED_TOKEN" \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/me
# Expected: 401 Unauthorized

# Should succeed: valid token
curl -H "Authorization: Bearer $VALID_TOKEN" \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/me
# Expected: 200 OK with member data
```

### 6.2 Custom Claims Validation

Backoffice requires `backoffice: true` + `role: admin|superadmin`:

```bash
# Member token should be rejected
curl -H "Authorization: Bearer $MEMBER_TOKEN" \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/backoffice-dashboard
# Expected: 403 Forbidden

# Admin token should succeed
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/backoffice-dashboard
# Expected: 200 OK
```

### 6.3 Origin Validation

```bash
# Correct origin: allowed
curl -H "Origin: https://brandalbet.blogspot.com" \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/me
# Expected: correct CORS header

# Wrong origin: blocked
curl -H "Origin: https://attacker.com" \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/me
# Expected: 403 Forbidden or no CORS header
```

### 6.4 Payload Size Limits

```bash
# Large payload (should fail)
curl -X POST \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"data": "' $(head -c 200000 /dev/zero | tr '\0' 'x') '"}' \
     https://brandalbet-backend.rkmpbajangda.workers.dev/api/member-profile
# Expected: 413 Payload Too Large
```

---

## 🔄 STEP 7: MONITORING & LOGS

### Real-Time Logs

```bash
# Stream worker logs
wrangler tail

# Filter by level
wrangler tail --format json | grep error
```

### Log Format

All logs follow JSON structure:
```json
{
  "event": "cors_validation|api_call|error",
  "timestamp": "2026-10-06T12:00:00Z",
  "route": "endpoint_name",
  "status": "success|error",
  "details": {}
}
```

### Key Metrics to Monitor

- Worker CPU time (should be < 50ms)
- Firestore latency (< 200ms)
- Error rate (< 1%)
- CORS errors (should be 0 after validation)
- Auth errors (token validation failures)

---

## 🐛 TROUBLESHOOTING

### Issue: 503 Backend Router Unavailable

**Cause**: `cloudflare-router.js` failed to load  
**Solution**:
```bash
npm run build:cloudflare
npm run deploy:cloudflare
wrangler tail  # Check logs
```

### Issue: 401 Unauthorized on valid token

**Cause**: Token validation issue or Firebase config mismatch  
**Solution**:
```bash
# Verify Firebase project ID
echo $FIREBASE_SERVICE_ACCOUNT_JSON | jq '.project_id'
# Must equal "brandal-bet"

# Verify token is fresh (< 1 hour old)
# Get new token from Firebase Auth
```

### Issue: CORS errors in browser console

**Cause**: Origin not in allowlist or CORS header missing  
**Solution**:
```bash
# Verify origin matches exactly
# Must be: https://brandalbet.blogspot.com (no trailing slash)

# Check wrangler.jsonc
ALLOWED_MEMBER_ORIGINS=https://brandalbet.blogspot.com

# Redeploy if changed
npm run deploy:cloudflare
```

### Issue: 403 Forbidden on backoffice endpoints

**Cause**: Missing or wrong custom claims  
**Solution**:
```bash
# Set custom claims in Firebase:
# User claims:
{
  "backoffice": true,
  "role": "superadmin"  // or "admin"
}

# Use Firebase Admin SDK to set:
admin.auth().setCustomUserClaims(uid, {
  backoffice: true,
  role: 'superadmin'
})
```

### Issue: Firestore connection failed

**Cause**: Service account permissions or Firestore not enabled  
**Solution**:
```bash
# Verify Firestore is enabled
# Firebase Console → Firestore Database

# Verify service account has permissions
# IAM → Service Accounts → Select account
# Roles: Firestore Admin, Cloud Datastore Admin

# Test connection
firebase firestore:indexes --project=brandal-bet
```

---

## ✅ FINAL PRODUCTION CHECKLIST

Before considering the backend "live":

### Security
- [ ] All secrets set in Cloudflare (3/3)
- [ ] Firebase credentials valid
- [ ] CORS origins exact-matched
- [ ] ID token validation enforced
- [ ] No debug logging in production
- [ ] No credentials in git/logs
- [ ] Security rules deployed
- [ ] Rate limiting configured (if needed)

### Functionality
- [ ] Worker health: 200 OK
- [ ] API health: 200 OK
- [ ] Member login works end-to-end
- [ ] Member wallet accessible
- [ ] Member can fetch games
- [ ] Backoffice admin login works
- [ ] Backoffice dashboard loads
- [ ] CORS working for both origins
- [ ] Single session enforcement active
- [ ] All PRs merged to main

### Performance
- [ ] Worker response time < 500ms
- [ ] Firestore queries indexed
- [ ] No timeout errors
- [ ] Error rate < 1%
- [ ] Load test passed (100+ concurrent)

### Monitoring
- [ ] Logs streaming correctly
- [ ] Error alerts configured
- [ ] Runbook documented
- [ ] Team trained on procedures
- [ ] Incident response plan ready

### Data Protection
- [ ] Firestore backup enabled
- [ ] Firebase Auth export working
- [ ] Audit logging active
- [ ] No PII in logs
- [ ] GDPR compliance checked

---

## 📚 USEFUL COMMANDS

```bash
# Deploy
npm run deploy:cloudflare

# Validate
npm run validate

# Test
npm test
node scripts/test-api.mjs

# View logs
wrangler tail

# Check config
wrangler publish --dry-run

# List secrets
wrangler secret list

# Run locally
npm run dev
```

---

## 📞 SUPPORT RESOURCES

- **Firebase Console**: https://console.firebase.google.com/project/brandal-bet
- **Cloudflare Dashboard**: https://dash.cloudflare.com/workers
- **Worker Logs**: `wrangler tail`
- **GitHub Issues**: https://github.com/rkmpbajangda-cmd/brandalbet-backend/issues

---

**Generated**: 2026-10-06  
**Status**: ✅ READY FOR PRODUCTION DEPLOYMENT  
**Last Updated**: 2026-10-06

If all steps completed successfully, your backend is live and ready for member & backoffice traffic.
