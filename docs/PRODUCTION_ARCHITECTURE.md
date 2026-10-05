# BrandalBet Production Architecture

## Source of truth
Production uses this path only:
Blogger Member/Backoffice -> Firebase Authentication -> Firebase ID Token -> Cloudflare Worker -> Firestore / wallet / immutable ledger -> GoldslotPalase

## Explicitly retired
- Netlify production functions
- Deno production endpoints
- Client-side provider credentials
- Client-side wallet/payment authority

Do not add Netlify or Deno endpoints back to member or backoffice production configuration.

## Catalog
Normal catalog reads use the normalized persisted catalog/snapshot exposed by Cloudflare. Live provider catalog calls are reserved for explicit administrative synchronization. Preserve last-known-good catalog data when provider synchronization fails.

## Game launch
A launch request is authenticated and authorized by Cloudflare. The server validates member/session/game/provider state and obtains a fresh provider game URL. Provider credentials never reach Blogger. Financial mutations must be idempotent and auditable.

## CORS
Authenticated APIs use exact origin allow-lists. Wildcard origins are forbidden. Controlled responses must preserve appropriate CORS headers for an already validated origin so browser errors remain diagnosable without weakening the policy.

## Secrets
Firebase administrative credentials, provider tokens, payment credentials, callback secrets, passwords and PINs are server-side only and must never be committed to Blogger XML, source control, browser storage, UI errors or logs.

## Production gate
A change is not production-ready until repository validation and the relevant authenticated browser E2E checks pass. Live Goldslot game launch and financial flows require real-provider acceptance evidence; static validation alone is insufficient.
