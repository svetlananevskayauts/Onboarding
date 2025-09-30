"use strict";

// Blackbaud (RE NXT) discount validator — aligned with power_automate_repro.js
// - Auth headers: Bearer access token + subscription key
// - Deterministic bucket derivation from constituent codes

try { require("dotenv").config(); } catch (_) {}

const https = require("https");

const API_BASE = (process.env.SKY_API_BASE || "https://api.sky.blackbaud.com").trim();

function parseSubscriptionKeys() {
  // Accept multiple ways to supply keys to support safe rotation
  // Priority: SKY_SUBSCRIPTION_KEYS (comma-separated), then primary/secondary, then single key
  const list = [];
  const csv = (process.env.SKY_SUBSCRIPTION_KEYS || "").trim();
  if (csv) {
    csv.split(/[,\s]+/).forEach((k) => { const v = (k || "").trim(); if (v) list.push(v); });
  }
  const p = (process.env.SKY_SUBSCRIPTION_KEY_PRIMARY || "").trim();
  const s = (process.env.SKY_SUBSCRIPTION_KEY_SECONDARY || process.env.SKY_SUBSCRIPTION_KEY_FALLBACK || "").trim();
  const single = (process.env.SKY_SUBSCRIPTION_KEY || "").trim();
  [p, s, single].forEach((v) => { if (v) list.push(v); });
  // de-dup while preserving order
  return Array.from(new Set(list));
}

function currentCreds() {
  try { require("dotenv").config({ override: false }); } catch (_) {}
  return {
    accessToken: (process.env.SKY_ACCESS_TOKEN || "").trim(),
    subscriptionKeys: parseSubscriptionKeys(),
  };
}

function assertCreds() {
  const { accessToken, subscriptionKeys } = currentCreds();
  if (!accessToken || !Array.isArray(subscriptionKeys) || subscriptionKeys.length === 0) {
    throw new Error("Missing SKY_ACCESS_TOKEN or SKY_SUBSCRIPTION_KEY(S)");
  }
}

async function httpGet(urlObj) {
  const { accessToken, subscriptionKeys } = currentCreds();

  async function onceWithKey(subKey) {
    return new Promise((resolve, reject) => {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        "Bb-Api-Subscription-Key": subKey,
        "Content-Type": "application/json",
      };

      const opts = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers,
      };
      const req = https.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data || "{}"), headers: res.headers });
          } catch (_) {
            resolve({ status: res.statusCode, body: data, headers: res.headers });
          }
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  // Try keys in order; fall back on 401/403 (covers key rotation). Return first non-401/403 result.
  let last = null;
  const keys = Array.isArray(subscriptionKeys) && subscriptionKeys.length ? subscriptionKeys : [""];
  for (let i = 0; i < keys.length; i++) {
    last = await onceWithKey(keys[i]);
    if (last && last.status !== 401 && last.status !== 403) return last;
  }
  return last;
}

function sanitizeId(s) {
  return String(s || "")
    .trim()
    .replace(/[\s\u200B\u00A0]+/g, " ")
    .replace(/[\u200B\u00A0]/g, "")
    .replace(/[.,;:]+$/g, "");
}

async function searchConstituents(searchText, { strict = false, nonConstituents = false } = {}) {
  assertCreds();
  const params = new URLSearchParams({ search_text: searchText });
  if (strict) params.set("strict_search", "true");
  if (nonConstituents === false) params.set("include_non_constituents", "false");
  const url = new URL("/constituent/v1/constituents/search?" + params.toString(), API_BASE);
  return httpGet(url);
}

async function getConstituentCodes(id) {
  assertCreds();
  const url = new URL(`/constituent/v1/constituents/${encodeURIComponent(id)}/constituentcodes`, API_BASE);
  return httpGet(url);
}

async function getConstituentById(id) {
  assertCreds();
  const url = new URL(`/constituent/v1/constituents/${encodeURIComponent(id)}`, API_BASE);
  return httpGet(url);
}

