# SKY API OAuth — Re‑Authorization vs. Refresh

## Short Answer
After a one‑time user consent (authorization code flow), you should not need to repeat the manual authorization step if your service correctly handles non‑interactive refresh. Store the refresh token and exchange it for new access tokens as needed. Re‑authorize only if the refresh token expires or is revoked, or if scopes/ownership change.

## How SKY OAuth Works
- Flow: Authorization Code → Access Token (short‑lived) + Refresh Token (long‑lived). Keep the refresh token and use it server‑side to mint new access tokens without user interaction.
- Access token lifetime: typically ~60 minutes; when expired, call `/token` with `grant_type=refresh_token`.
- Refresh token lifetime: commonly documented as up to 365 days from when that specific refresh token was issued (not sliding by default).
- Token endpoint: `POST https://oauth2.sky.blackbaud.com/token` using HTTP Basic auth (`client_id:client_secret`). Include `Bb-Api-Subscription-Key` on subsequent API calls.

## Refresh Tokens: Rotation vs. Preservation
- Default rotation: Each successful refresh returns a new refresh token. Persist the returned refresh token and discard the old one to avoid stale‑token failures.
- Preservation option: Add `preserve_refresh_token=true` in the refresh request body to keep using the same refresh token value. This can reduce concurrency issues in distributed setups, but the original fixed expiry still applies.

## When You Must Re‑Authorize (Manual Step)
- Refresh token is expired (past its fixed lifetime) or revoked → `/token` returns `invalid_grant`.
- Scopes change or app ownership/environment access changes → admin approval needed.
- Client secret rotation without updating your app’s secret → refresh requests fail auth until corrected.
- Org/user loses required access → authorization must be redone.

## Operational Signals and Handling
- 401 from API call → likely expired access token; refresh and retry.
- `/token` returns `invalid_grant` → refresh token invalid/expired; trigger re‑authorization and alert.
- Transient timeouts to OAuth servers occur; retry with exponential backoff.
- Authorization URL updates have occurred historically; legacy URLs may redirect to `app.blackbaud.com/oauth/authorize`.

## Endpoints, Headers, and Shapes
- Refresh access token:
  - `POST https://oauth2.sky.blackbaud.com/token`
  - Auth: HTTP Basic (`Authorization: Basic base64(client_id:client_secret)`)
  - Body (form‑encoded): `grant_type=refresh_token&refresh_token=...&preserve_refresh_token=true` (last param optional)
- API requests:
  - Headers: `Authorization: Bearer <access_token>` and `Bb-Api-Subscription-Key: <your_subscription_key>`

## Why You May Have Needed to Re‑Authorize Recently
- Fixed‑lifetime refresh token expired (especially if using `preserve_refresh_token=true`, which is not sliding).
- Service failed to persist the newly returned refresh token (under rotation), leaving workers with a stale token.
- Client secret or scope changes invalidated the existing grant.

## Recommendations for This Repository
- Implement non‑interactive refresh (firm requirement) and on every successful refresh either:
  - Store and propagate the newly returned refresh token (rotation), or
  - Use `preserve_refresh_token=true` and schedule an admin re‑authorization before the fixed lifetime ends.
- Treat `/token` `invalid_grant` as a hard fail: alert and require manual re‑auth.
- Ensure all API calls include `Authorization: Bearer <access_token>` and `Bb-Api-Subscription-Key`.
- Map to env in this repo: `SKY_ACCESS_TOKEN`, `SKY_REFRESH_TOKEN`, `SKY_CLIENT_ID`, `SKY_CLIENT_SECRET`, `SKY_SUBSCRIPTION_KEY`.

## References
- SKY OAuth refresh (Auth Code flow steps): https://github.com/blackbaud/sky-api-docs/blob/master/includes/authcodeflow/step7.md
- Headless refresh examples (community repos): https://github.com/blackbaud/skyapi-headless-data-sync
- Refresh token preservation discussion: https://blackbaud.vanillacommunities.com/discussion/47043/oauth-property-for-preserving-refresh-tokens
- New authorization URL announcement: https://community.blackbaud.com/discussion/59173/new-oauth-2-0-authorization-url
- Common 401/expired token discussions: https://community.blackbaud.com/discussion/51143/payment-sky-api-401-error-token-expired
- Refresh timeouts/backoff discussion: https://community.blackbaud.com/discussion/68206/connection-timed-out-while-trying-to-refresh-the-access-token

> Note: Provider behavior and lifetimes can change. Always verify against the latest official SKY API documentation before making production changes.

