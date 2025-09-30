# Canonical Validation → Generation Flow

This folder exposes the single, authoritative end‑to‑end flow:

1) Validation (Blackbaud RE NXT) → persist minimal outcome to Airtable
2) Generation (Airtable only) → deterministic PDF with pricing

Design notes:
- These entry points reference the authoritative files in the repo root to avoid divergence (no parallel flows).
- Provide a focused .env with only the variables required to run the E2E path.

## Files
- `server.js` → wrapper that runs the canonical server (POST /discount-check, /validate-and-generate, /pdf-url, /pdf).
- `generate_with_sigfields.js` → wrapper to the canonical PDF generator.
- `validation/blackbaudDiscountValidator.js` → wrapper to the canonical validator.
- `oauth_refresh.js` → wrapper used by server to refresh SKY tokens.
- `scripts/run_e2e_test.js` → wrapper to the E2E test runner.
- `.env` → minimal environment required for the E2E flow (fill in values).

## Quickstart

1) Copy `.env` values from your secrets manager and save in `canonical_flow/.env`.

2) Start the server on port 3000 (or set `PORT`):

   ```sh
   node canonical_flow/server.js
   ```

3) Run the single‑startup E2E test (auto‑validates the team, generates one PDF, and re‑checks Airtable attachment):

   ```sh
   node canonical_flow/scripts/run_e2e_test.js --startup=recXXXXXXXX --saveLocal=1 --debug=1 --base=http://localhost:3000
   ```

Notes:
- Public download links use `PUBLIC_BASE_URL` if set (e.g., your ngrok URL). Otherwise, the server derives the URL from the request.
- The generator will use in‑repo assets if present (logo/signature). If missing, it still produces a valid PDF.

