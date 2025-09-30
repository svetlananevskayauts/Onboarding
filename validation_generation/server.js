#!/usr/bin/env node
/**
 * Webhook for: JSON Ã¢â€ â€™ PDF (via your generator) Ã¢â€ â€™ temporary URL
 * Refactored to use table IDs and to fill simple fields + fixed values,
 * while leaving placeholders for calculated fields.
 *
 * POST /pdf-url  body: { startupRecordId?: "rec...", memberRecordId?: "rec...", filename?: "name.pdf", ttlSeconds?: 1800 }
 *   -> { url, filename, expiresAt }
 *
 * You can also use POST /pdf (same body) to stream the PDF bytes back.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

/* Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Env & config Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */

const {
  AIRTABLE_TOKEN,
  AIRTABLE_BASE,
  AIRTABLE_STARTUPS_TABLEID,
  AIRTABLE_MEMBERS_TABLEID,

  AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD = 'Startup',
  AIRTABLE_MEMBERS_ONBOARDING_FIELD = 'Onboarding Submitted',
  AIRTABLE_MEMBERS_NAME_FIELD = 'Name',
  AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD = 'Primary startup contact email',

  GENERATOR_PATH = './generate_with_sigfields.js',
  P12_PATH,
  P12_PASSPHRASE = '',
  AUTH_TOKEN,
  URL_TTL_SECONDS = '3600',
  PORT = '3000',
  PUBLIC_BASE_URL = '',
  STARTUPS_AGREEMENT_FIELD = 'Agreement',
  PDF_OUTDIR = 'out/pdfs',
} = process.env;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE || !AIRTABLE_STARTUPS_TABLEID || !AIRTABLE_MEMBERS_TABLEID) {
  console.error('Missing required .env values: AIRTABLE_TOKEN, AIRTABLE_BASE, AIRTABLE_STARTUPS_TABLEID, AIRTABLE_MEMBERS_TABLEID');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '6mb' })); // inbound JSON

/* ------------------------------------------------------------
 * Logging (structured, single-line JSON)
 * ------------------------------------------------------------ */
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
function shouldLog(level) { return (LEVELS[level] ?? 2) <= (LEVELS[LOG_LEVEL] ?? 2); }
function log(level, event, data, req) {
  if (!shouldLog(level)) return;
  const payload = Object.assign({
    ts: new Date().toISOString(),
    level,
    event,
  }, data || {});
  if (req && req._reqId) payload.req_id = req._reqId;
  try { console.log(JSON.stringify(payload)); } catch (_) { /* noop */ }
}

/* ------------------------------------------------------------
 * SKY token refresh (non-interactive, rolling)
 * ------------------------------------------------------------ */
function parseIso(s) { try { const d = new Date(String(s)); return isNaN(d.getTime()) ? null : d; } catch { return null; } }
function decodeJwtExp(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload && payload.exp) return new Date(payload.exp * 1000);
  } catch(_) {}
  return null;
}

