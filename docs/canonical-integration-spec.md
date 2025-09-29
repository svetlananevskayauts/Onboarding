**Canonical Validation + Agreement Integration (System Contract)**
- Scope: unify onboarding, discount validation, and agreement generation within this repo.
- Audience: engineers and operators integrating the canonical flow into the onboarding app.

**Goals**
- Run Blackbaud RE NXT discount validation for team members (nominated persons) and persist minimal results.
- Generate a deterministic agreement PDF for the Startup, attach it to Airtable, and provide a secure, short‑lived download URL.
- Align env keys and Airtable fields with the existing repo; no renames of current keys.

**Actors**
- Startup (Startups table): organization being onboarded and contracted.
- Representative (Team Members): authorized signatory; `Representative` field indicates the debtor/signatory.
- Nominated Persons (Team Members): members with `Membership Type` (Full/Casual/Day) used for validation and pricing.
- Admin/Operator: can invoke internal APIs/E2E via `AUTH_TOKEN`.

**End‑to‑End Flows**
- Onboarding (existing):
  - Landing → `POST /lookup-email` → Magic link (JWT) → `GET /dashboard/:token` → embedded forms:
    - `GET /get-startup-form/:token` (Startup info)
    - `GET /get-representative-form/:token` (Representative)
    - `GET /get-team-members-form/:token` (Team/Nominated persons)
    - `GET /check-progress/:token`, `POST /complete-onboarding`
- Discount validation (canonical):
  - Trigger per member → `POST /discount-check` → persists minimal outcome to Team Members.
- Agreement generation (canonical):
  - Trigger per Startup → `POST /validate-and-generate` → builds payload from Startups + filtered Team Members → spawns generator → returns temp URL and attaches to Startups.
  - Utility: `POST /pdf-url` (returns a temp URL without attachment), `GET /download/:token` streams the PDF during TTL, `GET /healthz`.

**Backend Endpoints (Contract)**
- `POST /discount-check`
  - Auth: end‑user via JWT or internal via `X-Auth-Token: AUTH_TOKEN`.
  - Body (any one of memberRecordId or explicit inputs):
    - `memberRecordId` (string, Airtable rec id)
    - `search_id` (optional string; e.g., `UTS ID`)
    - `expected` (optional string; target Discount Category)
    - `email` (optional string)
    - `name` (optional string)
    - `dob` (optional string: `YYYY-MM-DD`, `DD/MM/YYYY`, etc.)
    - `updateAirtable` (boolean, default true)
    - `debug` (boolean)
  - 200 Response:
    - `{ success: true, data: { status, valid, qualifies_other, derived_buckets, alumni_expires_at, trace } }`
    - Side effects: updates Team Members fields (see “Airtable Schema”).
  - Errors: 400 (missing id), 401 (auth), 502 (SKY/Airtable), 429 (rate limit).

- `POST /validate-and-generate`
  - Auth: JWT or `X-Auth-Token`.
  - Body:
    - `startupRecordId` (string, required unless only `memberRecordId` is given and it links to a Startup)
    - `memberRecordId` (optional string; used to resolve linked Startup if `startupRecordId` omitted)
    - `validations` (optional array of `{ memberRecordId, expected }` to run before generating)
    - `ttlSeconds` (number; default 3600)
    - `filename` (optional string; default suggested by generator)
    - `saveLocal` (boolean; saves a local copy under `PDF_OUTDIR` when true)
    - `debug` (boolean)
  - 200 Response:
    - `{ success: true, validations: [...], pdf: { url, filename, expiresAt }, airtableAttachment: { ok, tableId, recordId, field, count }?, savedLocal? }`
    - Side effects: adds the generated PDF (via temp URL) to Startups `Agreement` attachment field.
  - Errors: 400 (insufficient data/pricing), 401, 409 (not eligible unless forced), 5xx.

- `POST /pdf-url`
  - Auth: JWT or `X-Auth-Token`.
  - Body: `{ startupRecordId?, memberRecordId?, filename?, ttlSeconds? }`
  - 200 Response: `{ success: true, url, filename, expiresAt }` (no Airtable attachment side effect).

- `GET /download/:token`
  - No auth (intentionally) for Airtable to fetch; time‑limited; returns `application/pdf` or 410 (expired).