function monthsBetween(a, b) {
  const diffMs = Math.max(0, b.getTime() - a.getTime());
  return diffMs / (1000 * 60 * 60 * 24 * 30.4375);
}

function toDateFromYmd(start) {
  if (start && typeof start === "object" && Number.isFinite(start.y) && Number.isFinite(start.m) && Number.isFinite(start.d)) {
    const d = new Date(start.y, Math.max(0, start.m - 1), start.d);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function inferBucketsFromCodes(codes, now = new Date()) {
  const out = new Set();
  for (const c of codes || []) {
    const desc = String(c?.description || "").trim().toLowerCase();
    const inactive = !!c?.inactive;
    let months = null;

    if (desc === "student") {
      if (!inactive) out.add("Current UTS Student");
      continue;
    }
    if (desc === "staff") {
      if (!inactive) {
        out.add("Current UTS Staff");
      } else {
        const dt = (typeof c?.date_modified === "string" && !isNaN(new Date(c.date_modified)))
          ? new Date(c.date_modified)
          : (typeof c?.date_added === "string" && !isNaN(new Date(c.date_added))
            ? new Date(c.date_added)
            : null);
        months = dt ? monthsBetween(dt, now) : null;
        if (months != null && months <= 12 + 1e-6) out.add("Former UTS Staff (employed within the last 12 months)");
        else out.add("Former UTS Staff (employed more than 12 months ago)");
      }
      continue;
    }
    if (desc === "alumni") {
      const dt = toDateFromYmd(c?.start) || (typeof c?.date_added === "string" && !isNaN(new Date(c.date_added)) ? new Date(c.date_added) : null);
      months = dt ? monthsBetween(dt, now) : null;
      if (months != null && months <= 12 + 1e-6) out.add("UTS Alumni (graduated within the last 12 months)");
      else out.add("UTS Alumni (graduated more than 12 months ago)");
      continue;
    }
  }
  return Array.from(out);
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

function alumniCommencementFromCodes(codes) {
  for (const c of codes || []) {
    const desc = String(c?.description || "").trim().toLowerCase();
    if (desc === "alumni") {
      const dt = toDateFromYmd(c?.start);
      if (dt) return dt;
    }
  }
  return null;
}

function choosePrimaryBucket(buckets) {
  const order = [
    "Current UTS Student",
    "Current UTS Staff",
    "UTS Alumni (graduated within the last 12 months)",
    "UTS Alumni (graduated more than 12 months ago)",
    "Former UTS Staff (employed within the last 12 months)",
    "Former UTS Staff (employed more than 12 months ago)",
  ];
  for (const b of order) if (buckets.includes(b)) return b;
  return buckets[0] || null;
}

function normalizeEmail(s) { return String(s || "").trim().toLowerCase(); }

function stripDiacritics(s) {
  try { return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
  catch (_) { return String(s || ""); }
}

function normalizeName(s) {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitName(norm) {
  const parts = String(norm || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

function scoreName(candidateName, expectedName) {
  const c = normalizeName(candidateName);
  const e = normalizeName(expectedName);
  if (!c || !e) return 0;
  if (c === e) return 100;
  const cs = splitName(c); const es = splitName(e);
  if (cs.last && es.last && cs.last === es.last) {
    if (cs.first.startsWith(es.first) || es.first.startsWith(cs.first)) return 85;
  }
  const ct = new Set(c.split(" "));
  const et = new Set(e.split(" "));
  let inter = 0; for (const t of ct) if (et.has(t)) inter++;
  const jac = inter / Math.max(1, ct.size + et.size - inter);
  if (jac >= 0.5) return 60;
  return 0;
}

function resolveCandidate(results, { searchId, email, name } = {}) {
  const idStr = String(searchId || "").trim();
  const pool = (results || []).filter((r) => String(r?.lookup_id || "") !== idStr);
  if (pool.length <= 1) return pool[0] || null;

  const emailNorm = normalizeEmail(email);
  if (emailNorm) {
    const emailHit = pool.find((r) => normalizeEmail(r?.email?.address || r?.email) === emailNorm);
    if (emailHit) return emailHit;
  }

  if (name) {
    const scored = pool.map((r) => ({ r, s: scoreName(r?.name || "", name) }))
      .sort((a, b) => b.s - a.s);
    if (scored[0]?.s > 0) {
      const top = scored[0];
      const second = scored[1]?.s ?? 0;
      if (top.s >= 85 || top.s - second >= 15) return top.r;
      const eLast = splitName(normalizeName(name)).last;
      if (eLast) {
        const lastMatches = scored.filter(x => splitName(normalizeName(x.r?.name || "")).last === eLast);
        if (lastMatches.length === 1) return lastMatches[0].r;
      }
    }
  }

  return null; // ambiguous
}

function parseDobInput(dob) {
  const s = String(dob || "").trim();
  if (!s) return null;
  const t = s.replace(/[^0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const parts = t.split("-").map((x) => x.length ? Number(x) : NaN);
  if (parts.length === 3) {
    if (String(parts[0]).length === 4) return { y: parts[0], m: parts[1], d: parts[2] };
    if (String(parts[2]).length === 4) return { y: parts[2], m: parts[1], d: parts[0] };
  }
  if (parts.length === 2 && String(parts[0]).length === 4) return { y: parts[0], m: parts[1] };
  if (parts.length === 1 && String(parts[0]).length === 4) return { y: parts[0] };
  return null;
}

function matchDob(candidateBirthdate, dobExpected) {
  if (!candidateBirthdate || !dobExpected) return false;
  const y = Number(candidateBirthdate?.y) || null;
  const m = Number(candidateBirthdate?.m) || null;
  const d = Number(candidateBirthdate?.d) || null;
  if (dobExpected.y && y !== dobExpected.y) return false;
  if (dobExpected.m && m !== dobExpected.m) return false;
  if (dobExpected.d && d !== dobExpected.d) return false;
  return true;
}

async function resolveByDob(pool, dobStr) {
  const target = parseDobInput(dobStr);
  if (!target) return null;
  const matches = [];
  for (const r of pool) {
    const det = await getConstituentById(r.id);
    if (det.status !== 200) continue;
    const birth = det.json?.birthdate || null;
    if (matchDob(birth, target)) matches.push({ r, birth });
  }
  if (matches.length === 1) return matches[0].r;
  return null;
}

async function validateDiscount({ search_id, expected_bucket, email, name, dob }, opts = {}) {
  const debug = !!opts.debug;
  const trace = debug ? { input: { search_id, expected_bucket, email, name, dob }, steps: {} } : null;

  const sanitized = sanitizeId(search_id);
  const sr = await searchConstituents(sanitized, { strict: true, nonConstituents: false });
  if (debug) trace.steps.search = { status: sr.status, count: Array.isArray(sr.json?.value) ? sr.json.value.length : 0 };
  if (sr.status !== 200) {
    const out = { valid: false, status: "error", reason: `search ${sr.status}`, raw: sr.json || sr.body };
    if (debug) out.trace = trace;
    return out;
  }

  const value = Array.isArray(sr.json?.value) ? sr.json.value : [];
  if (value.length === 0) {
    const out = { valid: false, status: "not_found", reason: "no matches", candidates: [] };
    if (debug) out.trace = trace;
    return out;
  }

  let candidate = resolveCandidate(value, { searchId: sanitized, email, name });
  const pool = value.filter((r) => String(r?.lookup_id || "") !== String(sanitized));
  if (!candidate && dob) {
    const byDob = await resolveByDob(pool, dob);
    if (byDob) candidate = byDob;
  }

  // Helper to produce a response for a single resolved candidate
  async function evaluateSingle(resolved) {
    const id = resolved.id;
    const cr = await getConstituentCodes(id);
    if (debug) trace.steps.codes = { status: cr.status, count: Array.isArray(cr.json?.value) ? cr.json.value.length : 0 };
    if (cr.status !== 200) {
      const out = { valid: false, status: "error", reason: `codes ${cr.status}`, bb_record_id: id, raw: cr.json || cr.body };
      if (debug) out.trace = trace;
      return out;
    }
    const codes = Array.isArray(cr.json?.value) ? cr.json.value : [];
    const buckets = inferBucketsFromCodes(codes);
    const primary = choosePrimaryBucket(buckets);
    const valid = expected_bucket ? buckets.includes(expected_bucket) : (buckets.length > 0);
    const qualifiesOther = !valid && buckets.length > 0 && !!expected_bucket;
    let alumni_commencement = null;
    let alumni_expires_at = null;
    const alumnStart = alumniCommencementFromCodes(codes);
    if (alumnStart) {
      alumni_commencement = new Date(alumnStart.getTime()).toISOString();
      alumni_expires_at = addMonths(alumnStart, 12).toISOString();
    }
    const out = {
      valid,
      status: valid ? "valid" : "invalid",
      expected_bucket: expected_bucket || null,
      derived_buckets: buckets,
      primary_bucket: primary,
      bb_record_id: id,
      candidate: { id: resolved.id, name: resolved.name, email: resolved?.email?.address || resolved?.email, lookup_id: resolved.lookup_id },
      codes,
      qualifies_other: qualifiesOther,
      alumni_commencement,
      alumni_expires_at,
    };
    if (debug) out.trace = trace;
    return out;
  }

  if (candidate) {
    // We have a single resolved candidate via email/name/DOB — evaluate that one
    return await evaluateSingle(candidate);
  }

  // Ambiguous: loop all candidates (excluding lookup collisions) and compare buckets to expected
  if (pool.length === 0) {
    const out = { valid: false, status: "not_found", reason: "no matches after excluding lookup collisions", candidates: [] };
    if (debug) out.trace = trace;
    return out;
  }

  const evaluated = [];
  for (const r of pool) {
    const cr = await getConstituentCodes(r.id);
    if (cr.status !== 200) continue;
    const buckets = inferBucketsFromCodes(Array.isArray(cr.json?.value) ? cr.json.value : []);
    evaluated.push({ rec: r, buckets });
  }
  if (debug) trace.steps.multi_eval = { candidates: evaluated.map(x => ({ id: x.rec.id, lookup_id: x.rec.lookup_id, name: x.rec.name, buckets: x.buckets })) };

  const expectedMatches = expected_bucket ? evaluated.filter(x => x.buckets.includes(expected_bucket)) : evaluated.filter(x => x.buckets.length > 0);
  if (expected_bucket && expectedMatches.length === 1) {
    // Exactly one candidate matches the expected discount — treat as resolved and valid
    return await evaluateSingle(expectedMatches[0].rec);
  }
  if (expected_bucket && expectedMatches.length > 1) {
    const out = {
      valid: false,
      status: "ambiguous",
      reason: "multiple candidates match expected bucket",
      candidates: expectedMatches.map(x => ({ id: x.rec.id, name: x.rec.name, email: x.rec?.email?.address || x.rec?.email, lookup_id: x.rec.lookup_id }))
    };
    if (debug) out.trace = trace;
    return out;
  }

  // No candidate matched expected; report invalid with candidate buckets for transparency
  const out = {
    valid: false,
    status: "invalid",
    reason: expected_bucket ? "expected bucket not present on any candidate" : "no qualifying buckets",
    candidates: evaluated.map(x => ({ id: x.rec.id, name: x.rec.name, email: x.rec?.email?.address || x.rec?.email, lookup_id: x.rec.lookup_id, buckets: x.buckets }))
  };
  if (debug) out.trace = trace;
  return out;
}

module.exports = {
  searchConstituents,
  getConstituentCodes,
  inferBucketsFromCodes,
  validateDiscount,
};
