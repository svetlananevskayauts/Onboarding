#!/usr/bin/env node
// Refreshes SKY access token using SKY_REFRESH_TOKEN and updates .env

try { require('dotenv').config(); } catch (_) {}

const https = require('https');
const fs = require('fs');
const path = require('path');

function b64(s) { return Buffer.from(s, 'ascii').toString('base64'); }

function decodeJwtClaims(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch (_) { return null; }
}

function parseEnv(text) {
  const map = Object.create(null);
  const lines = (text || '').split(/\r?\n/);
  for (const ln of lines) {
    const m = ln.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

function updateEnvAtomic(vars, cas = {}) {
  // Allow overriding the target env file to avoid clobbering base .env in dev
  const envPath = process.env.SKY_ENV_FILE || '.env';
  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch (_) {}
  const lines = text ? text.split(/\r?\n/) : [];
  const current = parseEnv(text);

  // Apply compare-and-swap constraints: if CAS key mismatches, skip updating that key
  const out = lines.map((ln) => {
    const m = ln.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) return ln;
    const k = m[1];
    if (Object.prototype.hasOwnProperty.call(vars, k)) {
      if (Object.prototype.hasOwnProperty.call(cas, k)) {
        if (current[k] !== String(cas[k])) return ln; // someone else updated; keep existing
      }
      return `${k}=${String(vars[k])}`;
    }
    return ln;
  });

  // Add any missing keys (that either have no CAS or CAS matches current absence)
  for (const [k, v] of Object.entries(vars)) {
    if (!Object.prototype.hasOwnProperty.call(current, k)) {
      // if CAS specified and current doesn't match expected (undefined vs value), treat mismatch as skip
      if (Object.prototype.hasOwnProperty.call(cas, k) && cas[k] !== undefined) continue;
      out.push(`${k}=${String(v)}`);
    }
  }

  const tmp = envPath + '.tmp';
  fs.writeFileSync(tmp, out.join('\n'));
  fs.renameSync(tmp, envPath); // atomic on same volume
}

async function main() {
  // Single-flight lock to avoid concurrent refreshes doing duplicate work
  const lockPath = path.resolve('.oauth_refresh.lock');
  let lockFd = null;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(lockFd, String(process.pid));
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      console.log('Another refresh is in progress, exiting.');
      process.exit(0);
    }
    throw e;
  }
  const releaseLock = () => { try { if (lockFd !== null) fs.closeSync(lockFd); if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch (_) {} };
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

  const clientId = process.env.SKY_CLIENT_ID || '';
  const clientSecret = process.env.SKY_CLIENT_SECRET || '';
  const refresh = process.env.SKY_REFRESH_TOKEN || '';
  if (!clientId || !clientSecret) {
    console.error('Missing SKY_CLIENT_ID or SKY_CLIENT_SECRET in environment.');
    process.exit(2);
  }
  if (!refresh) {
    console.error('Missing SKY_REFRESH_TOKEN in environment.');
    process.exit(2);
  }

  // Default behavior: preserve the refresh token (no rotation)
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}&preserve_refresh_token=true`;
  const auth = 'Basic ' + b64(`${clientId}:${clientSecret}`);

  const baseOpts = {
    hostname: 'oauth2.sky.blackbaud.com',
    path: '/token',
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    }
  };

  async function fetchTokensWithRetry(maxAttempts = 3, timeoutMs = 15000) {
    let attempt = 0; let lastErr = null;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const tokens = await new Promise((resolve, reject) => {
          const req = https.request(baseOpts, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
              const status = res.statusCode || 0;
              if (status !== 200) return reject(Object.assign(new Error(`Token endpoint ${status}: ${data}`), { status, body: data }));
              try { resolve(JSON.parse(data)); }
              catch (e) { reject(Object.assign(new Error('Failed to parse token JSON: ' + e.message), { status, body: data })); }
            });
          });
          req.setTimeout(timeoutMs, () => { req.destroy(new Error('request_timeout')); });
          req.on('error', reject);
          req.write(body);
          req.end();
        });
        return tokens;
      } catch (e) {
        lastErr = e;
        const status = e && e.status;
        const bodyStr = (e && e.body) || '';
        // Do not retry on 4xx except 429
        if (status && status !== 429 && status < 500) break;
        // Backoff with jitter
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000) + Math.floor(Math.random() * 250);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastErr || new Error('Unknown token fetch error');
  }

  let tokens;
  try {
    tokens = await fetchTokensWithRetry();
  } catch (e) {
    releaseLock();
    // Map common failures to clear exit codes
    const bodyStr = (e && e.body) || '';
    if (bodyStr.includes('invalid_grant')) {
      console.error('Refresh failed: invalid_grant (refresh token expired/revoked or wrong app credentials)');
      process.exit(10);
    }
    if (bodyStr.includes('unauthorized_client')) {
      console.error('Refresh failed: unauthorized_client (check client id/secret)');
      process.exit(11);
    }
    console.error('Refresh failed:', e.message);
    process.exit(1);
  }

  const access = tokens.access_token || '';
  // We preserve the existing refresh token by default and ignore any returned value
  const newRefresh = '';
  if (!access) {
    console.error('No access_token in refresh response:', tokens);
    releaseLock();
    process.exit(1);
  }

  const claims = decodeJwtClaims(access);
  const nowIso = new Date().toISOString();
  let expIso = '';
  if (claims && claims.exp) expIso = new Date(claims.exp * 1000).toISOString();

  const vars = {
    SKY_ACCESS_TOKEN: access,
    SKY_TOKEN_OBTAINED_AT: nowIso,
    SKY_TOKEN_EXPIRES_AT: expIso || 'unknown',
  };
  // Do not modify SKY_REFRESH_TOKEN; we always preserve it
  updateEnvAtomic(vars);

  console.log('Refreshed access token saved to .env (refresh token preserved)');
  if (expIso) console.log('Token expires at:', expIso);
  // JSON summary (single line)
  const ttl = claims && claims.exp ? Math.max(0, Math.round((claims.exp*1000 - Date.now())/1000)) : null;
  console.log(JSON.stringify({ ok: true, expires_at: expIso || null, ttl_sec: ttl }, null, 0));

  releaseLock();
}

main().catch((e) => { console.error('Refresh failed:', e.message); process.exit(1); });