- `GET /healthz`
  - `{ ok: true }` when healthy.

**Request/Response Examples**
- Discount check
  - Request: `POST /discount-check`
    - Body: `{ memberRecordId: "recMember123", expected: "Current UTS Staff" }`
  - Response: `{ success: true, data: { status: "valid", valid: true, derived_buckets: ["Current UTS Staff"], alumni_expires_at: null } }`

- Validate and generate
  - Request: `POST /validate-and-generate`
    - Body: `{ startupRecordId: "recStartup123", validations: [{ memberRecordId: "recMember123", expected: "Current UTS Staff" }], ttlSeconds: 1800 }`
  - Response: `{ success: true, pdf: { url: "https://.../download/abcd", filename: "Acme Pty Ltd - UTS Incubator Agreement - 2025-09-26.pdf", expiresAt: "2025-09-26T13:45:00Z" }, airtableAttachment: { ok: true, tableId: "tblStartups", recordId: "recStartup123", field: "Agreement", count: 2 } }`

**Airtable Schema (Field Contract)**
- Startups (`UTS_STARTUPS_TABLE_ID`)
  - Core: `Startup Name (or working title)`, `Primary contact email`, `Startup status`, `Record ID`.
  - Forms: `02. Startup Onboarding Form Prefilled`, `03. Startup Representative Details Prefilled`.
  - Agreement: `Agreement` (attachment) ← canonical adds attachments here.
  - Contract inputs: `Registered Business Name` (fallback: `Registred Business Name`), `ABN`, `Public liability insurance` (Yes/No).

- Team Members (`TEAM_MEMBERS_TABLE_ID`)
  - Links: `Startup` (or `Startup*`) links to Startups.
  - Identity: `Name` (or `First Name` + `Last Name`), `UTS Email` (or `Primary startup contact email`), `Date of birth*` (or `Date of Birth`, `DOB`).
  - Role: `Representative` (boolean/Yes/1) → used to pick debtor/signatory.
  - Onboarding: `Onboarding Submitted` (non‑blank means included in generation).
  - Membership: `Membership Type` (Full/Casual/Day) → pricing.
  - Discount validation (persisted):
    - `Discount Category` (expected bucket; user selection)
    - `Discount Validated` (select: Valid/Invalid/Qualifies for Other)
    - `Discount Valid Date` (date)
    - `Discount Expires` (date; alumni when available)

- Pricing (`PRICING_TABLE_ID`)
  - `Membership Type`, `Base Rate`
  - Discount columns: `Current UTS Student`, `Current Staff`, `UTS Alumni < 12m`, `UTS Alumni > 12m`, `Former Staff < 12m`, `Former Staff > 12m`.
  - Note: Only Full/Casual count toward the monthly fee; Day is excluded.

**Environment Variables (Canonical → Repo mapping)**
- Airtable
  - `AIRTABLE_TOKEN` → `AIRTABLE_API_KEY`
  - `AIRTABLE_BASE` → `AIRTABLE_BASE_ID`
  - `AIRTABLE_STARTUPS_TABLEID` → `UTS_STARTUPS_TABLE_ID`
  - `AIRTABLE_MEMBERS_TABLEID` → `TEAM_MEMBERS_TABLE_ID`
  - `AIRTABLE_PRICING_TABLEID` → `PRICING_TABLE_ID` (new)
- App URL/Port
  - `PUBLIC_BASE_URL` → `PRODUCTION_URL`
  - `PORT` → `PORT`
- Blackbaud SKY (new to this repo)
  - `SKY_CLIENT_ID`, `SKY_CLIENT_SECRET`, `SKY_REFRESH_TOKEN` (optional `SKY_ACCESS_TOKEN`)
  - `SKY_SUBSCRIPTION_KEY` or `SKY_SUBSCRIPTION_KEYS` (CSV)
  - Optional: `SKY_API_BASE` (default `https://api.sky.blackbaud.com`)
- Service/Generator (optional)
  - `AUTH_TOKEN` (internal calls/testing)
  - `GENERATOR_PATH` (default `./generate_with_sigfields.js`), `P12_PATH`, `P12_PASSPHRASE`, `PDF_OUTDIR`, `TERMS_URL`