async function runRefresh(req) {
  return await new Promise((resolve) => {
    const cp = require('child_process').spawn(process.execPath, ['oauth_refresh.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    cp.stdout.on('data', (c) => out += c.toString());
    cp.stderr.on('data', (c) => err += c.toString());
    cp.on('exit', (code) => {
      if (code === 0) {
        try { require('dotenv').config({ override: true }); } catch(_){}
        log('info', 'sky.refresh.ok', { message: out.trim().slice(0, 200) }, req);
        resolve(true);
      } else {
        log('warn', 'sky.refresh.error', { code, stderr: err.trim().slice(0, 200) }, req);
        resolve(false);
      }
    });
  });
}

async function ensureSkyTokenFresh(req) {
  const now = new Date();
  const expIso = process.env.SKY_TOKEN_EXPIRES_AT || '';
  let exp = parseIso(expIso) || decodeJwtExp(process.env.SKY_ACCESS_TOKEN || '');
  // Refresh if expiry missing or within 3 minutes
  if (!exp || (exp.getTime() - now.getTime()) < 3 * 60 * 1000) {
    return await runRefresh(req);
  }
  return true;
}

// Correlate requests and add a finish log
app.use((req, res, next) => {
  req._reqId = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Req-Id', req._reqId);
  const started = Date.now();
  log('info', 'http.request', { method: req.method, path: req.path }, req);
  res.on('finish', () => {
    log('info', 'http.response', { method: req.method, path: req.path, status: res.statusCode, duration_ms: Date.now() - started }, req);
  });
  next();
});

// Optional bearer
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  // Allow headerless, time-limited downloads for Airtable ingestion
  if (req.path && req.path.startsWith('/download/')) return next();
  if (req.get('X-Auth-Token') === AUTH_TOKEN) return next();
  log('warn', 'auth.denied', { path: req.path }, req);
  return res.status(401).json({ error: 'Unauthorised' });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Discount check endpoint: validates a member's discount eligibility via Blackbaud
// See docs/discount_validation_workflow.md for full details.
app.post('/discount-check', async (req, res) => {
  try {
    const t0 = Date.now();
    const {
      memberRecordId,
      search_id: bodySearchId,
      expected: bodyExpected,
      email: bodyEmail,
      name: bodyName,
      dob: bodyDob,
      updateAirtable = true,
    } = req.body || {};

    let memberRec = null;
    if (memberRecordId) memberRec = await getRecord(AIRTABLE_MEMBERS_TABLEID, memberRecordId);

    const search_id = (bodySearchId
      || fieldStr(memberRec, process.env.AIRTABLE_MEMBERS_INTERNAL_ID_FIELD || 'UTS ID')
      || ''
    ).toString().trim();
    const expected = bodyExpected
      || fieldStr(memberRec, process.env.AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD || 'Discount Category')
      || '';
    const email = bodyEmail
      || fieldStr(memberRec, process.env.AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD || AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD || 'UTS Email')
      || '';
    const name = bodyName
      || fieldStr(memberRec, process.env.AIRTABLE_MEMBERS_NAME_FIELD || AIRTABLE_MEMBERS_NAME_FIELD || 'Name')
      || '';
    const dob = bodyDob
      || fieldStr(memberRec, process.env.AIRTABLE_MEMBERS_DOB_FIELD || 'Date of birth*')
      || fieldStr(memberRec, 'Date of Birth')
      || fieldStr(memberRec, 'DOB')
      || '';

    if (!search_id) return res.status(400).json({ error: 'Missing search_id and no member field available' });

    const validator = require('./validation/blackbaudDiscountValidator');
    const debugFromReq = (String(req.query.debug||'').toLowerCase()==='1' || String((req.body||{}).debug||'').toLowerCase()==='true');
    const debug = debugFromReq || LOG_LEVEL === 'debug';
    // reload .env so fresh SKY tokens apply when using skyauth_flow independently
    try { require('dotenv').config({ override: true }); } catch(_){}
    await ensureSkyTokenFresh(req);
    log('info', 'discount_check.start', { memberRecordId: memberRecordId || null, has_search_id: !!search_id }, req);
    let result = await validator.validateDiscount({ search_id, expected_bucket: expected, email, name, dob }, { debug });
    // If SKY returned 401, try a single refresh + retry
    if ((result && result.raw && (result.raw.statusCode === 401 || result.raw.status === 401)) || /401/.test(String(result?.reason||''))) {
      const ok = await runRefresh(req);
      if (ok) {
        try { require('dotenv').config({ override: true }); } catch(_){}
        result = await validator.validateDiscount({ search_id, expected_bucket: expected, email, name, dob }, { debug });
      }
    }
    const duration = Date.now() - t0;

    let airtableUpdate = null;
    if (memberRecordId && updateAirtable) {
      try {
        const a0 = Date.now();
        airtableUpdate = await updateMemberValidation(memberRecordId, result, expected, req);
        log('info', 'airtable.validation.persist', { memberRecordId, duration_ms: Date.now() - a0 }, req);
      } catch (e) {
        airtableUpdate = { error: e.message };
        log('error', 'airtable.validation.error', { memberRecordId, message: e.message }, req);
      }
    }
    // Log trace details when available
    try {
      const steps = result && result.trace && result.trace.steps ? result.trace.steps : null;
      if (steps && steps.search) log('debug', 'sky.search.finish', { status: steps.search.status, count: steps.search.count }, req);
      if (steps && steps.codes) log('debug', 'sky.codes.finish', { status: steps.codes.status, count: steps.codes.count }, req);
    } catch (_) {}
    log('info', 'discount_check.finish', { status: result.status, valid: !!result.valid, duration_ms: duration }, req);
    return res.json({ input: { memberRecordId, search_id, expected, email, name, dob }, result, airtableUpdate });
  } catch (e) {
    log('error', 'discount_check.error', { message: String(e.message || e) }, req);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Validate then generate in one deterministic pass
// Body:
// {
//   startupRecordId?: "rec...",          // for generation (or pass memberRecordId)
//   memberRecordId?: "rec...",
//   validations: [                        // array of member validations to run first
//     { memberRecordId: "rec...", search_id: "...", expected: "...", email?: "...", name?: "...", dob?: "..." }
//   ],
//   filename?: "...pdf", ttlSeconds?: 1800,
//   updateAirtable?: true
// }
app.post('/validate-and-generate', async (req, res) => {
  try {
    const t0 = Date.now();
    const { startupRecordId, memberRecordId, validations, filename, ttlSeconds, updateAirtable = true, saveLocal = false } = req.body || {};
    let list = Array.isArray(validations) ? validations : [];

    // Ensure every team member used for generation receives a validation
    if (startupRecordId) {
      try {
        const team = await listMembersWithOnboardingForStartupRobust(startupRecordId);
        const wanted = new Set((team || []).map(r => r.id));
        const have = new Set((list || []).map(v => v && v.memberRecordId).filter(Boolean));
        const missing = [...wanted].filter(id => !have.has(id));
        if ((!Array.isArray(validations) || validations.length === 0)) {
          // No validations provided: fill with all team members
          list = (team || []).map(r => ({ memberRecordId: r.id }));
          log('info', 'validate_and_generate.autofill_validations', { team_members: list.length }, req);
        } else if (missing.length) {
          // Caller provided some validations: append any missing team members
          list = list.concat(missing.map(id => ({ memberRecordId: id })));
          log('info', 'validate_and_generate.append_missing_validations', { appended: missing.length }, req);
        }
      } catch (e) {
        log('warn', 'validate_and_generate.ensure_all_validated_error', { message: String(e.message || e) }, req);
      }
    }

    // Run validations in sequence so Airtable is updated deterministically before generation
    const results = [];
    log('info', 'validate_and_generate.start', { startupRecordId: startupRecordId || null, memberRecordId: memberRecordId || null, validations: list.length }, req);
    for (const v of list) {
      const { memberRecordId: mId, search_id, expected, email, name, dob } = v || {};
      if (!mId && !search_id) {
        results.push({ error: 'skip: requires memberRecordId or search_id' });
        continue;
      }
      let mRec = null;
      if (mId && !search_id) { mRec = await getRecord(AIRTABLE_MEMBERS_TABLEID, mId).catch(() => null); }
      const sid = search_id
        || fieldStr(mRec, process.env.AIRTABLE_MEMBERS_INTERNAL_ID_FIELD || 'UTS ID')
        || '';
      const exp = expected
        || fieldStr(mRec, process.env.AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD || 'Discount Category')
        || '';
      const eml = email
        || fieldStr(mRec, process.env.AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD || AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD || 'UTS Email')
        || '';
      const nm  = name
        || fieldStr(mRec, process.env.AIRTABLE_MEMBERS_NAME_FIELD || AIRTABLE_MEMBERS_NAME_FIELD || 'Name')
        || '';
      const db  = dob
        || fieldStr(mRec, process.env.AIRTABLE_MEMBERS_DOB_FIELD || 'Date of birth*')
        || fieldStr(mRec, 'Date of Birth')
        || fieldStr(mRec, 'DOB')
        || '';

      const validator = require('./validation/blackbaudDiscountValidator');
      const debugFromReq = (String(req.query.debug||'').toLowerCase()==='1' || String((req.body||{}).debug||'').toLowerCase()==='true');
      const debug = debugFromReq || LOG_LEVEL === 'debug';
      // reload .env so fresh SKY tokens apply when using skyauth_flow independently
      try { require('dotenv').config({ override: true }); } catch(_){}
      await ensureSkyTokenFresh(req);
      const v0 = Date.now();
      let result = await validator.validateDiscount({ search_id: sid, expected_bucket: exp, email: eml, name: nm, dob: db }, { debug });
      if ((result && result.raw && (result.raw.statusCode === 401 || result.raw.status === 401)) || /401/.test(String(result?.reason||''))) {
        const ok = await runRefresh(req);
        if (ok) {
          try { require('dotenv').config({ override: true }); } catch(_){}
          result = await validator.validateDiscount({ search_id: sid, expected_bucket: exp, email: eml, name: nm, dob: db }, { debug });
        }
      }
      log('info', 'discount_check.finish', { memberRecordId: mId || null, status: result.status, valid: !!result.valid, duration_ms: Date.now() - v0 }, req);
      let updateRes = null;
      if (updateAirtable && mId) {
        try {
          const a0 = Date.now();
          updateRes = await updateMemberValidation(mId, result, exp, req);
          log('info', 'airtable.validation.persist', { memberRecordId: mId, duration_ms: Date.now() - a0 }, req);
        } catch (e) {
          updateRes = { error: e.message };
          log('error', 'airtable.validation.error', { memberRecordId: mId, message: e.message }, req);
        }
      }
      results.push({ memberRecordId: mId || null, input: { sid, exp, eml, nm, db }, result, airtableUpdate: updateRes });
    }

    // Now generate after validations have been persisted
    const b0 = Date.now();
    const payload = await buildPayload({ startupRecordId, memberRecordId });
    log('info', 'builder.payload.ready', { duration_ms: Date.now() - b0 }, req);
    const suggested = filename || suggestFilename(payload);
    const g0 = Date.now();
    const pdfBuffer = await generatePdfBuffer(payload, req);
    log('info', 'generator.pdf.ready', { duration_ms: Date.now() - g0, bytes: pdfBuffer.length }, req);

    // Optionally save a local copy (deterministic output alongside temp URL)
    let savedLocal = null;
    if (saveLocal) {
      try {
        const outdir = path.resolve(PDF_OUTDIR || 'out/pdfs');
        await fs.ensureDir(outdir);
        const safeName = String(suggested).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
        const outPath = path.join(outdir, safeName);
        await fs.writeFile(outPath, pdfBuffer);
        savedLocal = { path: outPath };
        log('info', 'generator.pdf.saved_local', { path: outPath }, req);
      } catch (e) {
        log('warn', 'generator.pdf.save_local_failed', { message: String(e.message || e) }, req);
      }
    }

    const token = crypto.randomBytes(18).toString('hex');
    const tmpDir = path.join(os.tmpdir(), 'pdf-cache');
    await fs.ensureDir(tmpDir);
    const filePath = path.join(tmpDir, `${token}.pdf`);
    await fs.writeFile(filePath, pdfBuffer);

    const ttl = Math.max(30, parseInt(ttlSeconds || URL_TTL_SECONDS, 10));
    const expiresAt = new Date(Date.now() + ttl * 1000);
    TOKENS.set(token, { filePath, filename: suggested, expiresAt });

    // Attach to Startup's Agreement field (resolve from member if needed)
    let attachmentResult = null;
    try {
      let targetStartupId = startupRecordId || null;
      if (!targetStartupId && memberRecordId) {
        try {
          const memberRec = await getRecord(AIRTABLE_MEMBERS_TABLEID, memberRecordId);
          const linkField = (typeof AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD !== 'undefined' ? AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD : 'Startup');
          const linked = memberRec?.fields?.[linkField] || memberRec?.fields?.['Startup*'] || [];
          if (Array.isArray(linked) && linked.length) targetStartupId = String(linked[0]);
          else if (typeof linked === 'string' && linked.startsWith('rec')) targetStartupId = linked;
        } catch (_) { /* ignore */ }
      }
      if (targetStartupId) {
        const rec = await getRecord(AIRTABLE_STARTUPS_TABLEID, targetStartupId);
        const existing = Array.isArray(rec?.fields?.[STARTUPS_AGREEMENT_FIELD]) ? rec.fields[STARTUPS_AGREEMENT_FIELD] : [];
        const url = `${baseUrl(req)}/download/${token}`;
        const attachment = suggested ? { url, filename: suggested } : { url };
        const updated = await updateRecord(AIRTABLE_STARTUPS_TABLEID, targetStartupId, { [STARTUPS_AGREEMENT_FIELD]: [...existing, attachment] });
        const count = Array.isArray(updated?.fields?.[STARTUPS_AGREEMENT_FIELD]) ? updated.fields[STARTUPS_AGREEMENT_FIELD].length : 0;
        attachmentResult = { ok: true, tableId: AIRTABLE_STARTUPS_TABLEID, recordId: targetStartupId, field: STARTUPS_AGREEMENT_FIELD, count };
        log('info', 'airtable.attachment.persist', { tableId: AIRTABLE_STARTUPS_TABLEID, recordId: targetStartupId, field: STARTUPS_AGREEMENT_FIELD, count }, req);
      }
    } catch (e) {
      attachmentResult = { error: String(e.message || e) };
      log('warn', 'airtable.attachment.error', { message: String(e.message || e) }, req);
    }

    log('info', 'validate_and_generate.finish', { duration_ms: Date.now() - t0 }, req);
    return res.json({ validations: results, pdf: { url: `${baseUrl(req)}/download/${token}`, filename: suggested, expiresAt: expiresAt.toISOString() }, airtableAttachment: attachmentResult, savedLocal });
  } catch (e) {
    log('error', 'validate_and_generate.error', { message: String(e.message || e) }, req);
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Routes Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */

app.post('/pdf-url', async (req, res) => {
  try {
    const t0 = Date.now();
    const { startupRecordId, memberRecordId, filename, ttlSeconds } = req.body || {};
    const b0 = Date.now();
    const payload = await buildPayload({ startupRecordId, memberRecordId });
    log('info', 'builder.payload.ready', { duration_ms: Date.now() - b0 }, req);

    const suggested = filename || suggestFilename(payload);
    const g0 = Date.now();
    const pdfBuffer = await generatePdfBuffer(payload, req);
    log('info', 'generator.pdf.ready', { duration_ms: Date.now() - g0, bytes: pdfBuffer.length }, req);

    const token = crypto.randomBytes(18).toString('hex');
    const tmpDir = path.join(os.tmpdir(), 'pdf-cache');
    await fs.ensureDir(tmpDir);
    const filePath = path.join(tmpDir, `${token}.pdf`);
    await fs.writeFile(filePath, pdfBuffer);

    const ttl = Math.max(30, parseInt(ttlSeconds || URL_TTL_SECONDS, 10));
    const expiresAt = new Date(Date.now() + ttl * 1000);
    TOKENS.set(token, { filePath, filename: suggested, expiresAt });

    log('info', 'pdf_url.issued', { filename: suggested, ttl: ttl, duration_ms: Date.now() - t0 }, req);
    res.json({ url: `${baseUrl(req)}/download/${token}`, filename: suggested, expiresAt: expiresAt.toISOString() });
  } catch (e) {
    log('error', 'pdf_url.error', { message: String(e.message || e) }, req);
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/pdf', async (req, res) => {
  try {
    const t0 = Date.now();
    const { startupRecordId, memberRecordId, filename } = req.body || {};
    const b0 = Date.now();
    const payload = await buildPayload({ startupRecordId, memberRecordId });
    log('info', 'builder.payload.ready', { duration_ms: Date.now() - b0 }, req);
    const suggested = filename || suggestFilename(payload);
    const g0 = Date.now();
    const pdfBuffer = await generatePdfBuffer(payload, req);
    log('info', 'generator.pdf.ready', { duration_ms: Date.now() - g0, bytes: pdfBuffer.length }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${suggested}"`);
    res.status(200).end(pdfBuffer);
    log('info', 'pdf.inline.sent', { filename: suggested, duration_ms: Date.now() - t0 }, req);
  } catch (e) {
    log('error', 'pdf.inline.error', { message: String(e.message || e) }, req);
    res.status(400).json({ error: String(e.message || e) });
  }
});

const TOKENS = new Map();
app.get('/download/:token', async (req, res) => {
  const entry = TOKENS.get(req.params.token);
  if (!entry) return res.status(404).send('Not found');
  if (Date.now() > entry.expiresAt.getTime()) {
    TOKENS.delete(req.params.token);
    await fs.remove(entry.filePath).catch(() => {});
    log('warn', 'download.expired', { filename: entry.filename }, req);
    return res.status(410).send('Link expired');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
  fs.createReadStream(entry.filePath)
    .on('close', async () => {
      TOKENS.delete(req.params.token);
      await fs.remove(entry.filePath).catch(() => {});
      log('info', 'download.completed', { filename: entry.filename }, req);
    })
    .pipe(res);
});

setInterval(async () => {
  const now = Date.now();
  for (const [token, entry] of TOKENS) {
    if (now > entry.expiresAt.getTime()) {
      TOKENS.delete(token);
      await fs.remove(entry.filePath).catch(() => {});
    }
  }
}, 60_000);

app.listen(parseInt(PORT, 10), () => {
  log('info', 'server.listen', { url: `http://0.0.0.0:${PORT}` });
});

/* Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Build payload (simple fields now; calc placeholders kept) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */

async function buildPayload({ startupRecordId, memberRecordId }) {
  // Fetch whichever records we were given
  const [startupRec, memberRec] = await Promise.all([
    startupRecordId ? getRecord(AIRTABLE_STARTUPS_TABLEID, startupRecordId) : null,
    memberRecordId ? getRecord(AIRTABLE_MEMBERS_TABLEID, memberRecordId) : null,
  ]);

  // If we only got a member, try resolve its linked Startup (optional)
  let startup = startupRec;
  if (!startup && memberRec) {
    const linkedStartupId = readFirstLinkedId(memberRec, AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD);
    if (linkedStartupId) {
      startup = await getRecord(AIRTABLE_STARTUPS_TABLEID, linkedStartupId).catch(() => null);
    }
  }

  // If we have a startup, enumerate linked team members then filter by onboarding (robust across schema variants)
  const teamMembers = startup
    ? await listMembersWithOnboardingForStartupRobust(startup.id)
    : (memberRec ? [memberRec] : []); // fallback: just the provided member, if any

  // Determine representative from Team Members: field 'Representative' equals '1' or 'Yes' (boolean/Yes/1)
  function nameOf(rec) {
    const full = fieldStr(rec, AIRTABLE_MEMBERS_NAME_FIELD);
    if (full) return full.trim();
    const first = fieldStr(rec, 'First Name');
    const last = fieldStr(rec, 'Last Name');
    return `${first} ${last}`.trim();
  }
  function isRepresentative(val) {
    if (val == null) return false;
    if (typeof val === 'boolean') return val === true;
    const s = String((typeof val === 'object' && val?.name != null) ? val.name : val).trim().toLowerCase();
    return s === '1' || s === 'yes';
  }
  let debtor_name = '';
  const repFromMember = memberRec && isRepresentative(memberRec?.fields?.['Representative']);
  if (repFromMember) debtor_name = nameOf(memberRec);
  else {
    const rep = (teamMembers || []).find(r => isRepresentative(r?.fields?.['Representative']));
    if (rep) debtor_name = nameOf(rep);
    // No fallback: debtor_name remains empty when no explicit Representative
  }

  // Simple fields
  const legal_name = fieldStr(startup, process.env.STARTUPS_LEGAL_NAME_1 || 'Registered Business Name')
                  || fieldStr(startup, process.env.STARTUPS_LEGAL_NAME_2 || 'Registred Business Name')
                  || '';

  const abn = fieldStr(startup, 'ABN') || '';

  const address = '3 Broadway, Ultimo, NSW, 2007'; // fixed value per spec

  const debtor_email =
    fieldStr(startup, 'Primary contact email') ||
    fieldStr(memberRec, process.env.AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD || 'UTS Email') ||
    // fallback: first team member with that field populated
    (teamMembers.map(r => fieldStr(r, process.env.AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD || 'UTS Email')).find(Boolean) || '');

  const billing_start_date = new Date().toISOString().slice(0, 10); // today (YYYY-MM-DD)

  // Compute monthly fee from pricing matrix (Full + Casual; Day excluded)
  let calculated_monthly_fee = '';
  try {
    const matrix = await loadPricingMatrix();
    let sum = 0;
    for (const r of teamMembers) sum += rateForMember(r, matrix);
    if (sum > 0) {
      calculated_monthly_fee = 'AUD ' + formatMoneyAUD(sum) + ' per month plus GST';
    } else {
      const hasFullOrCasual = (teamMembers || []).some((r) => {
        const t = normaliseType(fieldStr(r, process.env.AIRTABLE_MEMBERS_MEMBERSHIP_TYPE_FIELD || 'Membership Type'));
        return t === 'Full Membership' || t === 'Casual Membership';
      });
      calculated_monthly_fee = hasFullOrCasual
        ? 'AUD 0.00 per month (waived)'
        : 'No monthly fee (Day Memberships charged per-day)';
    }
  } catch (e) {
    calculated_monthly_fee = '—';
  }

  // Team: names from Team Members where Onboarding Submitted is not empty
  const team = teamMembers
    .map(toNameObject)
    .filter(Boolean);

  // memberships: placeholder counts for now (to be discretised by Discount Category)
  const memberships = computeMembershipCountsPlaceholder(teamMembers);

  // insurance_status: Convert Yes/No Ã¢â€ â€™ 1/0 (handle checkbox/single-select/strings)
  const insurance_status = yesNoToBinary(startup, 'Public liability insurance');

  return {
    legal_name,
    abn,
    address,
    debtor_name,
    debtor_email,
    billing_start_date,
    calculated_monthly_fee,
    memberships,
    team,
    insurance_status,
  };
}

/* Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Airtable helpers (table IDs only) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */

async function getRecord(tableId, recordId) {
  const url = `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Airtable GET ${tableId}/${recordId} Ã¢â€ â€™ ${res.status} ${res.statusText}: ${t}`);
  }
  return res.json();
}

async function listMembersWithOnboardingForStartup(startupRecordId) {
  // Requires a link field pointing from Members Ã¢â€ â€™ Startup (default: "Startup")
  // and an onboarding field (default: "Onboarding Submitted") that must be non-blank.
  if (!AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD) return [];
  const DEV_MODE = process.argv.includes('--dev') || String(process.env.DEV_MODE || '').toLowerCase() === 'true';
  const filter = DEV_MODE
    ? `FIND("${startupRecordId}", ARRAYJOIN({${AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD}}))`
    : `AND(\n    FIND(\"${startupRecordId}\", ARRAYJOIN({${AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD}})),\n    {${AIRTABLE_MEMBERS_ONBOARDING_FIELD}} != BLANK()\n  )`;

  const out = [];
  let url = new URL(`https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE)}/${encodeURIComponent(AIRTABLE_MEMBERS_TABLEID)}`);
  url.searchParams.set('filterByFormula', filter);
  url.searchParams.set('pageSize', '100');

  let offset;
  do {
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Airtable LIST members Ã¢â€ â€™ ${res.status} ${res.statusText}: ${t}`);
    }
    const json = await res.json();
    if (Array.isArray(json.records)) out.push(...json.records);
    offset = json.offset;
  } while (offset);

  return out;
}

// New robust variant: filters by non-blank link (and onboarding when not in DEV) then matches linked Startup ID client-side
async function listMembersWithOnboardingForStartupRobust(startupRecordId) {
  if (!AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD) return [];
  const DEV_MODE = process.argv.includes('--dev') || String(process.env.DEV_MODE || '').toLowerCase() === 'true';
  const baseFilter = `{${AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD}} != BLANK()`;
  const filter = (!DEV_MODE && AIRTABLE_MEMBERS_ONBOARDING_FIELD)
    ? `AND(${baseFilter}, {${AIRTABLE_MEMBERS_ONBOARDING_FIELD}} != BLANK())`
    : baseFilter;

  const pages = [];
  let url = new URL(`https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE)}/${encodeURIComponent(AIRTABLE_MEMBERS_TABLEID)}`);
  url.searchParams.set('filterByFormula', filter);
  url.searchParams.set('pageSize', '100');

  let offset;
  do {
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Airtable LIST members → ${res.status} ${res.statusText}: ${t}`);
    }
    const json = await res.json();
    if (Array.isArray(json.records)) pages.push(...json.records);
    offset = json.offset;
  } while (offset);

  const linked = pages.filter((r) => {
    const links = r?.fields?.[AIRTABLE_MEMBER_TO_STARTUP_LINK_FIELD];
    if (!Array.isArray(links) || links.length === 0) return false;
    return links.some((l) => (typeof l === 'string' ? l === startupRecordId : l?.id === startupRecordId));
  });

  return linked;
}

function authHeaders() {
  return { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };
}

async function updateRecord(tableId, recordId, fields) {
  const url = `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}`;
  const res = await fetch(url, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ fields }) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Airtable PATCH ${tableId}/${recordId} Ã¯Â¿Â½Ã¯Â¿Â½' ${res.status} ${res.statusText}: ${t}`);
  }
  return res.json();
}

function mapStatus(status) {
  switch (status) {
    case 'valid': return 'Valid';
    case 'invalid': return 'Invalid';
    case 'ambiguous': return 'Ambiguous';
    case 'not_found': return 'Not found';
    default: return 'Error';
  }
}

async function updateMemberValidation(memberRecordId, result, expected, req) {
  const fields = {};
  const VALIDATED_SELECT = process.env.AIRTABLE_MEMBERS_VALIDATED_SELECT_FIELD || 'Discount Validated';
  const VALID_DATE = process.env.AIRTABLE_MEMBERS_VALID_DATE_FIELD || 'Discount Valid Date';
  const EXPIRES = process.env.AIRTABLE_MEMBERS_DISCOUNT_EXPIRES_FIELD || 'Discount Expires';

  // Minimal storage: boolean flag + optional status + timestamp. No BlackbaudÃ¢â‚¬â€˜derived data persisted.
  const selection = result.valid ? 'Valid' : (result.qualifies_other ? 'Qualifies for Other' : 'Invalid');
  fields[VALIDATED_SELECT] = selection;
  if (VALID_DATE) fields[VALID_DATE] = new Date().toISOString().slice(0,10);
  // Alumni expiry when commencement date present (from API) and member qualifies as Alumni
  const derived = Array.isArray(result.derived_buckets) ? result.derived_buckets : [];
  const isAlumni = derived.some((b) => /^UTS Alumni/i.test(String(b)));
  if (isAlumni && result.alumni_expires_at) fields[EXPIRES] = String(result.alumni_expires_at).slice(0,10);
  if (expected) {
    const EXPECTED = typeof AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD !== 'undefined' ? AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD : 'Discount Category';
    fields[EXPECTED] = expected; // keep user selection as ground truth in Airtable
  }
  log('debug', 'airtable.patch.start', { tableId: AIRTABLE_MEMBERS_TABLEID, recordId: memberRecordId, keys: Object.keys(fields) }, req);
  const res = await updateRecord(AIRTABLE_MEMBERS_TABLEID, memberRecordId, fields);
  log('debug', 'airtable.patch.finish', { tableId: AIRTABLE_MEMBERS_TABLEID, recordId: memberRecordId }, req);
  return res;
}

/* Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Field readers & transformations Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */

function fieldStr(rec, fieldName) {
  if (!rec || !rec.fields) return '';
  const v = rec.fields[fieldName];
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) {
    // linked records or multi-selects: read display names
    const names = v.map(x => (x && x.name) ? x.name : (typeof x === 'string' ? x : '')).filter(Boolean);
    return names.join(', ');
  }
  if (v && v.name) return v.name; // single select
  return String(v);
}

function yesNoToBinary(rec, fieldName) {
  const raw = rec?.fields?.[fieldName];
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  const s = fieldStr(rec, fieldName).trim().toLowerCase();
  if (!s) return 0;
  if (['yes', 'y', 'true', '1', 'checked'].includes(s)) return 1;
  return 0;
}

function readFirstLinkedId(rec, linkField) {
  const v = rec?.fields?.[linkField];
  if (!v) return undefined;
  const first = Array.isArray(v) ? v[0] : v;
  return first?.id; // Airtable returns {id, name} for linked records
}

function toNameObject(memberRec) {
  if (!memberRec?.fields) return null;

  // Prefer full name field; fall back to {First Name, Last Name} if present
  const raw = memberRec.fields[AIRTABLE_MEMBERS_NAME_FIELD]
          || memberRec.fields['Full name']
          || memberRec.fields['Full Name']
          || null;

  if (raw) {
    const clean = String(raw).trim();
    if (!clean) return null;
    const parts = clean.split(/\s+/);
    if (parts.length === 1) return { first_name: parts[0], last_name: '' };
    return { first_name: parts.slice(0, -1).join(' '), last_name: parts.slice(-1)[0] };
  }

  const first = fieldStr(memberRec, 'First Name') || fieldStr(memberRec, 'First name') || '';
  const last  = fieldStr(memberRec, 'Last Name')  || fieldStr(memberRec, 'Last name')  || '';
  if (!first && !last) return null;
  return { first_name: first, last_name: last };
}

/* Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Placeholders for calc fields Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */

function computeMembershipCountsPlaceholder(_memberRecords) {
  const MEMBERSHIP_TYPE_FIELD = process.env.AIRTABLE_MEMBERS_MEMBERSHIP_TYPE_FIELD || 'Membership Type';
  const DISCOUNT_CATEGORY_FIELD = process.env.AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD || 'Discount Category';
  const VALIDATED_SELECT_FIELD = process.env.AIRTABLE_MEMBERS_VALIDATED_SELECT_FIELD || 'Discount Validated';

  function normaliseType(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (/^full/.test(s) || s.includes('full')) return 'Full Membership';
    if (/^casual/.test(s) || s.includes('casual')) return 'Casual Membership';
    if (/^day/.test(s) || s.includes('day')) return 'Day Membership';
    return 'Casual Membership';
  }
  function isUTSDiscount(discount) {
    if (!discount) return false;
    const s = String(discount).toLowerCase();
    return /uts|alumni|staff/.test(s);
  }
  function isWithin12m(discount) {
    if (!discount) return false;
    return /within the last 12 months|within.*12 months/i.test(String(discount));
  }
  function isOver12m(discount) {
    if (!discount) return false;
    return /more than 12 months|over.*12 months/i.test(String(discount));
  }

  let mem_fulltime_total = 0;
  let mem_fulltime_uts_discount = 0;
  let mem_casual_total = 0;
  let mem_casual_within_12m = 0;
  let mem_casual_over_12m = 0;
  let mem_day_total = 0;

  for (const r of Array.isArray(_memberRecords) ? _memberRecords : []) {
    const type = normaliseType(fieldStr(r, MEMBERSHIP_TYPE_FIELD));
    const discount = fieldStr(r, DISCOUNT_CATEGORY_FIELD) || '';
    const validatedSelect = fieldStr(r, VALIDATED_SELECT_FIELD);
    const validated = String(validatedSelect).toLowerCase() === 'valid';

    if (type === 'Full Membership') {
      mem_fulltime_total += 1;
      if (validated && isUTSDiscount(discount)) mem_fulltime_uts_discount += 1;
      continue;
    }
    if (type === 'Casual Membership') {
      mem_casual_total += 1;
      if (validated && isWithin12m(discount)) mem_casual_within_12m += 1;
      else if (validated && isOver12m(discount)) mem_casual_over_12m += 1;
      continue;
    }
    if (type === 'Day Membership') {
      mem_day_total += 1;
      continue;
    }
  }

  return {
    mem_fulltime_count: String(mem_fulltime_total),
    mem_fulltime_uts_discount_count: String(mem_fulltime_uts_discount),
    mem_casual_count: String(mem_casual_total),
    mem_casual_uts_within_12m_count: String(mem_casual_within_12m),
    mem_casual_uts_over_12m_count: String(mem_casual_over_12m),
    mem_day_count: String(mem_day_total),
  };
}

/* Pricing: load matrix and compute monthly fee */
const PRICING_TYPE_FIELD = process.env.PRICING_MEMBERSHIP_TYPE_FIELD || 'Membership Type';
const PRICING_BASE_FIELD = process.env.PRICING_BASE_RATE_FIELD || 'Base Rate';
const COL_CURRENT_STUDENT = process.env.PRICING_COL_CURRENT_UTS_STUDENT || 'Current UTS Student';
const COL_ALUMNI_WITHIN = process.env.PRICING_COL_UTS_ALUMNI_WITHIN_12M || 'UTS Alumni < 12m';
const COL_ALUMNI_OVER = process.env.PRICING_COL_UTS_ALUMNI_OVER_12M || 'UTS Alumni > 12m';
const COL_CURRENT_STAFF = process.env.PRICING_COL_CURRENT_UTS_STAFF || 'Current Staff';
const COL_FORMER_WITHIN = process.env.PRICING_COL_FORMER_STAFF_WITHIN_12M || 'Former Staff < 12m';
const COL_FORMER_OVER = process.env.PRICING_COL_FORMER_STAFF_OVER_12M || 'Former Staff > 12m';

async function loadPricingMatrix() {
  const out = {};
  if (!process.env.AIRTABLE_PRICING_TABLEID) return out;
  let url = new URL(`https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE)}/${encodeURIComponent(process.env.AIRTABLE_PRICING_TABLEID)}`);
  url.searchParams.set('pageSize', '100');
  let offset;
  do {
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      // fail soft; leave pricing empty
      break;
    }
    const json = await res.json();
    const records = Array.isArray(json.records) ? json.records : [];
    for (const r of records) {
      const f = r.fields || {};
      const typeRaw = f[PRICING_TYPE_FIELD];
      if (!typeRaw) continue;
      const type = normaliseType(typeRaw);
      const base = toNumber(f[PRICING_BASE_FIELD]);
      out[type] = {
        base: isFinite(base) ? base : 0,
        discounts: {
          [COL_CURRENT_STUDENT]: toNumber(f[COL_CURRENT_STUDENT]),
          [COL_ALUMNI_WITHIN]: toNumber(f[COL_ALUMNI_WITHIN]),
          [COL_ALUMNI_OVER]: toNumber(f[COL_ALUMNI_OVER]),
          [COL_CURRENT_STAFF]: toNumber(f[COL_CURRENT_STAFF]),
          [COL_FORMER_WITHIN]: toNumber(f[COL_FORMER_WITHIN]),
          [COL_FORMER_OVER]: toNumber(f[COL_FORMER_OVER]),
        }
      };
    }
    offset = json.offset;
  } while (offset);
  return out;
}

function toNumber(v) { if (typeof v === 'number') return v; const n = parseFloat(String(v||'').replace(/[^0-9.\-]/g,'')); return isFinite(n) ? n : 0; }
function normaliseType(raw) {
  const s = String(raw||'').toLowerCase();
  if (s.includes('full')) return 'Full Membership';
  if (s.includes('casual')) return 'Casual Membership';
  if (s.includes('day')) return 'Day Membership';
  return 'Casual Membership';
}
function formatMoneyAUD(n) { try { return new Intl.NumberFormat('en-AU',{ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n); } catch { return Number(n).toFixed(2); } }
function discountColumnFor(category) {
  const s = String(category||'').toLowerCase();
  if (s.includes('current') && s.includes('student')) return COL_CURRENT_STUDENT;
  if (s.includes('current') && s.includes('staff')) return COL_CURRENT_STAFF;
  if ((s.includes('alumni') && (s.includes('within') || s.includes('< 12'))) || /<\s*12/.test(s)) return COL_ALUMNI_WITHIN;
  if ((s.includes('alumni') && (s.includes('more than') || s.includes('over') || s.includes('> 12'))) || />\s*12/.test(s)) return COL_ALUMNI_OVER;
  if (s.includes('former') && s.includes('staff') && (s.includes('within') || s.includes('< 12'))) return COL_FORMER_WITHIN;
  if (s.includes('former') && s.includes('staff') && (s.includes('more than') || s.includes('over') || s.includes('> 12'))) return COL_FORMER_OVER;
  // Fallbacks for compact labels
  if (s.includes('alumni') && s.includes('12') && s.includes('<')) return COL_ALUMNI_WITHIN;
  if (s.includes('alumni') && s.includes('12') && s.includes('>')) return COL_ALUMNI_OVER;
  if (s.includes('former') && s.includes('12') && s.includes('<')) return COL_FORMER_WITHIN;
  if (s.includes('former') && s.includes('12') && s.includes('>')) return COL_FORMER_OVER;
  return null;
}

function validationIsValid(rec) {
  const v = fieldStr(rec, process.env.AIRTABLE_MEMBERS_VALIDATED_SELECT_FIELD || 'Discount Validated');
  return String(v).trim().toLowerCase() === 'valid';
}

function rateForMember(rec, matrix) {
  const type = normaliseType(fieldStr(rec, process.env.AIRTABLE_MEMBERS_MEMBERSHIP_TYPE_FIELD || 'Membership Type'));
  const row = matrix[type] || { base: 0, discounts: {} };
  const base = toNumber(row.base);
  // Day Membership not part of monthly sum
  if (type === 'Day Membership') return 0;
  const discountCategory = fieldStr(rec, process.env.AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD || 'Discount Category');
  const col = discountColumnFor(discountCategory);
  if (validationIsValid(rec) && col && row.discounts && row.discounts[col] != null) {
    const d = toNumber(row.discounts[col]);
    return isFinite(d) ? d : base;
  }
  return base;
}

/* Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Generator bridge Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */

async function generatePdfBuffer(payload, req) {
  const tmpJson = path.join(os.tmpdir(), `payload_${Date.now()}_${Math.random().toString(16).slice(2)}.json`);
  const tmpPdf  = path.join(os.tmpdir(), `out_${Date.now()}_${Math.random().toString(16).slice(2)}.pdf`);
  await fs.writeJSON(tmpJson, payload, { spaces: 2 });

  await new Promise((resolve, reject) => {
    const args = [GENERATOR_PATH, tmpJson, tmpPdf];
    if (P12_PATH) { args.push(P12_PATH); args.push(P12_PASSPHRASE || ''); }
    log('debug', 'generator.spawn', { args }, req);
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Generator exited ${code}`)));
  });

  const bytes = await fs.readFile(tmpPdf);
  await fs.remove(tmpJson).catch(() => {});
  await fs.remove(tmpPdf).catch(() => {});
  return bytes;
}

/* Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Misc Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ */

function suggestFilename(payload) {
  const base = payload?.legal_name || 'agreement';
  const d = new Date().toISOString().slice(0,10);
  return `${base} - UTS Incubator Agreement - ${d}.pdf`;
}

function baseUrl(req) {
  const override = (process.env.PUBLIC_BASE_URL || PUBLIC_BASE_URL || '').trim();
  if (override) return override.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString();
  const host  = (req.headers['x-forwarded-host']  || req.headers.host).toString();
  return `${proto}://${host}`;
}







