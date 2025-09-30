#!/usr/bin/env node
"use strict";

// End-to-end test runner for the canonical flow
// - Health check
// - POST /validate-and-generate
// - Save JSON response + try public download
// - Confirm local saved copy (when saveLocal=true)
// - Check Airtable Agreement field on Startup

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const out = { _: [] };
  for (const t of argv.slice(2)) {
    const m = t.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2]; else if (t.startsWith('--')) out[t.slice(2)] = true; else out._.push(t);
  }
  return out;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { ok: res.ok, status: res.status, text, json, headers: Object.fromEntries(res.headers.entries()) };
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, buf, headers: Object.fromEntries(res.headers.entries()) };
}

function headers() {
  const h = { 'Content-Type': 'application/json' };
  const tok = process.env.AUTH_TOKEN || '';
  if (tok) h['X-Auth-Token'] = tok;
  return h;
}

async function ensureServer(base, startServer) {
  const health = await fetchJson(base.replace(/\/$/, '') + '/healthz', { headers: headers() }).catch(() => ({ ok:false }));
  if (health && health.ok && health.json && health.json.ok) return true;
  if (!startServer) return false;
  spawn(process.execPath, ['server.js'], { stdio: 'ignore', detached: true }).unref();
  for (let i=0;i<20;i++) {
    await sleep(300);
    const h = await fetchJson(base.replace(/\/$/, '') + '/healthz', { headers: headers() }).catch(() => ({ ok:false }));
    if (h && h.ok && h.json && h.json.ok) return true;
  }
  return false;
}

async function getStartupRecord(startupsTableId, startupId) {
  const token = process.env.AIRTABLE_TOKEN || '';
  const base = process.env.AIRTABLE_BASE || '';
  if (!token || !base || !startupsTableId) return null;
  const url = `https://api.airtable.com/v0/${encodeURIComponent(base)}/${encodeURIComponent(startupsTableId)}/${encodeURIComponent(startupId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const text = await res.text();
  try { return { ok: res.ok, json: JSON.parse(text) }; } catch { return { ok: res.ok, text } }
}

(async () => {
  const args = parseArgs(process.argv);
  const base = (args.base || 'http://localhost:3000').replace(/\/$/, '');
  const startup = args.startup || args.startupRecordId || '';
  const member = args.member || args.memberRecordId || '';
  const expected = args.expected || 'Current UTS Staff';
  const ttl = parseInt(args.ttl || '900', 10);
  const debug = args.debug === true || String(args.debug||'').toLowerCase() === 'true' || String(args.debug||'') === '1';
  const saveLocal = args.saveLocal === true || String(args.saveLocal||'').toLowerCase() === 'true' || String(args.saveLocal||'') === '1';
  const outDir = args.out || path.join('out','logs');
  const startServer = args.startServer === true || String(args.startServer||'') === '1';

  if (!startup) {
    console.error('Provide --startup=rec... (and optionally --member=rec... --expected="...")');
    process.exit(2);
  }

  // 1) Ensure server is up
  const up = await ensureServer(base, startServer);
  if (!up) {
    console.error('Health check failed at', base + '/healthz');
    process.exit(1);
  }

  // 2) E2E call
  const body = {
    startupRecordId: startup,
    validations: member ? [{ memberRecordId: member, expected }] : [],
    ttlSeconds: ttl,
    saveLocal,
    debug,
  };
  const e2e = await fetchJson(base + '/validate-and-generate' + (debug ? '?debug=1' : ''), {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  await fs.mkdir(outDir, { recursive: true }).catch(()=>{});
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const outFile = path.join(outDir, `e2e_${stamp}.json`);
  await fs.writeFile(outFile, e2e.text || '', 'utf8');
  if (!e2e.ok || !e2e.json) {
    console.error('E2E failed:', e2e.status, e2e.text);
    process.exit(1);
  }

  // 3) Try public download
  let dl = { ok:false, status:'n/a', size:0 };
  try {
    const d = await fetchBuffer(e2e.json?.pdf?.url);
    dl = { ok: d.ok, status: d.status, size: d.buf.length };
  } catch (_) {}

  // 4) Confirm savedLocal (when requested)
  let local = e2e.json?.savedLocal?.path || '';
  let localExists = false;
  try { if (local) { await fs.stat(local); localExists = true; } } catch {}

  // 5) Airtable Agreement re-fetch (validate attachment persisted)
  let agreementCount = null;
  let agreementVerified = null;
  try {
    const startupsTableId = process.env.AIRTABLE_STARTUPS_TABLEID || '';
    const expectedCount = Number(e2e.json?.airtableAttachment?.count || 0) || null;
    let rec = null;
    for (let i = 0; i < 8; i++) { // ~8s max with 1s sleeps
      const r = await getStartupRecord(startupsTableId, startup);
      rec = r;
      if (r && r.ok && r.json && r.json.fields) {
        const arr = r.json.fields['Agreement'];
        agreementCount = Array.isArray(arr) ? arr.length : 0;
        if (expectedCount != null && agreementCount === expectedCount) { agreementVerified = true; break; }
        if (expectedCount == null && agreementCount > 0) { agreementVerified = true; break; }
      }
      await sleep(1000);
    }
    if (agreementVerified !== true) agreementVerified = false;
    if (rec && rec.ok && rec.json) {
      await fs.writeFile(path.join(outDir, `startup_${stamp}.json`), JSON.stringify(rec.json, null, 2), 'utf8');
    }
  } catch (_) { agreementVerified = false; }

  const val = (e2e.json.validations && e2e.json.validations[0]) ? e2e.json.validations[0].result : {};
  const summary = {
    base,
    validation_status: val.status || null,
    validation_valid: !!val.valid,
    pdf_filename: e2e.json?.pdf?.filename || null,
    pdf_url: e2e.json?.pdf?.url || null,
    savedLocal: local || null,
    savedLocalExists: localExists,
    download_status: dl.status,
    download_bytes: dl.size,
    airtable_agreement_count: agreementCount,
    airtable_agreement_verified: agreementVerified,
    log_json: outFile,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
})().catch((e) => { console.error('Run failed:', e.message); process.exit(1); });