- Field overrides (optional; defaults shown in canonical code)
  - Members: `AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD`=`Startup`, `AIRTABLE_MEMBERS_ONBOARDING_FIELD`=`Onboarding Submitted`, `AIRTABLE_MEMBERS_NAME_FIELD`=`Name`, `AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD`=`Primary startup contact email`, `AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD`=`Discount Category`, `AIRTABLE_MEMBERS_VALIDATED_SELECT_FIELD`=`Discount Validated`, `AIRTABLE_MEMBERS_VALID_DATE_FIELD`=`Discount Valid Date`, `AIRTABLE_MEMBERS_DISCOUNT_EXPIRES_FIELD`=`Discount Expires`, `AIRTABLE_MEMBERS_MEMBERSHIP_TYPE_FIELD`=`Membership Type`.
  - Pricing: `PRICING_MEMBERSHIP_TYPE_FIELD`=`Membership Type`, `PRICING_BASE_RATE_FIELD`=`Base Rate`, and the 6 column envs for discount buckets.

**Security & Limits**
- Auth:
  - End‑user: existing JWT (`verifyToken`) for dashboard‑triggered flows.
  - Internal/automation: `X-Auth-Token: AUTH_TOKEN` (download route is intentionally open but time‑limited).
- Helmet CSP (in `server.js`): extend `connectSrc` with `https://api.sky.blackbaud.com`, `https://oauth2.sky.blackbaud.com`.
- Rate limiting:
  - Keep global 100/15m.
  - Add route buckets for `/discount-check` and `/validate-and-generate` (e.g., 5/min per IP+startup).
- Logging:
  - Canonical endpoints emit structured JSON logs with `req_id` and timings; redact tokens.

**UI Contract (Dashboard Hooks)**
- Add a “Discount & Agreement” panel:
  - Validate button → `POST /discount-check` (selected member); shows toast with status/time.
  - Generate Agreement button → `POST /validate-and-generate` (startup id + optional validations array); shows returned URL/link.
- States: loading/disabled, success/error toasts (SweetAlert2 as used by existing UI).

**Generator Determinism & Assets**
- PDF is deterministic: fixed fonts/layout; viewer‑friendly (no object streams); stylable name/title/date; clickable `/Sig` field for Licensee; optional P12 server‑side signature for UTS block.
- Assets: optional `UTS_startups_logo.png`, `MH_sig.png` (generator still works if missing).
- Fonts: optional `fonts/arial.ttf`, `fonts/arialbd.ttf` (falls back to StandardFonts otherwise).
- Terms URL: `TERMS_URL` for a stable link in the document.

**Operational**
- Node version:
  - Canonical server uses global `fetch`; prefer Node 18+. If staying on Node 16, add a fetch polyfill (e.g., `undici`).
- Dependencies to add (runtime): `fs-extra`, `pdf-lib`, `@pdf-lib/fontkit`, `@signpdf/signpdf`, `@signpdf/placeholder-plain`, `@signpdf/signer-p12`.
- Health: `GET /healthz` for readiness; periodic cleanup of expired `/download/:token` files is built‑in.

**Testing & E2E**
- Unit/integration (Jest + Supertest + nock):
  - `/discount-check`: valid/invalid/ambiguous; SKY 401 refresh; SKY 429; Airtable error.
  - `/validate-and-generate`: missing pricing; idempotency; attachment flow; TTL download.
  - Config validation: missing env keys.
- E2E runner: `canonical_flow/scripts/run_e2e_test.js`
  - Example: `node canonical_flow/scripts/run_e2e_test.js --startup=recXXXX --member=recYYYY --debug=1 --saveLocal=1 --base=http://localhost:3000`

**Migration Plan (Implementation Outline)**
- Phase 0: Docs & env
  - Add SKY keys, `AUTH_TOKEN`, and `PRICING_TABLE_ID` to `.env` and `env.example`.
- Phase 1: Mount canonical routes
  - Promote canonical endpoints into root `server.js` (or mount as a router) and keep `/download/:token`.
  - Implement env aliasing (prefer repo keys; fallback to canonical keys).
  - Update Helmet CSP and route‑specific rate limits.
- Phase 2: Dependencies & Node
  - Add required packages; run on Node 18+ (or add `undici`).
