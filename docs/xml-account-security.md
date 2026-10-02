# Account XML security review — 2026-10-02

This change is limited to defensive account-session behavior. It does not complete production deployment or add business integrations.

## Backoffice template

- Hide the admin interface immediately on logout and authentication changes.
- Reject delayed authorization results from a previous session; a previous failure cannot sign out a new account.
- Require an explicit successful JSON response before opening the admin interface.
- Bound authorization requests to 15 seconds, disable caching and redirects, and do not retry automatically.
- Show safe user-facing connection errors.

## Member XML

The existing Library member file BRANDALBET_MEMBER_GAME_PAGE_V36.xml was updated separately, preserving its identity and layout:

- Clear the displayed profile immediately on an authentication change.
- Ignore responses belonging to a previous authentication session.
- Reject malformed account API responses and bound requests to 15 seconds.
- Render account notices as plain text.
- Clear the modal login password after submission finishes.
- Do not delete newly created Firebase accounts when an onboarding/session request fails. Such a failure can be ambiguous: server writes may already have succeeded. Sign out that account and explain the recovery need instead.

## Verification and limits

Both XML files parse successfully. All five inline JavaScript blocks pass node syntax checking. Eight focused tests pass: four committed backoffice session tests, plus four member tests executed against the materialized XML. Tests use mocked auth/network/DOM and Node 24. They do not prove Blogger rendering or production login.

Member XML still contains the previous backend address (playful-biscuit-33cfee.netlify.app); backoffice targets verdant-tiramisu-efb2f9.netlify.app. Their deployment identity, Firebase project configuration, allowed origins and live account access have not been verified together. Do not treat these templates as an end-to-end production release.

An account with incomplete onboarding needs a separately reviewed recovery path. Automatic deletion is intentionally removed to avoid data loss. Production backend readiness remains documented in production-status.md.
