# Canonical Integration Change Log

This log documents incremental changes made while integrating the canonical validation and agreement generation flow into the onboarding app.

Date format: YYYY-MM-DD (24h time optional). Repository root unless specified.

---

## 2025-09-29 — Phase 1: Bootstrap + Validation Route

Summary
- Added baseline canonical wiring: health check and discount validation route in the root server.
- Extended security/capacity controls (CSP + per-route rate limit).
- Introduced helper functions and SKY token refresh bridge to canonical_flow.

Files Changed
- `server.js`
  - Helmet CSP `connectSrc`: added `https://api.sky.blackbaud.com`, `https://oauth2.sky.blackbaud.com`.
  - Per-route rate limiter `discountLimiter` for `/discount-check` (5 req/min/IP).
  - New auth helper `verifyInternalOrJWT` allowing either `X-Auth-Token` (internal) or the existing JWT (dashboard flows).
  - Helper `runSkyRefresh()` that spawns `canonical_flow/oauth_refresh.js` to refresh SKY tokens on 401 and reloads env.
  - Helper `updateMemberValidation()` to persist minimal validation outcome to Airtable Team Members with overridable field names.
  - Helper `ymd()` to format dates as `YYYY-MM-DD`.
  - Route `GET /healthz` returning `{ success: true, data: { ok: true } }`.
  - Route `POST /discount-check` implementing the canonical validation call via `canonical_flow/validation/blackbaudDiscountValidator.js` + optional Airtable update.

Artifacts/Docs Updated
- `docs/canonical-integration-spec.md`: appended a “Repository Review & Detailed Implementation Plan” tailored to this app (router extraction approach, tests, env aliasing, rollout steps, risks).

What You Need To Do Now (Required)
- Environment variables: add/update these in `.env` (and mirror in `env.example` without secrets).
  - `AUTH_TOKEN` — internal automation token for canonical endpoints.
  - Blackbaud SKY (for validation):
    - `SKY_CLIENT_ID`
    - `SKY_CLIENT_SECRET`
    - `SKY_REFRESH_TOKEN`
    - One of: `SKY_SUBSCRIPTION_KEY` or `SKY_SUBSCRIPTION_KEYS` (comma-separated)
    - Optional (will be refreshed automatically on 401): `SKY_ACCESS_TOKEN`
  - Airtable (already present in repo):
    - `AIRTABLE_API_KEY`
    - `AIRTABLE_BASE_ID`
    - `TEAM_MEMBERS_TABLE_ID` (used by the new Airtable update helper)
  - Optional field overrides (only if your Airtable schema differs):
    - `AIRTABLE_MEMBERS_VALIDATED_SELECT_FIELD` (default: `Discount Validated`)
    - `AIRTABLE_MEMBERS_VALID_DATE_FIELD` (default: `Discount Valid Date`)
    - `AIRTABLE_MEMBERS_DISCOUNT_EXPIRES_FIELD` (default: `Discount Expires`)
    - `AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD` (default: `Discount Category`)
    - `AIRTABLE_MEMBERS_INTERNAL_ID_FIELD` (default: `UTS ID`)
    - `AIRTABLE_MEMBERS_NAME_FIELD` (default: `Name`)
    - `AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD` (default: `UTS Email`)
    - `AIRTABLE_MEMBERS_DOB_FIELD` (default: `Date of birth*`, then falls back to `Date of Birth`/`DOB`)

Schema Prereqs (Airtable)
- Ensure Team Members table includes the following fields (or set overrides above):
  - `Discount Validated` (single select; values commonly: `Valid`, `Invalid`, `Ambiguous`, `Qualifies for Other`)
  - `Discount Valid Date` (date)
  - `Discount Expires` (date; used for alumni expiry if derivable)
  - `Discount Category` (expected bucket selected by operator/user)
  - `UTS ID` (internal lookup identifier used as `search_id`)

How To Test (Manual)
- Health check:
  - `GET http://localhost:<PORT>/healthz`
  - Expect `{ success: true, data: { ok: true } }`.
- Discount validation (internal token auth):
  - Request:
    - `POST http://localhost:<PORT>/discount-check?debug=1`
    - Headers: `Content-Type: application/json`, `X-Auth-Token: <AUTH_TOKEN>`
    - Body examples:
      - Minimal (by search id only): `{ "search_id": "<UTS_ID>" }`
      - Using a Team Member record: `{ "memberRecordId": "recXXXX", "expected": "Current UTS Staff" }`
  - Response:
    - 200 → `{ success: true, data: { input, result, airtableUpdate? } }`
    - 400 → Missing identifiers
    - 401 → Bad/missing auth
    - 502 → Upstream SKY/Airtable issues (message describes)
  - Notes:
    - On 401 from SKY, server runs `canonical_flow/oauth_refresh.js` then retries once.
    - When `memberRecordId` + `updateAirtable=true`, minimal fields are patched to Team Members.