- Phase 3: UI
  - Add dashboard panel with calls to endpoints; basic toasts/states.
- Phase 4: Tests & E2E
  - Supertest coverage; wire E2E runner; verify Airtable attachment and public URL.

**Error Codes (Guidance)**
- `AUTH_REQUIRED`, `NOT_FOUND`, `INVALID_INPUT`, `NOT_ELIGIBLE`, `SKY_ERROR`, `AIRTABLE_ERROR`, `RATE_LIMITED`, `PDF_FAILED`.
- All responses conform to `{ success, message?, data? }` (canonical also returns `error` for some failure cases). Standardize where feasible.

**Appendix: Field Overrides (Env Names)**
- Members: `AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD`, `AIRTABLE_MEMBERS_ONBOARDING_FIELD`, `AIRTABLE_MEMBERS_NAME_FIELD`, `AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD`, `AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD`, `AIRTABLE_MEMBERS_VALIDATED_SELECT_FIELD`, `AIRTABLE_MEMBERS_VALID_DATE_FIELD`, `AIRTABLE_MEMBERS_DISCOUNT_EXPIRES_FIELD`, `AIRTABLE_MEMBERS_MEMBERSHIP_TYPE_FIELD`.
- Pricing: `PRICING_MEMBERSHIP_TYPE_FIELD`, `PRICING_BASE_RATE_FIELD`, `PRICING_COL_CURRENT_UTS_STUDENT`, `PRICING_COL_UTS_ALUMNI_WITHIN_12M`, `PRICING_COL_UTS_ALUMNI_OVER_12M`, `PRICING_COL_CURRENT_UTS_STAFF`, `PRICING_COL_FORMER_STAFF_WITHIN_12M`, `PRICING_COL_FORMER_STAFF_OVER_12M`.


---

## End‑to‑End Flow Mapping (Repo + Canonical Assets)

Date: 2025-09-29

This section stitches together the current repository routes with the canonical validation and generation assets to describe the full lifecycle from invitation to agreement delivery.

### 1) Invitation & Magic Link
- User submits email on landing page.
- Backend: `POST /lookup-email` (server.js)
  - Looks up EOI and/or Startups in Airtable, selects onboarding vs management path.
  - Generates a 15‑minute JWT via `generateMagicLink(...)` (`JWT_SECRET`).
  - Writes “Magic Link” and “Token Expires At” back to Airtable; returns link in response (email sending is out‑of‑scope here).

### 2) Dashboard Access (JWT)
- `GET /dashboard/:token` with `verifyToken` (server.js) decodes the JWT and renders the dashboard HTML.
- Data loaded:
  - Startup (from EOI or Startups table).
  - Team Members linked by startup name.
- The dashboard HTML bootstraps client logic and stores the token for subsequent API calls.

### 3) Embedded Onboarding Forms
- Client requests per‑step form URLs using JWT‑guarded endpoints (server.js):
  - `GET /get-startup-form/:token`
  - `GET /get-representative-form/:token`
  - `GET /get-team-members-form/:token`
- Unlock rules:
  - Representative/Team steps unlocked when EOI record links a Startups record (EOI → `UTS Startups`).
- Optional completion signals:
  - `PATCH /submission-confirmation/:token` → sets Startups “Submission Confirmation”.
  - `POST /complete-onboarding` → sets Startups “Onboarding Submitted” = 1.

### 4) Discount Validation (Canonical)
- Trigger: per member, initiated from dashboard (JWT) or by operators/automation (X-Auth-Token).
- Endpoint (added in repo root): `POST /discount-check`
  - Auth: either `token` (JWT) in body or `X-Auth-Token: AUTH_TOKEN` header.
  - Input: `{ memberRecordId? | search_id?, expected?, email?, name?, dob?, updateAirtable=true, debug? }`.
  - Flow:
    - If `memberRecordId`, the server reads required fields from Team Members; otherwise uses explicit inputs.
    - Calls `canonical_flow/validation/blackbaudDiscountValidator.js` (Blackbaud SKY).
    - On SKY 401 → spawns `canonical_flow/oauth_refresh.js` once; reloads env; retries.
    - If `updateAirtable=true` and `memberRecordId`:
      - Minimal persistence on Team Members: `Discount Validated`, `Discount Valid Date`, `Discount Expires` (when derivable), and `Discount Category`.
  - Output: `{ success, data: { input, result, airtableUpdate? } }`.
  - Controls: route‑specific rate limit (5/min/IP); CSP includes SKY domains.

