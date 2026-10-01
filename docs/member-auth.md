# Brandalbet Member Auth + Onboarding

## Flow

1. Blogger Member creates or signs in with Firebase Email/Password.
2. Browser obtains a Firebase ID Token.
3. Every protected request sends `Authorization: Bearer <ID_TOKEN>`.
4. Backend verifies the token with Firebase Admin using revocation checks.
5. New registrations call `POST /.netlify/functions/member-onboarding`.
6. Onboarding atomically reserves a unique username, creates/updates the user profile, creates a zero-balance IDR wallet if missing, and stores the member bank/e-wallet record server-side.
7. Login calls `GET /.netlify/functions/member-session` before member access is considered ready.
8. Bank data returned to the browser is masked; the full account number is never returned by the bank endpoint or session response.

## Member endpoints

- `GET /.netlify/functions/member-session`
- `POST /.netlify/functions/member-onboarding`
- `GET|PUT /.netlify/functions/member-profile`
- `GET|PUT /.netlify/functions/member-bank-account`
- `GET /.netlify/functions/wallet`

All endpoints except public health require a valid Firebase ID Token.

## Firebase console requirements

- Authentication → Sign-in method → Email/Password: enabled.
- Authentication → Settings → Authorized domains: add the exact Blogger member hostname and the custom member domain when used.
- Firestore database must exist in the same Firebase project used by Firebase Admin.
- Keep Firestore client rules deny-by-default when all member data access goes through the backend.
- Firebase Admin service account values stay only in Netlify environment variables.

## Netlify environment

Required names:

`FIREBASE_PROJECT_ID`
`FIREBASE_CLIENT_EMAIL`
`FIREBASE_PRIVATE_KEY`
`ALLOWED_MEMBER_ORIGINS`
`ALLOWED_BACKOFFICE_ORIGINS`

`ALLOWED_MEMBER_ORIGINS` must contain the exact origins that serve the member XML, comma separated if there is more than one.

## Collections

- `users/{uid}`: member profile and onboarding state.
- `usernames/{lowercaseUsername}`: unique username reservation.
- `wallets/{uid}`: server-authoritative wallet.
- `memberBankAccounts/{uid}`: private bank/e-wallet record.

The browser must not read or write these collections directly.

## Security

- Public registration never accepts admin/operator/finance roles.
- Username uniqueness is enforced inside a Firestore transaction.
- Wallet creation is server-side and starts at zero.
- Bank account number is stored only in the private server collection and returned masked.
- Profile update rejects role, balance, wallet, and other privilege fields.
- CORS now explicitly allows authenticated `PUT` requests used by member profile and bank updates.