Operational Notes
- No new NPM dependencies added yet for this phase; validation uses the canonical validator (`https` under the hood) and the existing Airtable SDK instance.
- CSP already allows Airtable; we added SKY domains. If you embed other CDNs later, update CSP arrays accordingly.
- Rate limiting: global 100/15m remains; `/discount-check` has 5/min per IP.

Planned Next (Phase 2)
- Add canonical generation endpoints to `server.js`:
  - `POST /validate-and-generate`
  - `POST /pdf-url`
  - `GET /download/:token`
- Add a second per-route limiter for `/validate-and-generate` (e.g., 5/min/IP with IP+startup keying).
- Introduce generation dependencies: `fs-extra`, `pdf-lib`, `@pdf-lib/fontkit`, `@signpdf/signpdf`, `@signpdf/placeholder-plain`, `@signpdf/signer-p12`.
- Extend `.env`/`env.example` with: `PRICING_TABLE_ID` (Airtable), `PUBLIC_BASE_URL`, `URL_TTL_SECONDS`, `PDF_OUTDIR`, `TERMS_URL`, optional `P12_PATH`, `P12_PASSPHRASE`.
- UI: add a “Discount & Agreement” panel to dashboard calling the new endpoints.
- Tests: add Jest + Supertest + Nock covering validation and generation flows.

---

## 2025-09-29 — Phase 1A: Validation Testing Plan

Objective
- Prove the `/discount-check` route works end-to-end with SKY and Airtable and that minimal fields are persisted correctly.

Pre‑Test Checklist (Required)
- `.env` contains:
  - `AUTH_TOKEN=<random-long-secret>`
  - `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `TEAM_MEMBERS_TABLE_ID`
  - `SKY_CLIENT_ID`, `SKY_CLIENT_SECRET`, `SKY_REFRESH_TOKEN`, and `SKY_SUBSCRIPTION_KEY` (or `SKY_SUBSCRIPTION_KEYS`)
  - Optional: `SKY_ACCESS_TOKEN` (will be refreshed on first 401)
- Airtable Team Members table has fields (or set overrides): `Discount Validated`, `Discount Valid Date`, `Discount Expires`, `Discount Category`, and `UTS ID`.

Start the Server
- `npm run dev` (or `npm start`) — watch console for `UTS Startup Portal running`.

Manual Tests (Automation Token)
1) Healthy:
   - `GET http://localhost:<PORT>/healthz` → `{ success: true, data: { ok: true } }`.

2) Validate by Team Member record:
   - Request:
     - `POST http://localhost:<PORT>/discount-check?debug=1`
     - Headers: `Content-Type: application/json`, `X-Auth-Token: <AUTH_TOKEN>`
     - Body: `{ "memberRecordId": "recXXXXXXXX", "expected": "Current UTS Staff" }`
   - Expect:
     - `200` with `{ success: true, data: { input, result, airtableUpdate } }`.
     - On SKY 401 the server refreshes and retries once automatically.
     - Airtable Team Member updated with selection, valid date, and expiry (if alumni) unless `updateAirtable=false`.

3) Validate by explicit fields (no Airtable read):
   - Body: `{ "search_id": "<UTS_ID>", "expected": "UTS Alumni (graduated within the last 12 months)", "email": "x@y.z", "name": "First Last", "dob": "1990-01-01" }`.

4) No identifiers → 400:
   - Body: `{}` → Expect `{ success: false, message: 'Missing search_id...' }`.

5) Rate limit (route‑level):
   - Send >5 requests within 60s from same IP → Expect `429 Too Many Requests` on extras.

6) Disable Airtable update:
   - Body: `{ "memberRecordId": "recXXXXXXXX", "updateAirtable": false }` → expect `airtableUpdate` omitted or `{ ok: false/skipped }` and no changes in Airtable.

Manual Tests (JWT Path)
- Use a fresh magic link (valid 15 minutes) and include the JWT in body:
  - Body: `{ "token": "<JWT>", "memberRecordId": "recXXXXXXXX" }` (no `X-Auth-Token` header).
- Expect same response shape/behavior.

Troubleshooting
- `401 Unauthorized`: missing/incorrect `X-Auth-Token` or expired/invalid JWT.
- `502 Upstream validation error`: SKY or Airtable issue; check console logs; rerun with `?debug=1`.
- `404/NOT_FOUND`: if using `memberRecordId`, ensure the record exists and `TEAM_MEMBERS_TABLE_ID` is correct.

Next After Validation Passes
- Implement generation endpoints (`/validate-and-generate`, `/pdf-url`, `/download/:token`).
- Add tests (Jest + Supertest + Nock) to lock in route behavior and error paths.