### 5) Agreement Generation (Canonical)
- Trigger: after validations for a Startup, from dashboard or automation.
- Endpoints (to be added next in the root server, adapted from `canonical_flow/server.js`):
  - `POST /validate-and-generate`
    - Optional `validations` array to run ahead of generation.
    - Builds payload from Startups and linked Team Members; loads pricing matrix (`PRICING_TABLE_ID`); computes member rates (discount applied only when validation is “Valid”).
    - Spawns `generate_with_sigfields.js` to produce deterministic PDF bytes.
    - Caches the PDF under a random token with TTL; attaches to Startups `Agreement` field via URL `GET /download/:token`.
    - Returns `{ success, validations, pdf: { url, filename, expiresAt }, airtableAttachment, savedLocal? }`.
  - `POST /pdf-url`
    - Same generation pipeline; no Airtable side effect; returns time‑limited URL payload.
  - `GET /download/:token`
    - No auth; returns `application/pdf`; expires at TTL; one‑time use; periodic cleanup.
- UI: add a “Discount & Agreement” panel to the dashboard with:
  - Validate button (per member) → `POST /discount-check`.
  - Generate Agreement (startup‑level) → `POST /validate-and-generate`; show link, copy button, and success toast.

### 6) Data Contracts
- Startups (Airtable): must include `Agreement` attachment field to store generated PDFs.
- Team Members (Airtable): fields for ID/email/name/DOB/expected category; result fields listed above.
- Pricing (Airtable): a table referenced by `PRICING_TABLE_ID` comprising membership type rows and discount columns; env overrides supported.

### 7) Authentication Model
- End‑user: JWT (magic link) enforced by `verifyToken` on dashboard‑triggered flows.
- Automation/operator: `X-Auth-Token: AUTH_TOKEN` on canonical endpoints.
- `GET /download/:token`: intentionally unauthenticated but time‑limited; token entropy + TTL mitigate risk.

### 8) Security/Controls
- Helmet CSP: `connectSrc` includes `https://api.sky.blackbaud.com` and `https://oauth2.sky.blackbaud.com`.
- Global rate limit: 100/15m (existing). Route limits: `/discount-check` (added), and to be added for `/validate-and-generate`.
- SKY token handling: automatic refresh on 401 via `oauth_refresh.js`.

