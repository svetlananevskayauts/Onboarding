#!/usr/bin/env node
// Refreshes SKY access token using SKY_REFRESH_TOKEN and updates .env

try { require('dotenv').config(); } catch (_) {}

const https = require('https');
const fs = require('fs');

function b64(s) { return Buffer.from(s, 'ascii').toString('base64'); }

function decodeJwtClaims(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch (_) { return null; }
}

function updateEnv(vars) {
  const envPath = '.env';
  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch (_) {}
  const lines = text ? text.split(/\r?\n/) : [];
  const keys = Object.keys(vars);
  const set = new Set(keys);
  const out = lines.map((ln) => {
    const m = ln.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) return ln;
    const k = m[1];
    if (set.has(k)) {
      const v = String(vars[k]);
      set.delete(k);
      return `${k}=${v}`;
    }
    return ln;
  });
  for (const k of Array.from(set)) out.push(`${k}=${vars[k]}`);
  fs.writeFileSync(envPath, out.join('\n'));
}

async function main() {
  const clientId = process.env.SKY_CLIENT_ID || '';
  const clientSecret = process.env.SKY_CLIENT_SECRET || '';
  const refresh = process.env.SKY_REFRESH_TOKEN || '';
  if (!clientId || !clientSecret) {
    console.error('Missing SKY_CLIENT_ID or SKY_CLIENT_SECRET in environment.');
    process.exit(1);
  }
  if (!refresh) {
    console.error('Missing SKY_REFRESH_TOKEN in environment.');
    process.exit(1);
  }

  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}`;
  const auth = 'Basic ' + b64(`${clientId}:${clientSecret}`);

  const opts = {
    hostname: 'oauth2.sky.blackbaud.com',
    path: '/token',
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    }
  };

  const tokens = await new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Token endpoint ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse token JSON: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const access = tokens.access_token || '';
  const newRefresh = tokens.refresh_token || refresh;
  if (!access) {
    console.error('No access_token in refresh response:', tokens);
    process.exit(1);
  }

  const claims = decodeJwtClaims(access);
  const nowIso = new Date().toISOString();
  let expIso = '';
  if (claims && claims.exp) expIso = new Date(claims.exp * 1000).toISOString();

  updateEnv({
    SKY_ACCESS_TOKEN: access,
    SKY_REFRESH_TOKEN: newRefresh,
    SKY_TOKEN_OBTAINED_AT: nowIso,
    SKY_TOKEN_EXPIRES_AT: expIso || 'unknown',
  });

  console.log('Refreshed access token saved to .env');
  if (expIso) console.log('Token expires at:', expIso);
}

main().catch((e) => { console.error('Refresh failed:', e.message); process.exit(1); });

