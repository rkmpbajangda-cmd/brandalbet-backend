# BrandalBet Cloudflare-only runtime

Cloudflare Workers is the only supported backend runtime for production and staging.

## Runtime contract

- Entrypoint: `cloudflare-worker.js`.
- API router: `cloudflare-router.js`.
- Handler modules: `cloudflare/functions/`.
- Public API namespace: `/api/*` only.
- Worker liveness: `/health`.
- Scheduled reward settlement: Cloudflare Cron Trigger.
- Firebase Auth and Firestore remain the authentication and database services.
- GoldslotPalase and future payment adapters are called server-side from the Worker only.
- Production credentials are Cloudflare Secrets and must never be shipped to Blogger or committed to Git.

Legacy Netlify and Deno runtime files, tooling, public aliases, and build dependencies are intentionally removed. The route `/.netlify/functions/*` is not a supported API surface.

## Release validation

`npm run validate` must pass before merge. It performs syntax validation, the full Node test suite, Cloudflare configuration/runtime guards, and a Wrangler dry-run bundle.

Financial gates remain fail-closed until the corresponding real provider contracts are verified. In particular, reward settlement requires an authoritative verified GoldslotPalase settled-round/report source; provider wallet transfer differences are not treated as game loss.