### 9) Environment Keys (Superset)
- Existing: `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, `UTS_STARTUPS_TABLE_ID`, `TEAM_MEMBERS_TABLE_ID`, `UTS_EOI_TABLE_ID`, `JWT_SECRET`, `PORT`.
- Canonical additions:
  - Security: `AUTH_TOKEN`
  - SKY: `SKY_CLIENT_ID`, `SKY_CLIENT_SECRET`, `SKY_REFRESH_TOKEN`, `SKY_SUBSCRIPTION_KEY` or `SKY_SUBSCRIPTION_KEYS`, optional `SKY_ACCESS_TOKEN`
  - Pricing/Generation: `PRICING_TABLE_ID`, `PUBLIC_BASE_URL`, `URL_TTL_SECONDS` (default 3600), `PDF_OUTDIR`, `TERMS_URL`, optional `P12_PATH`, `P12_PASSPHRASE`
  - Field overrides for members/pricing (see Appendix for names)

### 10) Implementation Status (as of 2025-09-29)
- Implemented in root server:
  - `GET /healthz`
  - `POST /discount-check` (JWT or X‑Auth‑Token; Airtable minimal update; SKY refresh on 401)
  - CSP extension for SKY; per‑route limiter on `/discount-check`
- Pending (next phase):
  - `POST /validate-and-generate`, `POST /pdf-url`, `GET /download/:token`
  - PDF generator bridge, temp cache + TTL sweeper
  - Second route limiter for generation
  - UI “Discount & Agreement” panel and tests (Jest + Supertest + Nock)


---

## Repository Review & Detailed Implementation Plan (UTS Onboarding App)

Date: 2025-09-29

This section validates the above contract against the current repository and provides a concrete, repo-specific edit and test plan to integrate the canonical validation and agreement generation flows.

### What We Verified In This Repo
- Files examined: `server.js`, `public/js/dashboard.js`, `env.example`, `package.json`, `docs/*`, and `canonical_flow/*` (validator, generator, OAuth refresh, E2E script).
- Missing endpoints: root app does not yet expose `POST /discount-check`, `POST /validate-and-generate`, `POST /pdf-url`, `GET /download/:token`, or `GET /healthz`.
- Helmet CSP: `connectSrc` currently allows only `https://api.airtable.com`. To call Blackbaud SKY and its OAuth token host, add `https://api.sky.blackbaud.com` and `https://oauth2.sky.blackbaud.com` (spec requirement).
- Rate limiting: global limiter exists (100 requests/15m) but no per-route buckets; add buckets for `/discount-check` and `/validate-and-generate` as in spec.
- Node and fetch: `canonical_flow/server.js` uses `fetch` for Airtable HTTP. Root `package.json` engines is `>=16`; Node 16 has no global `fetch`. Either bump engines to Node 18+ or polyfill via `undici`.
- Dependencies: root app lacks `fs-extra`, `pdf-lib`, `@pdf-lib/fontkit`, `@signpdf/signpdf`, `@signpdf/placeholder-plain`, `@signpdf/signer-p12` used by the generator, and lacks test deps (`jest`, `supertest`, `nock`).
- Env keys: root `env.example` has Airtable API key/base/table IDs and JWT, but is missing canonical keys: `AUTH_TOKEN`, SKY credentials/keys, `PRICING_TABLE_ID`, `PUBLIC_BASE_URL`, `PDF_OUTDIR`, `TERMS_URL`, and TTL variable. The spec mandates adding them without renaming existing keys.
- UI: Dashboard has no “Discount & Agreement” panel or client calls to the canonical endpoints yet.
- Canonical code presence: `canonical_flow/` contains a working server, validator, generator, OAuth refresh, and E2E runner. We will integrate its logic into the root app.

### Integration Approach (Recommended)
Use a “router extraction” approach so the root `server.js` remains the single web server:
- Extract the canonical endpoints and helpers from `canonical_flow/server.js` into an Express `Router` that can be mounted by the root app. Keep `validation/blackbaudDiscountValidator.js`, `generate_with_sigfields.js`, and `oauth_refresh.js` as-is.
- Add a small env alias layer so canonical code works with existing env names without breaking current configuration.
- Standardize responses to the repo’s `{ success, message, data }` format while preserving canonical fields under `data`.

Alternative (not recommended unless time constrained): run `canonical_flow/server.js` as a child process and reverse‑proxy `POST /discount-check`, `POST /validate-and-generate`, etc. from the root server. This adds multi‑process complexity and complicates logs and rate limits.

### High‑Level Edits (By File)
1) `server.js`
- Import and mount canonical router once created: `app.use(require('./routes/canonical'));` (or `app.use('/api', router)` if namespacing is desired).
- Extend Helmet CSP `connectSrc` with `https://api.sky.blackbaud.com` and `https://oauth2.sky.blackbaud.com`.
- Add route‑specific rate limiters (example: 5 req/min/IP per endpoint) for `/discount-check` and `/validate-and-generate` while keeping the existing global limiter.
- Add a lightweight request‑id + JSON logging middleware (align with canonical’s `req_id` and single‑line JSON logs; redact tokens).
- Ensure `download` route is intentionally unauthenticated but time‑limited, per contract.

2) `routes/canonical.js` (new)
- Export an Express `Router` that implements:
  - `GET /healthz` → `{ success: true, data: { ok: true } }`.
  - `POST /discount-check` → adapt from `canonical_flow/server.js` (auth: JWT or `X-Auth-Token: AUTH_TOKEN`; optional `updateAirtable`).
  - `POST /validate-and-generate` → run validations (if requested), build payload, spawn generator, emit temp URL, optionally attach to Airtable.
  - `POST /pdf-url` → build payload, generate PDF, cache to temp, return URL payload; no Airtable side effect.
  - `GET /download/:token` → stream PDF if token valid and not expired; 410 when expired; clean up afterwards.
- Response format: wrap canonical results under `{ success, message?, data }`. For example: `{ success: true, data: { result, airtableUpdate } }`.
- Auth rules:
  - End‑user JWT (existing `verifyToken`) when invoked from dashboard contexts.
  - Automation: accept `X-Auth-Token: AUTH_TOKEN` for server‑to‑server calls.
  - `GET /download/:token` is intentionally unauthenticated but time‑limited.
- Errors: map to proper HTTP codes as listed in the spec and surface `{ success: false, message }`.

3) `utils/env-alias.js` (new)
- Provide canonical⇄repo variable mapping so code can read one canonical name with fallbacks to existing repo names. Recommended mappings:
  - `AIRTABLE_TOKEN` ← `AIRTABLE_API_KEY`
  - `AIRTABLE_BASE` ← `AIRTABLE_BASE_ID`
  - `AIRTABLE_STARTUPS_TABLEID` ← `UTS_STARTUPS_TABLE_ID`
  - `AIRTABLE_MEMBERS_TABLEID` ← `TEAM_MEMBERS_TABLE_ID`
  - `AIRTABLE_PRICING_TABLEID` ← `PRICING_TABLE_ID`
  - TTL: use `URL_TTL_SECONDS` (canonical) with fallback to `DOWNLOAD_TTL_SECONDS`
  - Preserve all canonical SKY vars (`SKY_*`) and `AUTH_TOKEN`
- Call this aliaser early in server bootstrap so `process.env` has both sets available.

4) `package.json`
- Add runtime deps: `fs-extra`, `pdf-lib`, `@pdf-lib/fontkit`, `@signpdf/signpdf`, `@signpdf/placeholder-plain`, `@signpdf/signer-p12`.
- If remaining on Node 16, add `undici` and initialize `global.fetch = require('undici').fetch` at router init; otherwise bump engines to `>=18` and skip polyfill.
- Add dev deps: `jest`, `supertest`, `nock`.
- Add scripts: `"test": "jest"`, optionally `"test:watch": "jest --watch"`.

5) `env.example`
- Add without renaming existing keys:
  - Security: `AUTH_TOKEN=choose-a-secret`
  - Blackbaud SKY: `SKY_CLIENT_ID=`, `SKY_CLIENT_SECRET=`, `SKY_REFRESH_TOKEN=`, `SKY_ACCESS_TOKEN=`, `SKY_SUBSCRIPTION_KEY=` (or `SKY_SUBSCRIPTION_KEYS=`)
  - Pricing: `PRICING_TABLE_ID=`
  - PDF + URLs: `PDF_OUTDIR=out/pdfs`, `PUBLIC_BASE_URL=`, `URL_TTL_SECONDS=3600`, `TERMS_URL=`
  - Optional signing: `P12_PATH=`, `P12_PASSPHRASE=`
- Document that Airtable IDs continue to use existing names; aliasing supplies canonical names internally.

6) `public/js/dashboard.js` and server‑rendered dashboard HTML
- Add a “Discount & Agreement” panel to the dashboard:
  - Per‑member “Validate Discount” button → `POST /discount-check` with `{ memberRecordId, expected }`; show toast with status and time.
  - “Generate Agreement” button (for startup) → `POST /validate-and-generate` with optional `validations` array; display returned URL and copy link.
- Use existing SweetAlert2 patterns; handle loading/disabled states; surface explicit error messages.

7) Logging & Observability
- Add request‑id middleware, log `http.request` and `http.response` events as single‑line JSON; redact tokens.
- Emit `discount_check.*`, `validate_and_generate.*`, `pdf_url.*`, and `download.*` events aligned with canonical naming for parity with E2E logs.

8) Rate Limits & Security
- Keep global limiter (100/15m).
- Add per‑route limiters for `/discount-check` and `/validate-and-generate` (e.g., 5/min/IP with `keyGenerator` incorporating IP + startup ID when present).
- Keep `/download/:token` unauthenticated but time‑limited; use 36‑char+ random tokens; immediate cleanup after stream end and periodic sweep (60s).

### Tests (Jest + Supertest + Nock)
Create `tests/` and focus on route behavior and error paths. Target ≈70% coverage for changed areas.

- Setup
  - Add Jest config via `package.json` or `jest.config.js` (testEnvironment `node`).
  - Use `nock` to stub Airtable and Blackbaud SKY endpoints.
  - If using Node 16, initialize `global.fetch` with `undici` in test bootstrap.

- `routes/canonical.discount-check.test.js`
  - Valid path: 200 with `{ success: true, data.status === 'valid' }`; updates Airtable fields when `updateAirtable=true`.
  - Invalid/ambiguous/not_found: proper statuses and no Airtable update when `updateAirtable=false`.
  - SKY 401 → refresh via `oauth_refresh.js` (stub child process) then success.
  - SKY 429/5xx propagate as 502 with `{ success: false, message }`.
  - 400 when missing identifiers.
  - Auth: 401 without JWT or correct `X-Auth-Token`.

- `routes/canonical.validate-and-generate.test.js`
  - With `startupRecordId`: runs validations for all linked team members when none provided; persists attachment to startup `Agreement` field; returns temp URL with TTL.
  - With only `memberRecordId`: resolves Startup via link field and attaches.
  - Missing pricing rows → 400 with clear message.
  - `saveLocal=true` saves under `PDF_OUTDIR` (stub filesystem with temp dir).
  - Rate limit: exceed threshold → 429.

- `routes/canonical.pdf-url-and-download.test.js`
  - `POST /pdf-url` returns `{ success: true, data: { url, filename, expiresAt } }`.
  - `GET /download/:token` returns 200 with `application/pdf` then 410 after TTL; verify cleanup.

- `routes/canonical.healthz.test.js`
  - Returns `{ success: true, data: { ok: true } }` and is fast.

- Config tests
  - Missing required env keys → startup or request returns 500/400 with explicit message.

### E2E
- Keep and document `canonical_flow/scripts/run_e2e_test.js`:
  - Example: `node canonical_flow/scripts/run_e2e_test.js --startup=recXXXX --member=recYYYY --debug=1 --saveLocal=1 --base=http://localhost:3000`.
  - Ensure Helmet CSP allows SKY domains in local runs; if using ngrok, set `PUBLIC_BASE_URL` and verify open `download` URL ingestion by Airtable.

### Rollout Plan
1. Phase 0 — Env & Docs
   - Add keys to `.env` and `env.example`. Choose `AUTH_TOKEN`. Confirm Airtable field names exist (e.g., `Agreement`).
2. Phase 1 — Dependencies
   - Install runtime + dev deps. Decide Node 18+ vs `undici` polyfill; update `engines` if upgrading.
3. Phase 2 — Router Extraction
   - Implement `routes/canonical.js` by lifting logic from `canonical_flow/server.js`. Add `utils/env-alias.js`.
4. Phase 3 — Server Wiring
   - Mount router in `server.js`. Extend Helmet CSP. Add per‑route rate limits and request‑id logging.
5. Phase 4 — UI Hooks
   - Add “Discount & Agreement” panel and client calls in `public/js/dashboard.js`.
6. Phase 5 — Tests & E2E
   - Add Jest/Supertest tests; run E2E against local server; verify Airtable attachment and `/download` TTL behavior.
7. Phase 6 — Stabilize
   - Review logs, edge cases (ambiguous candidates, pricing gaps), and adjust rate limits.

### Risks & Mitigations
- Global fetch on Node 16: either bump to Node 18+ or add `undici` polyfill to avoid runtime failures.
- Airtable field variance: env overrides exist for all key fields (see Appendix). Document any divergence and set overrides accordingly.
- Large PDFs: ensure temp file cleanup runs on stream close and via periodic sweeps to avoid disk bloat.
- Security: `download` is unauthenticated by design but short‑lived. Use long random tokens, strict TTL, and immediate cleanup.
- Rate limits: enforce per‑route buckets; add `keyGenerator` mixing IP + startup ID for fairness.

### Acceptance Criteria (Done =)
- All canonical endpoints available on the root server with CSP and limits in place.
- Responses follow `{ success, message, data }` schema.
- Agreement PDFs can be generated, downloaded via time‑limited URLs, and attached to Startups in Airtable.
- Discount validations persist minimal fields on Team Members and inform pricing.
- Unit/integration tests pass locally (`npm test`) with ~70% coverage on changed areas.
- E2E script runs successfully against `npm run dev`.
