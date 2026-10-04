# Deployment revision marker

This file intentionally contains no runtime configuration or secrets.

Purpose: create a fresh `main` branch push after the Cloudflare optional-secret hotfix so Workers Builds fetches the current `wrangler.jsonc` instead of retrying an older build commit.

Current expected deployment contract:
- `FIREBASE_SERVICE_ACCOUNT_JSON`: required Cloudflare secret
- `GOLDSLOTPALASE_API_TOKEN`: required Cloudflare secret
- `BOOTSTRAP_SUPERADMIN_UID`: optional, feature-scoped Cloudflare secret
- `PAYMENT_CONFIG_ENCRYPTION_KEY`: optional, feature-scoped Cloudflare secret
- `BOOTSTRAP_ENABLED=false` by default
- financial/provider mutation gates remain fail-closed
