const express = require("express");
const Airtable = require("airtable");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const cors = require("cors");
const helmet = require("helmet");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs-extra");
// Load base .env first
require("dotenv").config();
// Optionally layer a runtime env file with short‑lived tokens (e.g., .env.runtime)
try {
  const SKY_ENV_FILE = process.env.SKY_ENV_FILE;
  if (SKY_ENV_FILE && fs.existsSync(SKY_ENV_FILE)) {
    require("dotenv").config({ path: SKY_ENV_FILE, override: true });
  }
} catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;
const DEV_MODE =
  String(process.env.DEV_MODE || "").toLowerCase() === "1" ||
  String(process.env.NODE_ENV || "").toLowerCase() === "development";

// Admin Alerts (Airtable) for critical operational issues
const ADMIN_ALERTS_TABLE_ID =
  process.env.ADMIN_ALERTS_TABLE_ID || "tblWd85LhYxtHUXDf";
async function createAdminAlert(type, notes) {
  try {
    if (!ADMIN_ALERTS_TABLE_ID) return { skipped: true };
    await base(ADMIN_ALERTS_TABLE_ID).create({
      Type: String(type || ""),
      Timestamp: new Date().toISOString(),
      Notes: String(notes || ""),
    });
    log("warn", "admin_alert.created", { type: String(type || "") });
    return { ok: true };
  } catch (e) {
    log("error", "admin_alert.failed", { message: e.message });
    return { error: e.message };
  }
}

// Trust proxy (required for Replit environment)
app.set("trust proxy", 1);

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
          "https://cdnjs.cloudflare.com",
        ],
        fontSrc: [
          "'self'",
          "https://fonts.gstatic.com",
          "https://cdnjs.cloudflare.com",
        ],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.jsdelivr.net",
          "https://airtable.com",
        ],
        imgSrc: ["'self'", "data:", "https:"],
        frameSrc: ["'self'", "https://airtable.com"],
        connectSrc: [
          "'self'",
          "https://api.airtable.com",
          "https://api.sky.blackbaud.com",
          "https://oauth2.sky.blackbaud.com",
        ],
      },
    },
  }),
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 90 * 60 * 1000, // 90 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
});

app.use(limiter);

// Route-specific rate limiters (surgical additions)
const discountLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});
const orchestratorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
});
const skyRefreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// ------------------------------
// Structured logging utilities
// ------------------------------
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
function shouldLog(level) {
  return (LEVELS[level] ?? 2) <= (LEVELS[LOG_LEVEL] ?? 2);
}
function redact(obj) {
  try {
    const jwtLike = /eyJ[0-9A-Za-z_-]+\.[0-9A-Za-z_-]+\.[0-9A-Za-z_-]*/g;
    const bearerRe = /(authorization\s*:\s*bearer\s+)([^\s]+)/i;
    const s = JSON.stringify(obj, (k, v) => {
      if (v == null) return v;
      const key = String(k || "").toLowerCase();
      if (
        key.includes("token") ||
        key.includes("secret") ||
        key.includes("authorization")
      )
        return "[redacted]";
      if (key.includes("magiclink") || key.includes("magic_link"))
        return "[redacted]";
      if (typeof v === "string") {
        let sv = v;
        sv = sv.replace(bearerRe, (_, p1) => p1 + "[redacted]");
        sv = sv.replace(jwtLike, "[redacted]");
        return sv;
      }
      return v;
    });
    return JSON.parse(s);
  } catch (_) {
    return obj;
  }
}
function log(level, event, data, req) {
  if (!shouldLog(level)) return;
  const payload = Object.assign(
    {
      ts: new Date().toISOString(),
      level,
      event,
      dev: DEV_MODE,
    },
    redact(data || {}),
  );
  if (req) {
    payload.req_id = req._reqId;
    payload.ip =
      req.ip || (req.headers && req.headers["x-forwarded-for"]) || undefined;
    if (req.user)
      payload.user = redact({
        startupId: req.user.startupId,
        startupName: req.user.startupName,
        email: req.user.email,
      });
  }
  try {
    console.log(JSON.stringify(payload));
  } catch (_) {
    console.log(`[${level}] ${event}`);
  }
}

// Truthy helper for Airtable fields that may be 1/true/'1'/'true'/'yes'
function asOne(v) {
  if (v === 1) return true;
  const t = typeof v;
  if (t === "number") return Number(v) === 1;
  if (t === "boolean") return !!v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return (
    s === "1" || s === "true" || s === "yes" || s === "y" || s === "checked"
  );
}

// Assign request ID and log request start/end
app.use((req, res, next) => {
  req._reqId = crypto.randomBytes(8).toString("hex");
  req._t0 = Date.now();
  log(
    "info",
    "http.req",
    { method: req.method, path: req.path, query: req.query },
    req,
  );
  res.on("finish", () => {
    log(
      "info",
      "http.res",
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - req._t0,
      },
      req,
    );
  });
  next();
});

// Airtable configuration
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID,
);
// Alias to avoid accidental shadowing of `base` in local scopes
const airtableBase = base;

// JWT token verification middleware
const verifyToken = (req, res, next) => {
  const token = req.params.token || req.body.token;

  if (!token) {
    return res
      .status(401)
      .json({ success: false, message: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      message: "Incorrect or expired link, please request a new one.",
    });
    //success: false, message: 'Invalid or expired token' });
  }
};

// URL helper to safely add prefill/hide params to Airtable form URLs
function augmentUrlWithParams(url, pairs) {
  try {
    if (!url) return url;
    const u = new URL(url);
    const sp = u.searchParams;
    for (const [k, v] of pairs) {
      if (v == null || v === "") continue;
      if (!sp.has(k)) sp.set(k, String(v));
    }
    return u.toString();
  } catch (_) {
    return url;
  }
}

// Determine if a member has requested a discount
function hasDiscountRequest(expectedRaw) {
  if (!expectedRaw) return false;
  const s = String(expectedRaw).trim().toLowerCase();
  if (!s) return false;
  return s !== "none of the above";
}

// Internal or JWT auth for canonical endpoints
const verifyInternalOrJWT = (req, res, next) => {
  const hdr = req.get("X-Auth-Token");
  if (process.env.AUTH_TOKEN && hdr && hdr === process.env.AUTH_TOKEN)
    return next();
  if (req.params && req.params.token) return verifyToken(req, res, next);
  if (req.body && req.body.token) return verifyToken(req, res, next);
  return res.status(401).json({ success: false, message: "Unauthorized" });
};

// SKY token refresh helper (spawns 56eration/oauth_refresh.js)
function runSkyRefresh() {
  return new Promise((resolve) => {
    const cp = spawn(
      process.execPath,
      ["validation_generation/oauth_refresh.js"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    cp.stdout.on("data", (c) => (out += c.toString()));
    cp.stderr.on("data", (c) => (err += c.toString()));
    cp.on("exit", (code) => {
      if (code === 0) {
        try {
          const SKY_ENV_FILE = process.env.SKY_ENV_FILE;
          if (SKY_ENV_FILE && fs.existsSync(SKY_ENV_FILE)) {
            require("dotenv").config({ path: SKY_ENV_FILE, override: true });
          } else {
            require("dotenv").config({ override: true });
          }
        } catch (_) {}
        return resolve({ ok: true, out: out.trim() });
      }
      const payload = { ok: false, err: err.trim(), code };
      const isInvalidGrant =
        code === 10 || /invalid_grant/i.test(payload.err || "");
      if (isInvalidGrant) {
        const note = `Refresh failed: invalid_grant. code=${code}; stderr=${(payload.err || "").slice(0, 200)}; stdout=${(out || "").slice(0, 200)}`;
        Promise.resolve(createAdminAlert("SKY Invalid Grant", note)).finally(
          () => resolve(payload),
        );
        return;
      }
      resolve(payload);
    });
  });
}

function ymd(date = new Date()) {
  const d = new Date(date.getTime());
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

async function updateMemberValidation(memberRecordId, result, expected) {
  if (!memberRecordId) return { skipped: true };
  const tableId = process.env.TEAM_MEMBERS_TABLE_ID;
  if (!tableId) return { error: "TEAM_MEMBERS_TABLE_ID missing" };

  const VALIDATED_SELECT =
    process.env.AIRTABLE_MEMBERS_VALIDATED_SELECT_FIELD || "Discount Validated";
  const VALID_DATE =
    process.env.AIRTABLE_MEMBERS_VALID_DATE_FIELD || "Discount Valid Date";
  const EXPIRES =
    process.env.AIRTABLE_MEMBERS_DISCOUNT_EXPIRES_FIELD || "Discount Expires";
  const EXPECTED =
    process.env.AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD || "Discount Category";

  let selection = "Invalid";
  if (result && result.valid) selection = "Valid";
  else if (result && result.qualifies_other) selection = "Qualifies for Other";
  else if (result && result.status === "ambiguous") selection = "Ambiguous";

  const fields = {};
  fields[VALIDATED_SELECT] = selection;
  fields[VALID_DATE] = ymd();
  if (result && result.alumni_expires_at)
    fields[EXPIRES] = String(result.alumni_expires_at).slice(0, 10);
  if (expected) fields[EXPECTED] = expected;

  await base(tableId).update(memberRecordId, fields);
  return { ok: true, fields };
}

// Helper function to generate magic link
// Now accepts optional `startupRecordId` (UTS Startups record id) to carry through the flow
const generateMagicLink = (
  startupId,
  startupName,
  email,
  startupRecordId = null,
) => {
  const token = jwt.sign(
    {
      startupId,
      startupName,
      email,
      // Include UTS Startups record id if known (helps server use linked ID instead of names)
      startupRecordId,
      timestamp: Date.now(),
    },
    process.env.JWT_SECRET,
    { expiresIn: "90m" },
  );

  // Prefer local when in development to avoid accidentally linking prod
  let baseUrl;
  if (DEV_MODE) {
    baseUrl = `http://localhost:${PORT}`;
  } else if (process.env.REPLIT_DEV_DOMAIN) {
    baseUrl = `https://${process.env.REPLIT_DEV_DOMAIN}`;
  } else if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
    baseUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
  } else if (process.env.REPLIT_URL) {
    baseUrl = process.env.REPLIT_URL;
  } else if (
    process.env.NODE_ENV === "production" &&
    process.env.PRODUCTION_URL
  ) {
    baseUrl = process.env.PRODUCTION_URL;
  } else if (typeof process.env.REPLIT !== "undefined" || process.env.REPL_ID) {
    baseUrl =
      "https://753aaab8-78b2-467e-9254-11a447b6ee4a-00-ikckowe1kplg.picard.replit.dev";
  } else {
    baseUrl = `http://localhost:${PORT}`;
  }

  return `${baseUrl}/dashboard/${token}`;
};

// Routes

// Landing page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Canonical: health endpoint (no auth)
app.get("/healthz", (_req, res) => {
  res.json({ success: true, data: { ok: true } });
});
// Agreement page
app.get("/agreement/:token", verifyToken, async (req, res) => {
  try {
    const html = `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Validation & Agreement</title>
      <link rel="stylesheet" href="/css/agreement.css" />
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>Validation & Agreement</h2>
          <div class="status" id="job-status">Starting�</div>
        </div>
        <div class="panel">
          <div class="actions">
            <a id="download-pdf-link" href="#" target="_blank" rel="noopener">
              <button id="download-pdf-btn" class="btn btn-primary" disabled>
                <i class="fas fa-file-pdf"></i> Download Agreement
              </button>
            </a>
            <a href="/" class="btn">Back to Home</a>
          </div>
          <p class="muted">We are validating your team and generating your agreement. This may take a moment.</p>
        </div>
        <div class="panel">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Type</th>
                <th>Discount (expected)</th>
                <th>Status</th>
                <th>Reason / Bucket</th>
              </tr>
            </thead>
            <tbody id="members-body"></tbody>
          </table>
        </div>
        <div class="panel upload-panel">
          <h3 style="margin-top:0">Upload Signed Agreement (PDF)</h3>
          <p class="muted">Select the signed PDF from your device.</p>
          <div class="actions" style="gap:8px; flex-wrap:wrap">
            <input type="file" id="signed-file" accept="application/pdf" />
            <button id="upload-signed-btn" class="btn" disabled>
              <i class="fas fa-upload"></i> Upload Signed PDF
            </button>
            <span id="upload-signed-status" class="muted"></span>
          </div>
        </div>
      </div>
      <script>window.agreementData = { token: ${JSON.stringify(req.params.token)} };</script>
      <script src="/js/agreement.js"></script>
    </body>
    </html>`;
    res.setHeader("Content-Type", "text/html");
    res.status(200).send(html);
  } catch (e) {
    res.status(500).send("Failed to render agreement page");
  }
});

// Email lookup and magic link generation
app.post("/lookup-email", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    log("info", "lookup_email.start", { email }, req);
    let startup = null;
    let accessType = null; // 'onboarding' or 'management'
    let targetTable = null;

    // STEP 1: Check EOI table for approved startups, then check if they need onboarding
    try {
      const eoiRecords = await base(process.env.UTS_EOI_TABLE_ID)
        .select({
          filterByFormula:
            'AND({Email} = "' + email + '", {Status} = "Approved")',
        })
        .firstPage();
      log(
        "debug",
        "lookup_email.env",
        { UTS_EOI_TABLE_ID: process.env.UTS_EOI_TABLE_ID },
        req,
      );

      if (eoiRecords.length > 0) {
        const eoiRecord = eoiRecords[0];
        const startupName = eoiRecord.get("Startup Name");

        // Now check if this startup exists in Startups table and onboarding status
        try {
          const startupRecords = await airtableBase(
            process.env.UTS_STARTUPS_TABLE_ID,
          )
            .select({
              filterByFormula:
                '{Startup Name (or working title)} = "' + startupName + '"',
            })
            .firstPage();

          log(
            "debug",
            "lookup_email.startups.query",
            { count: startupRecords.length },
            req,
          );
          if (startupRecords.length > 0) {
            // Startup exists in Startups table - check onboarding status
            const startupRecord = startupRecords[0];
            const onboardingSubmitted =
              startupRecord.get("Onboarding Submitted") || 0;
            log(
              "debug",
              "lookup_email.startups.record",
              { onboardingSubmitted },
              req,
            );
            if (onboardingSubmitted === 0) {
              // Needs onboarding - store magic link in EOI table
              const utsStartupsField = eoiRecord.get("UTS Startups");
              let representativeFormUrl = null;

              // Get URL from linked UTS Startups record if it exists
              log("debug", "lookup_email.eoi.link", { utsStartupsField }, req);
              if (utsStartupsField && utsStartupsField.length > 0) {
                try {
                  log(
                    "debug",
                    "lookup_email.link.lookup",
                    { linkedId: utsStartupsField[0] },
                    req,
                  );
                  const linkedStartupRecord = await airtableBase(
                    process.env.UTS_STARTUPS_TABLE_ID,
                  ).find(utsStartupsField[0]);
                  representativeFormUrl = linkedStartupRecord.get(
                    "03. Startup Representative Details Prefilled",
                  );
                  log(
                    "debug",
                    "lookup_email.link.rep_url",
                    { representativeFormUrl },
                    req,
                  );
                } catch (error) {
                  console.log(
                    "Error fetching linked startup record:",
                    error.message,
                  );
                }
              } else {
                log("warn", "lookup_email.no_link", {}, req);
              }

              startup = {
                id: eoiRecord.id,
                name: startupName,
                primaryContact: email,
                status: eoiRecord.get("Status"),
                isEOIApproved: true,
                needsOnboarding: true,
                eoiName: eoiRecord.get("EOI") || startupName,
                prefilledFormUrl: eoiRecord.get(
                  "02. Startup Onboarding Form Prefilled",
                ),
                representativeFormUrl: representativeFormUrl,
                teamMemberFormUrl: representativeFormUrl,
                step2Unlocked: utsStartupsField && utsStartupsField.length > 0,
                // UTS Startups linked record id, if present
                startupRecordId:
                  utsStartupsField && utsStartupsField.length > 0
                    ? utsStartupsField[0]
                    : null,
              };
              accessType = "onboarding";
              targetTable = process.env.UTS_EOI_TABLE_ID;
            } else {
              // Already onboarded - treat as management (use startups table)
              startup = {
                id: startupRecord.id,
                name: startupRecord.get("Startup Name (or working title)"),
                primaryContact: email,
                recordId: startupRecord.get("Record ID"),
                status: startupRecord.get("Startup status"),
                isEOIApproved: false,
                needsOnboarding: false,
                eoiName: startupRecord.get("Startup Name (or working title)"),
                representativeFormUrl: startupRecord.get(
                  "03. Startup Representative Details Prefilled",
                ),
                teamMemberFormUrl: startupRecord.get(
                  "03. Startup Representative Details Prefilled",
                ),
                // For management path, the startups record id is known
                startupRecordId: startupRecord.id,
              };
              accessType = "management";
              targetTable = process.env.UTS_STARTUPS_TABLE_ID;
            }
          } else {
            // EOI approved but no startup record yet - needs onboarding
            const utsStartupsField = eoiRecord.get("UTS Startups");
            let representativeFormUrl = null;

            // Get URL from linked UTS Startups record if it exists
            if (utsStartupsField && utsStartupsField.length > 0) {
              try {
                const linkedStartupRecord = await airtableBase(
                  process.env.UTS_STARTUPS_TABLE_ID,
                ).find(utsStartupsField[0]);
                representativeFormUrl = linkedStartupRecord.get(
                  "03. Startup Representative Details Prefilled",
                );
                console.log(
                  "Fetched representativeFormUrl from linked record (no startup):",
                  representativeFormUrl,
                );
              } catch (error) {
                console.log(
                  "Error fetching linked startup record (no startup):",
                  error.message,
                );
              }
            }

            startup = {
              id: eoiRecord.id,
              name: startupName,
              primaryContact: email,
              status: eoiRecord.get("Status"),
              isEOIApproved: true,
              needsOnboarding: true,
              eoiName: eoiRecord.get("EOI") || startupName,
              prefilledFormUrl: eoiRecord.get(
                "02. Startup Onboarding Form Prefilled",
              ),
              representativeFormUrl: representativeFormUrl,
              step2Unlocked: utsStartupsField && utsStartupsField.length > 0,
            };
            accessType = "onboarding";
            targetTable = process.env.UTS_EOI_TABLE_ID;
          }
        } catch (startupError) {
          log(
            "warn",
            "lookup_email.startups.error",
            { message: startupError.message },
            req,
          );
          // Fallback to onboarding flow
          const utsStartupsField = eoiRecord.get("UTS Startups");
          let representativeFormUrl = null;

          // Get URL from linked UTS Startups record if it exists
          if (utsStartupsField && utsStartupsField.length > 0) {
            try {
              const linkedStartupRecord = await airtableBase(
                process.env.UTS_STARTUPS_TABLE_ID,
              ).find(utsStartupsField[0]);
              representativeFormUrl = linkedStartupRecord.get(
                "03. Startup Representative Details Prefilled",
              );
              console.log(
                "Fetched representativeFormUrl from linked record (fallback):",
                representativeFormUrl,
              );
            } catch (error) {
              console.log(
                "Error fetching linked startup record (fallback):",
                error.message,
              );
            }
          }

          startup = {
            id: eoiRecord.id,
            name: startupName,
            primaryContact: email,
            status: eoiRecord.get("Status"),
            isEOIApproved: true,
            needsOnboarding: true,
            eoiName: eoiRecord.get("EOI") || startupName,
            prefilledFormUrl: eoiRecord.get(
              "02. Startup Onboarding Form Prefilled",
            ),
            representativeFormUrl: representativeFormUrl,
            step2Unlocked: utsStartupsField && utsStartupsField.length > 0,
            startupRecordId:
              utsStartupsField && utsStartupsField.length > 0
                ? utsStartupsField[0]
                : null,
          };
          accessType = "onboarding";
          targetTable = process.env.UTS_EOI_TABLE_ID;
        }
      }
    } catch (error) {
      log("warn", "lookup_email.eoi.error", { message: error.message }, req);
    }

    // STEP 2: If not onboarding, check UTS Startups table for management
    console.log("DEBUG: Checking management path, startup is null:", !startup);
    if (!startup) {
      try {
        const startupRecords = await airtableBase(
          process.env.UTS_STARTUPS_TABLE_ID,
        )
          .select({
            filterByFormula: '{Primary contact email} = "' + email + '"',
          })
          .firstPage();

        console.log(
          "DEBUG: Found startup records in management path:",
          startupRecords.length,
        );
        if (startupRecords.length > 0) {
          const startupRecord = startupRecords[0];
          startup = {
            id: startupRecord.id,
            name: startupRecord.get("Startup Name (or working title)"),
            primaryContact: email,
            recordId: startupRecord.get("Record ID"),
            status: startupRecord.get("Startup status"),
            isEOIApproved: false,
            needsOnboarding: false,
            eoiName: startupRecord.get("Startup Name (or working title)"),
            representativeFormUrl: startupRecord.get(
              "03. Startup Representative Details Prefilled",
            ),
            startupRecordId: startupRecord.id,
          };
          console.log(
            "Management path - representativeFormUrl from Airtable:",
            startupRecord.get("03. Startup Representative Details Prefilled"),
          );
          accessType = "management";
          targetTable = process.env.UTS_STARTUPS_TABLE_ID;
        }
      } catch (error) {
        log("warn", "lookup_email.mgmt.error", { message: error.message }, req);
      }
    }

    if (!startup) {
      return res.status(404).json({
        success: false,
        message:
          "Email not found in our system. Please ensure you have submitted an EOI and it has been approved, or you are the primary contact for an existing startup.",
      });
    }

    // Generate magic link (carry UTS Startups record id when available)
    const magicLink = generateMagicLink(
      startup.id,
      startup.name,
      email,
      startup.startupRecordId || null,
    );
    log(
      "info",
      "lookup_email.magic_link",
      { base: magicLink.split("/dashboard/")[0], dev: DEV_MODE },
      req,
    );
    const expiresAt = new Date(Date.now() + 90 * 60 * 1000); // 90 minutes

    // Update the target table with magic link
    await base(targetTable).update(startup.id, {
      "Magic Link": magicLink,
      "Token Expires At": expiresAt.toISOString(),
      Link: magicLink,
    });

    // Provide different messages based on access type
    let message = "Magic link generated successfully!";
    if (accessType === "onboarding") {
      message = "Welcome! Complete your startup onboarding process.";
    } else if (accessType === "management") {
      message = "Access your startup dashboard to manage your team.";
    }

    res.json({
      success: true,
      message: message,
      accessType: accessType,
      magicLink: magicLink, // In production, this would be sent via email
      devMode: DEV_MODE,
    });
  } catch (error) {
    console.error("Email lookup error:", error);
    res.status(500).json({
      success: false,
      message:
        "An error occurred while processing your request. Please try again.",
    });
  }
});

// Canonical: discount validation (JWT or X-Auth-Token)
app.post(
  "/discount-check",
  discountLimiter,
  verifyInternalOrJWT,
  async (req, res) => {
    try {
      const {
        memberRecordId,
        search_id: bodySearchId,
        expected: bodyExpected,
        email: bodyEmail,
        name: bodyName,
        dob: bodyDob,
        updateAirtable = true,
        debug: bodyDebug,
      } = req.body || {};

      const validator = require("./validation_generation/validation/blackbaudDiscountValidator");
      function hasSkyCreds() {
        const at = (process.env.SKY_ACCESS_TOKEN || "").trim();
        const k = (
          process.env.SKY_SUBSCRIPTION_KEYS ||
          process.env.SKY_SUBSCRIPTION_KEY ||
          process.env.SKY_SUBSCRIPTION_KEY_PRIMARY ||
          ""
        ).trim();
        return !!(at && k);
      }
      const debug =
        String(req.query.debug || "").toLowerCase() === "1" ||
        String(bodyDebug || "").toLowerCase() === "true";

      let memberRec = null;
      if (memberRecordId && process.env.TEAM_MEMBERS_TABLE_ID) {
        try {
          memberRec = await base(process.env.TEAM_MEMBERS_TABLE_ID).find(
            memberRecordId,
          );
        } catch (_) {}
      }

      function fieldStr(rec, fieldName) {
        if (!rec || !rec.get) return "";
        const v = rec.get(fieldName);
        if (v == null) return "";
        if (typeof v === "string") return v;
        if (typeof v === "number") return String(v);
        if (typeof v === "boolean") return v ? "Yes" : "No";
        if (Array.isArray(v))
          return v
            .map((x) => (x && x.name ? x.name : typeof x === "string" ? x : ""))
            .filter(Boolean)
            .join(", ");
        if (v && v.name) return v.name;
        return String(v);
      }

      const search_id = (
        bodySearchId ||
        fieldStr(
          memberRec,
          process.env.AIRTABLE_MEMBERS_INTERNAL_ID_FIELD || "UTS ID",
        ) ||
        ""
      )
        .toString()
        .trim();
      // Expected discount category (preferring Manual Discount Category when manual check is present)
      let expected =
        bodyExpected ||
        fieldStr(
          memberRec,
          process.env.AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD ||
            "Discount Category",
        ) ||
        "";
      try {
        const manualCheckField =
          process.env.AIRTABLE_MEMBERS_MANUAL_OVERRIDE_FIELD ||
          "Manual Discount Check";
        const manualCategoryField =
          process.env.AIRTABLE_MEMBERS_MANUAL_DISCOUNT_CATEGORY_FIELD ||
          "Manual Discount Category";
        const manualCheckVal = fieldStr(memberRec, manualCheckField);
        if ((manualCheckVal || "").toString().trim()) {
          const manualCat = fieldStr(memberRec, manualCategoryField);
          if ((manualCat || "").toString().trim()) expected = manualCat;
        }
      } catch (_) {}
      const email =
        bodyEmail ||
        fieldStr(
          memberRec,
          process.env.AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD || "UTS Email",
        ) ||
        "";
      const name =
        bodyName ||
        fieldStr(
          memberRec,
          process.env.AIRTABLE_MEMBERS_NAME_FIELD || "Name",
        ) ||
        "";
      const dob =
        bodyDob ||
        fieldStr(
          memberRec,
          process.env.AIRTABLE_MEMBERS_DOB_FIELD || "Date of birth*",
        ) ||
        fieldStr(memberRec, "Date of Birth") ||
        fieldStr(memberRec, "DOB") ||
        "";

      // Manual override: if the Team Member record has a non-empty
      // 'Manual Discount Check' field (configurable), bypass SKY validation
      // and return a deterministic skipped result. We do NOT update Airtable
      // validation fields in this path (record is used as-is).
      try {
        const manualField =
          process.env.AIRTABLE_MEMBERS_MANUAL_OVERRIDE_FIELD ||
          "Manual Discount Check";
        const manualVal = fieldStr(memberRec, manualField);
        if ((manualVal || "").toString().trim()) {
          log(
            "info",
            "discount_check.skip_manual_override",
            { memberRecordId, field: manualField },
            req,
          );
          const result = {
            valid: false,
            status: "skipped",
            reason: "manual_override",
          };
          return res.json({
            success: true,
            data: {
              input: { memberRecordId, search_id, expected, email, name, dob },
              result,
              airtableUpdate: null,
            },
          });
        }
      } catch (_) {}

      // Skip validation when no discount requested (expected empty or 'None of the above')
      if (!hasDiscountRequest(expected)) {
        log(
          "info",
          "discount_check.skip_no_request",
          { memberRecordId, expected },
          req,
        );
        return res.json({
          success: true,
          data: {
            input: { memberRecordId, search_id, expected, email, name, dob },
            result: {
              valid: false,
              status: "skipped",
              reason: "no_discount_requested",
            },
            airtableUpdate: null,
          },
        });
      }

      log(
        "info",
        "discount_check.start",
        {
          memberRecordId,
          search_id,
          expected,
          hasEmail: !!email,
          hasDOB: !!dob,
        },
        req,
      );

      if (!search_id) {
        return res.status(400).json({
          success: false,
          message: "Missing search_id and no member field available",
        });
      }

      // DEV fallback: if explicitly enabled or SKY creds are missing, simulate a valid result
      const devFake =
        DEV_MODE &&
        (String(process.env.DEV_FAKE_VALIDATION || "").toLowerCase() === "1" ||
          !hasSkyCreds());
      let result;
      if (devFake) {
        const bucket = expected || "Current UTS Staff";
        result = {
          valid: true,
          status: "valid",
          expected_bucket: expected || null,
          derived_buckets: [bucket],
          primary_bucket: bucket,
          bb_record_id: "DEV-FAKE",
          candidate: { id: "DEV", name, email, lookup_id: search_id },
          codes: [],
          qualifies_other: false,
          alumni_commencement: null,
          alumni_expires_at: null,
        };
      } else {
        result = await validator.validateDiscount(
          { search_id, expected_bucket: expected, email, name, dob },
          { debug },
        );
        if (
          (result &&
            result.raw &&
            (result.raw.statusCode === 401 || result.raw.status === 401)) ||
          /401/.test(String(result?.reason || ""))
        ) {
          const rf = await runSkyRefresh();
          if (rf && rf.ok) {
            try {
              const SKY_ENV_FILE = process.env.SKY_ENV_FILE;
              if (SKY_ENV_FILE && fs.existsSync(SKY_ENV_FILE)) {
                require("dotenv").config({
                  path: SKY_ENV_FILE,
                  override: true,
                });
              } else {
                require("dotenv").config({ override: true });
              }
            } catch (_) {}
            result = await validator.validateDiscount(
              { search_id, expected_bucket: expected, email, name, dob },
              { debug },
            );
          }
        }
      }

      let airtableUpdate = null;
      if (memberRecordId && updateAirtable) {
        try {
          airtableUpdate = await updateMemberValidation(
            memberRecordId,
            result,
            expected,
          );
        } catch (e) {
          airtableUpdate = { error: e.message };
        }
      }

      if (result && result.status === "error") {
        log(
          "error",
          "discount_check.error",
          {
            memberRecordId,
            reason: result.reason || "error",
            rawStatus: result?.raw?.status || result?.raw?.statusCode,
          },
          req,
        );
        return res.status(502).json({
          success: false,
          message: "Upstream validation error",
          data: {
            input: { memberRecordId, search_id, expected, email, name, dob },
            result,
            airtableUpdate,
          },
        });
      }

      log(
        "info",
        "discount_check.result",
        {
          memberRecordId,
          status: result.status,
          valid: result.valid,
          primary_bucket: result.primary_bucket,
        },
        req,
      );
      return res.json({
        success: true,
        data: {
          input: { memberRecordId, search_id, expected, email, name, dob },
          result,
          airtableUpdate,
        },
      });
    } catch (e) {
      log("error", "discount_check.exception", { message: e.message }, req);
      return res.status(500).json({
        success: false,
        message: "Internal error during discount validation",
      });
    }
  },
);

// Dashboard route
app.get("/dashboard/:token", verifyToken, async (req, res) => {
  try {
    const { startupId, startupName, email } = req.user;

    // Get startup information
    let startup = null;
    let isEOIApproved = false;

    // First try EOI table
    try {
      const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(
        startupId,
      );
      const utsStartupsField = eoiRecord.get("UTS Startups");
      const startupRecordIdFromEOI =
        utsStartupsField && utsStartupsField.length > 0
          ? utsStartupsField[0]
          : req.user.startupRecordId || null;
      startup = {
        id: eoiRecord.id,
        name: eoiRecord.get("Startup Name (or working title)"),
        primaryContact: eoiRecord.get("Primary contact email"),
        status: eoiRecord.get("Status"),
        onboardingSubmitted: eoiRecord.get("Onboarding Submitted") || 0,
        startupRecordId: startupRecordIdFromEOI,
      };
      isEOIApproved = true;
    } catch (error) {
      // Try UTS Startups table
      try {
        const startupRecord = await airtableBase(
          process.env.UTS_STARTUPS_TABLE_ID,
        ).find(startupId);
        startup = {
          id: startupRecord.id,
          name: startupRecord.get("Startup Name (or working title)"),
          primaryContact: startupRecord.get("Primary contact email"),
          recordId: startupRecord.get("Record ID"),
          status: startupRecord.get("Startup status"),
          onboardingSubmitted: startupRecord.get("Onboarding Submitted") || 0,
          startupRecordId: startupRecord.id,
        };
      } catch (innerError) {
        throw new Error("Startup not found");
      }
    }

    // Get team members
    // Get team members ? prefer current name from Startups record to handle renamed startups
    let memberFilterName = startup.name;
    try {
      if (startup.startupRecordId) {
        const srForName = await airtableBase(
          process.env.UTS_STARTUPS_TABLE_ID,
        ).find(startup.startupRecordId);
        const currentName =
          srForName.get("Startup Name (or working title)") || null;
        if (currentName && currentName !== memberFilterName) {
          log(
            "info",
            "dashboard.member_filter.rename",
            { was: memberFilterName, now: currentName },
            req,
          );
          memberFilterName = currentName;
        }
      }
    } catch (_) {
      /* ignore */
    }
    const teamMemberRecords = startup.startupRecordId
      ? await listTeamMembersByStartupId(startup.startupRecordId)
      : [];

    const teamMembers = teamMemberRecords.map((record) => ({
      id: record.id,
      name: record.get("Team member ID") || "Unknown",
      email: record.get("Personal email*"),
      mobile: record.get("Mobile*"),
      position: record.get("Position at startup*") || record.get("Role"),
      representative: asOne(record.get("Representative")),
      utsAssociation: record.get("What is your association to UTS?*"),
      status: record.get("Team Member Status"),
    }));

    const dashboardData = {
      startup,
      teamMembers,
      token: req.params.token,
      isEOIApproved,
      formUrls: {
        startupOnboarding: process.env.STARTUP_ONBOARDING_FORM_URL,
        teamMember: process.env.TEAM_MEMBER_FORM_URL,
      },
    };

    res.send(generateDashboardHTML(dashboardData));
  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).send(`
      <html>
        <head>
          <title>Error - UTS Startup Portal</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            .error { color: #e74c3c; }
          </style>
        </head>
        <body>
          <h1 class="error">Error Loading Dashboard</h1>
          <p>An error occurred while loading your dashboard. Please try again.</p>
          <a href="/">Return to Home</a>
        </body>
      </html>
    `);
  }
});

// Update profile endpoint
app.post("/update-profile", verifyToken, async (req, res) => {
  try {
    const { memberId, updates } = req.body;

    if (!memberId || !updates) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required fields" });
    }

    await base(process.env.TEAM_MEMBERS_TABLE_ID).update(memberId, updates);

    res.json({ success: true, message: "Profile updated successfully!" });
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update profile. Please try again.",
    });
  }
});

// New API endpoints for individual form data fetching

// Endpoint to fetch header information (EOI and Email)
app.get("/get-header-info/:token", verifyToken, async (req, res) => {
  try {
    const { startupId } = req.user;

    // Get EOI and Email from EOI table
    const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
    const eoiName = eoiRecord.get("EOI");
    const email = eoiRecord.get("Email");

    res.json({
      success: true,
      eoiName: eoiName || "No EOI Name",
      email: email || "No Email",
    });
  } catch (error) {
    console.error("Get header info error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch header information." });
  }
});

// Endpoint to fetch Startup Information form URL
app.get("/get-startup-form/:token", verifyToken, async (req, res) => {
  try {
    const { startupId } = req.user;

    // Get startup information from EOI table
    const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
    const startupFormUrl = eoiRecord.get(
      "02. Startup Onboarding Form Prefilled",
    );

    res.json({
      success: true,
      formUrl: startupFormUrl || null,
    });
  } catch (error) {
    console.error("Get startup form error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch startup form URL." });
  }
});

// Endpoint to fetch Startup Representative form URL
app.get("/get-representative-form/:token", verifyToken, async (req, res) => {
  try {
    const { startupId } = req.user;

    // Step 1: Get UTS Startups field from EOI table
    const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
    const utsStartupsField = eoiRecord.get("UTS Startups");

    if (!utsStartupsField || utsStartupsField.length === 0) {
      return res.json({
        success: false,
        message: "Fill in Startup Information Form",
      });
    }

    // Step 2: Get representative form URL from linked UTS Startups record
    const linkedStartupRecord = await airtableBase(
      process.env.UTS_STARTUPS_TABLE_ID,
    ).find(utsStartupsField[0]);
    const representativeFormUrl = linkedStartupRecord.get(
      "03. Startup Representative Details Prefilled",
    );

    // Augment with authoritative prefill/hide parameters using the linked Startups record ID
    let outUrl = representativeFormUrl || null;
    if (outUrl) {
      const startupRecId = utsStartupsField[0];
      outUrl = augmentUrlWithParams(outUrl, [
        ["prefill_Startup", startupRecId],
        ["hide_Startup", "true"],
        // Some bases use a required field name with an asterisk
        ["prefill_Startup*", startupRecId],
        ["hide_Startup*", "true"],
        // Ensure the rep flag is set in the form
        ["prefill_Representative", "1"],
      ]);
    }

    res.json({
      success: true,
      formUrl: outUrl,
    });
  } catch (error) {
    console.error("Get representative form error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch representative form URL.",
    });
  }
});

// Ensure Representative flag (1) is set for representative submissions
app.post(
  "/ensure-representative-position/:token",
  verifyToken,
  async (req, res) => {
    try {
      const { startupName, startupId } = req.user;

      // Try to resolve linked Startup record to get primary contact email (helps target the rep)
      let primaryContactEmail = null;
      try {
        const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(
          startupId,
        );
        const utsStartupsField = eoiRecord.get("UTS Startups");
        if (utsStartupsField && utsStartupsField.length > 0) {
          const linkedStartupRecord = await airtableBase(
            process.env.UTS_STARTUPS_TABLE_ID,
          ).find(utsStartupsField[0]);
          primaryContactEmail =
            linkedStartupRecord.get("Primary contact email") || null;
        }
      } catch (_) {}

      // Fetch team members strictly by linked Startup recordId
      const startupRecId = (utsStartupsField && utsStartupsField[0]) || null;
      const teamMemberRecords = startupRecId
        ? await listTeamMembersByStartupId(startupRecId)
        : [];

      let updated = 0;

      // Choose candidate: prefer match on primary contact email; otherwise latest recently created record
      let candidate = null;

      if (primaryContactEmail) {
        const match = teamMemberRecords.find((r) => {
          const email = (r.get("Personal email*") || "").toString();
          const rep = r.get("Representative") || 0;
          return (
            email &&
            email.toLowerCase() === primaryContactEmail.toLowerCase() &&
            !(rep === 1 || rep === true || String(rep).toLowerCase() === "yes")
          );
        });
        if (match) candidate = match;
      }

      if (!candidate) {
        const recent = teamMemberRecords
          .map((r) => ({
            r,
            created:
              Date.parse(
                r._rawJson && r._rawJson.createdTime
                  ? r._rawJson.createdTime
                  : 0,
              ) || 0,
          }))
          .sort((a, b) => b.created - a.created);
        const first = recent.find((x) => !asOne(x.r.get("Representative")));
        if (first) candidate = first.r;
      }

      // Fallback: if nothing found under startup linkage, search by primary contact email across the table
      if (!candidate && primaryContactEmail) {
        try {
          const byEmail = await base(process.env.TEAM_MEMBERS_TABLE_ID)
            .select({
              filterByFormula:
                '{Personal email*} = "' + primaryContactEmail + '"',
            })
            .firstPage();
          const recent2 = byEmail
            .map((r) => ({
              r,
              created:
                Date.parse(
                  r._rawJson && r._rawJson.createdTime
                    ? r._rawJson.createdTime
                    : 0,
                ) || 0,
            }))
            .sort((a, b) => b.created - a.created);
          const first2 = recent2.find((x) => !asOne(x.r.get("Representative")));
          if (first2) candidate = first2.r;
        } catch (_) {}
      }

      if (candidate) {
        try {
          await base(process.env.TEAM_MEMBERS_TABLE_ID).update(candidate.id, {
            Representative: "1",
          });
          updated = 1;
        } catch (e) {
          // ignore
        }
      }

      return res.json({
        success: true,
        message: "Ensured Representative flag",
        data: { updated },
      });
    } catch (error) {
      console.error("ensure-representative-position error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to ensure Representative flag.",
      });
    }
  },
);

// Endpoint to fetch Team Members form URL
app.get("/get-team-members-form/:token", verifyToken, async (req, res) => {
  try {
    const { startupId } = req.user;

    // Step 1: Get UTS Startups field from EOI table
    const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
    const utsStartupsField = eoiRecord.get("UTS Startups");

    if (!utsStartupsField || utsStartupsField.length === 0) {
      return res.json({
        success: false,
        message: "Fill in Startup Information Form",
      });
    }

    // Step 2: Get primary contact email from linked UTS Startups record
    const linkedStartupRecord = await airtableBase(
      process.env.UTS_STARTUPS_TABLE_ID,
    ).find(utsStartupsField[0]);
    const primaryContactEmail = linkedStartupRecord.get(
      "Primary contact email",
    );

    if (!primaryContactEmail) {
      return res.json({
        success: false,
        message: "Primary contact email not found",
      });
    }

    // Step 3: Get team members form URL
    const teamMembersFormUrl = linkedStartupRecord.get(
      "04. Nominated Personnel Details",
    );

    // Augment with authoritative Startup prefill/hide parameters
    let outUrl = teamMembersFormUrl || null;
    if (outUrl) {
      const startupRecId = utsStartupsField[0];
      outUrl = augmentUrlWithParams(outUrl, [
        ["prefill_Startup", startupRecId],
        ["hide_Startup", "true"],
        ["prefill_Startup*", startupRecId],
        ["hide_Startup*", "true"],
      ]);
    }

    res.json({
      success: true,
      formUrl: outUrl,
    });
  } catch (error) {
    console.error("Get team members form error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch team members form URL.",
    });
  }
});

// Endpoint for submission confirmation
app.patch("/submission-confirmation/:token", verifyToken, async (req, res) => {
  try {
    const { startupId } = req.user;

    console.log("Submission confirmation request for startupId:", startupId);

    // Step 2.1: Fetch data from 'UTS Startups EOI' table from 'UTS Startups' field
    const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
    const utsStartupsField = eoiRecord.get("UTS Startups");

    console.log("UTS Startups field from EOI table:", utsStartupsField);

    if (!utsStartupsField || utsStartupsField.length === 0) {
      return res.json({
        success: false,
        message: "No linked startup record found in EOI table",
      });
    }

    // Step 2.2: Get the record ID from the response
    const linkedRecordId = utsStartupsField[0];
    console.log("Linked record ID:", linkedRecordId);

    // Step 2.3: PATCH request to UTS Startups table to update Submission Confirmation
    const updateData = {
      fields: {
        "Submission Confirmation": "true",
      },
    };

    console.log("Updating record with data:", updateData);

    await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).update(
      linkedRecordId,
      {
        "Submission Confirmation": true,
      },
    );

    console.log("Successfully updated Submission Confirmation to true");

    res.json({
      success: true,
      message: "Submission confirmed successfully",
      recordId: linkedRecordId,
    });
  } catch (error) {
    console.error("Submission confirmation error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to confirm submission: " + error.message,
    });
  }
});

// SKY health/status (internal/JWT)
function decodeJwtExpIso(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    if (payload && payload.exp)
      return new Date(payload.exp * 1000).toISOString();
  } catch (_) {}
  return null;
}

app.get("/sky-status", verifyInternalOrJWT, async (req, res) => {
  try {
    const access = (process.env.SKY_ACCESS_TOKEN || "").trim();
    const keysCsv = (process.env.SKY_SUBSCRIPTION_KEYS || "").trim();
    const keySingle = (
      process.env.SKY_SUBSCRIPTION_KEY ||
      process.env.SKY_SUBSCRIPTION_KEY_PRIMARY ||
      ""
    ).trim();
    const keyCount = Array.from(
      new Set(
        (keysCsv ? keysCsv.split(/[\s,]+/) : []).concat(
          keySingle ? [keySingle] : [],
        ),
      ),
    ).filter(Boolean).length;

    if (!access || keyCount === 0) {
      return res.json({
        success: true,
        data: { state: "missing_creds", keyCount, tokenPresent: !!access },
      });
    }

    const expIso = decodeJwtExpIso(access);
    let refreshed = false;

    const validator = require("./validation_generation/validation/blackbaudDiscountValidator");
    let r = await validator.searchConstituents("health", {
      strict: true,
      nonConstituents: false,
    });
    if (r && (r.status === 401 || r.status === 403)) {
      const rf = await runSkyRefresh();
      if (rf && rf.ok) {
        refreshed = true;
        try {
          const SKY_ENV_FILE = process.env.SKY_ENV_FILE;
          if (SKY_ENV_FILE && fs.existsSync(SKY_ENV_FILE)) {
            require("dotenv").config({ path: SKY_ENV_FILE, override: true });
          } else {
            require("dotenv").config({ override: true });
          }
        } catch (_) {}
        r = await validator.searchConstituents("health", {
          strict: true,
          nonConstituents: false,
        });
      }
    }

    if (r && r.status === 200) {
      return res.json({
        success: true,
        data: {
          state: "ok",
          httpStatus: r.status,
          keyCount,
          tokenExpiresAt: expIso,
          refreshed,
        },
      });
    }
    return res.json({
      success: true,
      data: {
        state: "unauthorized",
        httpStatus: r ? r.status : null,
        keyCount,
        tokenExpiresAt: expIso,
        refreshed,
      },
    });
  } catch (e) {
    console.error("sky-status error:", e);
    return res
      .status(500)
      .json({ success: false, message: "Failed to check SKY status" });
  }
});

// Manual SKY refresh (internal/JWT)
app.get(
  "/sky-refresh",
  skyRefreshLimiter,
  verifyInternalOrJWT,
  async (req, res) => {
    try {
      const force = String(req.query.force || "").toLowerCase() === "1";
      const beforeTtl = decodeJwtExpIso(process.env.SKY_ACCESS_TOKEN || "")
        ? (new Date(
            decodeJwtExpIso(process.env.SKY_ACCESS_TOKEN || ""),
          ).getTime() -
            Date.now()) /
          1000
        : null;
      const skew = 300;
      if (!force && beforeTtl != null && beforeTtl > skew) {
        return res.json({
          success: true,
          message: "Refresh not needed yet",
          data: {
            refreshed: false,
            ttlSec: Math.round(beforeTtl),
            tokenExpiresAt: decodeJwtExpIso(process.env.SKY_ACCESS_TOKEN || ""),
          },
        });
      }
      const rf = await runSkyRefresh();
      if (!(rf && rf.ok)) {
        return res
          .status(502)
          .json({
            success: false,
            message: "Refresh failed",
            data: { code: rf && rf.code, err: rf && rf.err },
          });
      }
      const expIso = decodeJwtExpIso(process.env.SKY_ACCESS_TOKEN || "");
      const ttlSec = expIso
        ? Math.max(
            0,
            Math.round((new Date(expIso).getTime() - Date.now()) / 1000),
          )
        : null;
      return res.json({
        success: true,
        message: "Refreshed",
        data: { refreshed: true, ttlSec, tokenExpiresAt: expIso },
      });
    } catch (e) {
      return res
        .status(500)
        .json({ success: false, message: "Refresh exception: " + e.message });
    }
  },
);

// Reconcile statuses: promote representative + startup when conditions met
app.post("/reconcile-status/:token", verifyToken, async (req, res) => {
  try {
    log("info", "reconcile.start", {}, req);
    // Always prefer resolving the linked Startups record from EOI (avoids stale token IDs)
    let startupRecordId = await resolveStartupRecordIdFromEOI(
      req.user?.startupId,
    );
    if (!startupRecordId) startupRecordId = getStartupRecordIdFromReqUser(req);

    if (!startupRecordId) {
      return res.status(400).json({
        success: false,
        message: "No linked UTS Startups record found for this token.",
      });
    }

    // Fetch the Startup record
    let startupRec = null;
    try {
      startupRec = await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).find(
        startupRecordId,
      );
    } catch (e) {
      return res.status(404).json({
        success: false,
        message: "Linked UTS Startups record not found.",
      });
    }

    const startupNamePrimary = startupRec.get(
      "Startup Name (or working title)",
    );
    const submissionConfirmation = asOne(
      startupRec.get("Submission Confirmation"),
    );
    const startupFormSubmitted =
      asOne(startupRec.get("New onboarding form submitted")) ||
      asOne(startupRec.get("Onboarding Submitted"));
    const currentStartupStatus = (
      startupRec.get("Startup status") || ""
    ).toString();
    log(
      "debug",
      "reconcile.gates",
      {
        startupRecordId,
        submissionConfirmation,
        startupFormSubmitted,
        currentStartupStatus,
      },
      req,
    );

    // Fetch Team Members linked by name (Airtable exposes linked names in the rollup field)
    let teamMemberRecords = [];
    try {
      if (startupRecordId) {
        teamMemberRecords = await listTeamMembersByStartupId(startupRecordId);
      }
    } catch (_) {}

    // Determine representative(s) using the dedicated field
    const lower = (v) => (v || "").toString().toLowerCase();
    const repRecords = teamMemberRecords.filter((r) =>
      asOne(r.get("Representative")),
    );

    let memberUpdates = [];
    for (const rec of repRecords) {
      const submitted = asOne(rec.get("New onboarding form submitted"));
      const statusVal = (rec.get("Team Member Status") || "").toString();
      if (submitted && lower(statusVal) !== "active") {
        // Do not write: status is computed in Airtable. Report what would change.
        memberUpdates.push({ id: rec.id, wouldSet: "Active" });
        log(
          "info",
          "reconcile.member.skip_write",
          { memberId: rec.id, wouldSet: "Active" },
          req,
        );
      }
    }

    // Promote startup status if appropriate
    let startupUpdated = false;
    let startupWouldSet = false;
    if (startupFormSubmitted && submissionConfirmation) {
      // If any representative exists and submitted, startup would be Active (computed in Airtable)
      const anyRepSubmitted = repRecords.some((r) =>
        asOne(r.get("New onboarding form submitted")),
      );
      if (anyRepSubmitted && lower(currentStartupStatus) !== "active") {
        startupWouldSet = true;
        log(
          "info",
          "reconcile.startup.skip_write",
          { startupRecordId, wouldSet: "Active" },
          req,
        );
      }
    }

    log(
      "info",
      "reconcile.done",
      { startupRecordId, startupUpdated, members: memberUpdates.length },
      req,
    );
    return res.json({
      success: true,
      message: "Reconciled (no writes to computed status fields)",
      data: { startupRecordId, startupUpdated, startupWouldSet, memberUpdates },
    });
  } catch (error) {
    log("error", "reconcile.exception", { message: error.message }, req);
    return res
      .status(500)
      .json({ success: false, message: "Failed to reconcile statuses." });
  }
});

// Check step progress endpoint
app.get("/check-progress/:token", verifyToken, async (req, res) => {
  try {
    const {
      startupName,
      startupId,
      startupRecordId: tokenStartupRecordId,
    } = req.user;
    let startupRecordId = tokenStartupRecordId || null;

    // Check UTS Startups table for form submission status
    let startupFormSubmitted = false;
    let representativeFormSubmitted = false;
    let step2Unlocked = false;

    // Determine current startup name from Startups record when possible (handles rename)
    let currentStartupName = startupName;
    try {
      if (!startupRecordId && startupId) {
        const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(
          startupId,
        );
        const utsStartupsField = eoiRecord.get("UTS Startups");
        if (utsStartupsField && utsStartupsField.length > 0)
          startupRecordId = utsStartupsField[0];
        step2Unlocked = utsStartupsField && utsStartupsField.length > 0;
      }
      if (startupRecordId) {
        const srec = await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).find(
          startupRecordId,
        );
        currentStartupName =
          srec.get("Startup Name (or working title)") || currentStartupName;
        startupFormSubmitted = asOne(srec.get("New onboarding form submitted"));
      } else {
        // Fallback: name-based lookup
        const startupRecords = await airtableBase(
          process.env.UTS_STARTUPS_TABLE_ID,
        )
          .select({
            filterByFormula:
              '{Startup Name (or working title)} = "' + startupName + '"',
          })
          .firstPage();
        if (startupRecords.length > 0) {
          const startupRecord = startupRecords[0];
          currentStartupName =
            startupRecord.get("Startup Name (or working title)") ||
            currentStartupName;
          startupFormSubmitted = asOne(
            startupRecord.get("New onboarding form submitted"),
          );
        }
      }
    } catch (error) {
      console.log("Error checking startup form submission:", error.message);
    }

    // If we haven't checked step2Unlocked yet via EOI, do it now
    if (step2Unlocked === false) {
      try {
        const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(
          startupId,
        );
        const utsStartupsField = eoiRecord.get("UTS Startups");
        step2Unlocked = utsStartupsField && utsStartupsField.length > 0;
      } catch (error) {
        console.log(
          "Error checking UTS Startups field in EOI table:",
          error.message,
        );
      }
    }

    // Check Team Members table for representative submission (Representative = 1)
    try {
      const teamMemberRecords = startupRecordId
        ? await listTeamMembersByStartupId(startupRecordId)
        : [];

      if (teamMemberRecords.length > 0) {
        // Check if any representative has submission status = 1
        representativeFormSubmitted = teamMemberRecords.some(
          (record) =>
            asOne(record.get("Representative")) &&
            asOne(record.get("New onboarding form submitted")),
        );
      }
    } catch (error) {
      console.log("Error checking team member form submission:", error.message);
    }

    res.json({
      success: true,
      progress: {
        step1: startupFormSubmitted,
        step2: representativeFormSubmitted,
        step2Unlocked: step2Unlocked,
        step3: false, // Step 3 is always available once step 2 is complete
      },
    });
  } catch (error) {
    console.error("Check progress error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to check progress." });
  }
});

// Complete onboarding endpoint
app.post("/complete-onboarding", verifyToken, async (req, res) => {
  try {
    const { startupId, startupName } = req.user;

    // Find or create the startup record in UTS Startups table
    try {
      const startupRecords = await airtableBase(
        process.env.UTS_STARTUPS_TABLE_ID,
      )
        .select({
          filterByFormula:
            '{Startup Name (or working title)} = "' + startupName + '"',
        })
        .firstPage();

      if (startupRecords.length > 0) {
        // Update existing startup record
        const startupRecord = startupRecords[0];
        await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).update(
          startupRecord.id,
          {
            "Onboarding Submitted": 1,
          },
        );
      } else {
        // This shouldn't normally happen if onboarding forms create the record
        // But as a fallback, we could create it here
        console.log(
          "Warning: Startup record not found in UTS Startups table during onboarding completion",
        );
      }

      res.json({
        success: true,
        message: "Onboarding completed successfully!",
      });
    } catch (error) {
      console.error("Error updating startup record:", error);
      res.status(500).json({
        success: false,
        message: "Failed to complete onboarding. Please try again.",
      });
    }
  } catch (error) {
    console.error("Complete onboarding error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to complete onboarding. Please try again.",
    });
  }
});

// ------------------------------
// PDF Generation (time-limited URLs)
// ------------------------------

const URL_TTL_SECONDS = Math.max(
  30,
  parseInt(process.env.URL_TTL_SECONDS || "3600", 10),
);
const P12_PATH = (process.env.P12_PATH || "").trim();
const P12_PASSPHRASE = process.env.P12_PASSPHRASE || "";

const PDF_TOKENS = new Map(); // token -> { filePath, expiresAt, filename }

function pdfBaseUrl(req) {
  const domain = (process.env.REPLIT_DEV_DOMAIN || "").trim();
  if (domain) return `https://${domain.replace(/\/$/, "")}`;
  const env = (process.env.NODE_ENV || "").toLowerCase();
  if (env !== "production" && process.env.DEV_PUBLIC_BASE_URL) {
    return String(process.env.DEV_PUBLIC_BASE_URL).replace(/\/$/, "");
  }
  const proto = (
    req.headers["x-forwarded-proto"] ||
    req.protocol ||
    "http"
  ).toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host).toString();
  return `${proto}://${host}`;
}

function suggestPdfFilename(base) {
  const name = (base || "agreement").toString().trim() || "agreement";
  const d = new Date().toISOString().slice(0, 10);
  return `${name} - UTS Incubator Agreement - ${d}.pdf`;
}

async function buildPdfPayload({ startupRecordId, memberRecordId }) {
  // Minimal payload: rely on generator fallbacks if some fields are missing
  let startupRec = null;
  let startupName = "";
  let legalName = "";
  let debtorEmail = "";
  let insuranceStatus = false;

  try {
    if (startupRecordId) {
      const rec = await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).find(
        startupRecordId,
      );
      startupRec = rec;
      startupName = rec.get("Startup Name (or working title)") || "";
      legalName = rec.get("Registered Business Name") || startupName || "";
      debtorEmail = rec.get("Primary contact email") || "";
      // Public liability insurance: single select Yes/No
      insuranceStatus = asOne(rec.get("Public liability insurance"));
    }
  } catch (e) {
    // ignore; leave payload to fallbacks
  }

  // Helpers for membership classification
  function normaliseType(raw) {
    const s = String(raw || "")
      .trim()
      .toLowerCase();
    if (s.includes("full")) return "Full Membership";
    if (s.includes("casual")) return "Casual Membership";
    if (s.includes("day")) return "Day Membership";
    return "Casual Membership";
  }
  function isWithin12m(discount) {
    const s = String(discount || "").toLowerCase();
    if (/within the last 12 months|within.*12 months|<\s*12/.test(s))
      return true;
    // Treat current staff/students as equivalent to <12m for counting/pricing when explicit columns are absent
    if (s.includes("current") && (s.includes("student") || s.includes("staff")))
      return true;
    return false;
  }
  function isOver12m(discount) {
    const s = String(discount || "").toLowerCase();
    return /more than 12 months|over.*12 months|>\s*12/.test(s);
  }
  function isUTSDiscount(discount) {
    const s = String(discount || "").toLowerCase();
    return /uts|alumni|staff|student/.test(s);
  }

  // Pricing helpers
  function discountColumnFor(category) {
    const s = String(category || "").toLowerCase();
    if (s.includes("current") && s.includes("student"))
      return "Current UTS Student";
    if (s.includes("current") && s.includes("staff")) return "Current Staff";
    if (
      (s.includes("alumni") && (s.includes("within") || s.includes("< 12"))) ||
      /<\s*12/.test(s)
    )
      return "UTS Alumni < 12m";
    if (
      (s.includes("alumni") &&
        (s.includes("more than") ||
          s.includes("over") ||
          s.includes("> 12"))) ||
      />\s*12/.test(s)
    )
      return "UTS Alumni > 12m";
    if (
      s.includes("former") &&
      s.includes("staff") &&
      (s.includes("within") || s.includes("< 12"))
    )
      return "Former Staff < 12m";
    if (
      s.includes("former") &&
      s.includes("staff") &&
      (s.includes("more than") || s.includes("over") || s.includes("> 12"))
    )
      return "Former Staff > 12m";
    return null;
  }

  // Determine effective category: use Manual Discount Category when Manual Discount Check is set
  function effectiveDiscountCategory(rec) {
    try {
      const manualCheckField =
        process.env.AIRTABLE_MEMBERS_MANUAL_OVERRIDE_FIELD ||
        "Manual Discount Check";
      const manualCatField =
        process.env.AIRTABLE_MEMBERS_MANUAL_DISCOUNT_CATEGORY_FIELD ||
        "Manual Discount Category";
      const manualCheck = rec.get(manualCheckField) || "";
      if (String(manualCheck).trim()) {
        const manualCat = rec.get(manualCatField) || "";
        if (String(manualCat).trim()) return manualCat;
      }
    } catch (_) {}
    try {
      const expectedField =
        process.env.AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD ||
        "Discount Category";
      return rec.get(expectedField) || "";
    } catch (_) {}
    return "";
  }

  // Check if discount is validated (either via API or manual override)
  function isDiscountValidated(rec) {
    try {
      const manualCheckField =
        process.env.AIRTABLE_MEMBERS_MANUAL_OVERRIDE_FIELD ||
        "Manual Discount Check";
      const manualCatField =
        process.env.AIRTABLE_MEMBERS_MANUAL_DISCOUNT_CATEGORY_FIELD ||
        "Manual Discount Category";
      const manualCheck = rec.get(manualCheckField) || "";
      const manualCat = rec.get(manualCatField) || "";
      
      // If manual check is 'Valid' and manual category is not empty, consider validated
      if (String(manualCheck).trim().toLowerCase() === 'valid' && String(manualCat).trim()) {
        return true;
      }
    } catch (_) {}
    
    // Otherwise check API validation
    try {
      return String(rec.get("Discount Validated") || "")
        .trim()
        .toLowerCase() === "valid";
    } catch (_) {}
    return false;
  }

  async function loadPricingMatrixViaSDK() {
    const out = {};
    const tableId = process.env.AIRTABLE_PRICING_TABLEID;
    if (!tableId) return out;
    try {
      const records = await base(tableId).select({ pageSize: 100 }).all();
      for (const r of records) {
        const f = r.fields || {};
        const typeRaw = f["Membership Type"];
        if (!typeRaw) continue;
        const type = normaliseType(typeRaw);
        const baseRate =
          Number(String(f["Base Rate"] || "").replace(/[^0-9.\-]/g, "")) || 0;
        out[type] = {
          base: baseRate,
          discounts: {
            "Current UTS Student":
              Number(
                String(f["Current UTS Student"] || "").replace(
                  /[^0-9.\-]/g,
                  "",
                ),
              ) || 0,
            "UTS Alumni < 12m":
              Number(
                String(f["UTS Alumni < 12m"] || "").replace(/[^0-9.\-]/g, ""),
              ) || 0,
            "UTS Alumni > 12m":
              Number(
                String(f["UTS Alumni > 12m"] || "").replace(/[^0-9.\-]/g, ""),
              ) || 0,
            "Current Staff":
              Number(
                String(f["Current Staff"] || "").replace(/[^0-9.\-]/g, ""),
              ) || 0,
            "Former Staff < 12m":
              Number(
                String(f["Former Staff < 12m"] || "").replace(/[^0-9.\-]/g, ""),
              ) || 0,
            "Former Staff > 12m":
              Number(
                String(f["Former Staff > 12m"] || "").replace(/[^0-9.\-]/g, ""),
              ) || 0,
          },
        };
      }
    } catch (e) {
      log("warn", "pricing.load.error", { message: e.message });
    }
    return out;
  }

  // Fetch team members by startup name (consistent with existing queries)
  let team = [];
  let repName = "";
  let repEmail = "";
  let memberships = {
    mem_fulltime_count: "0",
    mem_fulltime_uts_discount_count: "0",
    mem_casual_count: "0",
    mem_casual_uts_within_12m_count: "0",
    mem_casual_uts_over_12m_count: "0",
    mem_day_count: "0",
  };
  let calculatedMonthlyFee = "";
  if (startupName) {
    try {
      const teamMemberRecords =
        await listTeamMembersByStartupId(startupRecordId);
      function fullName(rec) {
        const nameField =
          rec.get("Name") || rec.get("Full name") || rec.get("Full Name") || "";
        if (nameField) return String(nameField).trim();
        const first = rec.get("First Name") || "";
        const last = rec.get("Last Name") || "";
        const combo = (String(first).trim() + " " + String(last).trim()).trim();
        return combo || "";
      }
      // Representative (debtor_name)
      const repRec = teamMemberRecords.find((r) =>
        asOne(r.get("Representative")),
      );
      if (repRec) {
        repName = fullName(repRec);
        repEmail = repRec.get("Personal email*") || "";
      }
      // Build team list without IDs
      team = teamMemberRecords
        .map((r) => {
          const full = fullName(r);
          if (!full) return null;
          const parts = full.split(/\s+/);
          const first_name =
            parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] || "";
          const last_name = parts.length > 1 ? parts[parts.length - 1] : "";
          return { first_name, last_name };
        })
        .filter(Boolean);

      // Membership counts (submitted members only, mutually exclusive buckets)
      const submitted = teamMemberRecords.filter((r) =>
        asOne(r.get("New onboarding form submitted")),
      );
      let fullNoDisc = 0,
        fullDisc = 0,
        casualNoDisc = 0,
        casualWithin = 0,
        casualOver = 0,
        dayCount = 0;
      for (const r of submitted) {
        const type = normaliseType(r.get("Membership Type"));
        const discountCat = effectiveDiscountCategory(r);
        const validated = isDiscountValidated(r);

        if (type === "Full Membership") {
          if (validated && isUTSDiscount(discountCat)) fullDisc++;
          else fullNoDisc++;
        } else if (type === "Casual Membership") {
          if (validated && isWithin12m(discountCat)) casualWithin++;
          else if (validated && isOver12m(discountCat)) casualOver++;
          else casualNoDisc++;
        } else if (type === "Day Membership") {
          dayCount++;
        }
      }
      memberships = {
        mem_fulltime_count: String(fullNoDisc),
        mem_fulltime_uts_discount_count: String(fullDisc),
        mem_casual_count: String(casualNoDisc),
        mem_casual_uts_within_12m_count: String(casualWithin),
        mem_casual_uts_over_12m_count: String(casualOver),
        mem_day_count: String(dayCount),
      };

      // Pricing (optional; uses pricing table if configured)
      try {
        const matrix = await loadPricingMatrixViaSDK();
        let sum = 0;
        for (const r of submitted) {
          const type = normaliseType(r.get("Membership Type"));
          if (type === "Day Membership") continue;
          const row = matrix[type] || { base: 0, discounts: {} };
          let fee = Number(row.base) || 0;
          const discountCat = effectiveDiscountCategory(r);
          const validated = isDiscountValidated(r);
          let col = discountColumnFor(discountCat);
          if (validated && row.discounts) {
            let rate =
              col && row.discounts[col] != null ? row.discounts[col] : null;
            // Fallback: if table lacks explicit 'Current' columns, use '< 12m' rate for current staff/students
            if (
              rate == null &&
              (col === "Current UTS Student" || col === "Current Staff")
            ) {
              if (row.discounts["UTS Alumni < 12m"] != null) {
                col = "UTS Alumni < 12m";
                rate = row.discounts[col];
              }
            }
            if (rate != null) {
              const val = Number(rate);
              if (!Number.isNaN(val)) fee = val;
            }
          }
          sum += fee;
        }
        if (sum > 0)
          calculatedMonthlyFee =
            "AUD " +
            new Intl.NumberFormat("en-AU", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }).format(sum) +
            " per month plus GST";
        else {
          const hasFullOrCasual = fullCount + casualCount > 0;
          calculatedMonthlyFee = hasFullOrCasual
            ? "AUD 0.00 per month (waived)"
            : "No monthly fee (Day Memberships charged per-day)";
        }
      } catch (e) {
        log("warn", "pricing.compute.error", { message: e.message });
      }
    } catch (_) {}
  }

  const payload = {
    legal_name: legalName || startupName || "Agreement",
    abn: (startupRec && (startupRec.get("ABN") || "")) || "",
    address: "3 Broadway, Ultimo, NSW, 2007",
    debtor_email: repEmail || debtorEmail || "",
    debtor_name: repName || "",
    billing_start_date: new Date().toISOString().slice(0, 10),
    calculated_monthly_fee:
      calculatedMonthlyFee || "AUD 0.00 per month (placeholder)",
    memberships,
    team,
    insurance_status: insuranceStatus,
  };
  return payload;
}

async function generatePdfBuffer(payload) {
  const tmpDir = path.join(os.tmpdir(), "pdf-cache");
  await fs.ensureDir(tmpDir);
  const tmpJson = path.join(
    tmpDir,
    `payload_${Date.now()}_${Math.random().toString(16).slice(2)}.json`,
  );
  const tmpPdf = path.join(
    tmpDir,
    `out_${Date.now()}_${Math.random().toString(16).slice(2)}.pdf`,
  );
  await fs.writeJSON(tmpJson, payload, { spaces: 2 });

  await new Promise((resolve, reject) => {
    const generatorPath = path.join(
      __dirname,
      "validation_generation",
      "generate_with_sigfields.js",
    );
    const args = [generatorPath, tmpJson, tmpPdf];
    if (P12_PATH) {
      args.push(P12_PATH);
      args.push(P12_PASSPHRASE || "");
    }
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Generator exited with code ${code}`)),
    );
  });

  const bytes = await fs.readFile(tmpPdf);
  await fs.remove(tmpJson).catch(() => {});
  await fs.remove(tmpPdf).catch(() => {});
  return bytes;
}

// Issue a temporary URL for the generated PDF (no Airtable side-effect)
app.post("/pdf-url", verifyInternalOrJWT, async (req, res) => {
  try {
    const t0 = Date.now();
    const { startupRecordId, memberRecordId, filename, ttlSeconds } =
      req.body || {};
    if (!startupRecordId && !memberRecordId) {
      return res.status(400).json({
        success: false,
        message: "startupRecordId or memberRecordId is required",
      });
    }

    const payload = await buildPdfPayload({ startupRecordId, memberRecordId });
    const suggested =
      filename || suggestPdfFilename(payload?.legal_name || "agreement");
    const pdfBuffer = await generatePdfBuffer(payload);

    const tmpDir = path.join(os.tmpdir(), "pdf-cache");
    await fs.ensureDir(tmpDir);
    const token = crypto.randomBytes(12).toString("hex");
    const filePath = path.join(tmpDir, `${token}.pdf`);
    await fs.writeFile(filePath, pdfBuffer);

    const ttl = Math.max(30, parseInt(ttlSeconds || URL_TTL_SECONDS, 10));
    const expiresAt = new Date(Date.now() + ttl * 1000);
    PDF_TOKENS.set(token, { filePath, expiresAt, filename: suggested });

    return res.json({
      success: true,
      pdf: {
        url: `${pdfBaseUrl(req)}/download/${token}`,
        filename: suggested,
        expiresAt: expiresAt.toISOString(),
      },
    });
  } catch (e) {
    console.error("pdf-url error:", e);
    return res
      .status(500)
      .json({ success: false, message: "Failed to generate PDF" });
  }
});

// Inline PDF (streams bytes immediately)
app.post("/pdf", verifyInternalOrJWT, async (req, res) => {
  try {
    const { startupRecordId, memberRecordId, filename } = req.body || {};
    if (!startupRecordId && !memberRecordId) {
      return res.status(400).json({
        success: false,
        message: "startupRecordId or memberRecordId is required",
      });
    }
    const payload = await buildPdfPayload({ startupRecordId, memberRecordId });
    const suggested =
      filename || suggestPdfFilename(payload?.legal_name || "agreement");
    const pdfBuffer = await generatePdfBuffer(payload);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(suggested)}`,
    );
    return res.status(200).end(pdfBuffer);
  } catch (e) {
    console.error("pdf inline error:", e);
    return res
      .status(500)
      .json({ success: false, message: "Failed to generate PDF" });
  }
});

// Open download with time-limited token (no auth)
app.get("/download/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    const entry = PDF_TOKENS.get(token);
    if (!entry) return res.status(410).send("Expired");
    if (Date.now() > entry.expiresAt.getTime()) {
      PDF_TOKENS.delete(token);
      await fs.remove(entry.filePath).catch(() => {});
      return res.status(410).send("Expired");
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
    );
    const stream = fs.createReadStream(entry.filePath);
    stream.on("close", async () => {
      // one-time download; cleanup
      PDF_TOKENS.delete(token);
      await fs.remove(entry.filePath).catch(() => {});
    });
    stream.pipe(res);
  } catch (e) {
    console.error("download error:", e);
    return res.status(500).send("Error");
  }
});

// Periodic cleanup of expired tokens/files
setInterval(async () => {
  const now = Date.now();
  for (const [t, entry] of PDF_TOKENS) {
    if (now > entry.expiresAt.getTime()) {
      PDF_TOKENS.delete(t);
      await fs.remove(entry.filePath).catch(() => {});
    }
  }
}, 60 * 1000);

// ------------------------------
// Orchestrated Validation + PDF (per-startup, concurrency-safe)
// ------------------------------

const JOBS = new Map(); // startupRecordId -> { state: 'idle'|'running'|'done'|'error'|'blocked', startedAt, finishedAt?, progress, result? }

function getStartupRecordIdFromReqUser(req) {
  const { startupRecordId: tokenStartupRecordId, startupId } = req.user || {};
  if (tokenStartupRecordId) return tokenStartupRecordId;
  return null;
}

async function resolveStartupRecordIdFromEOI(startupId) {
  if (!startupId) return null;
  try {
    const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
    const utsStartupsField = eoiRecord.get("UTS Startups");
    if (utsStartupsField && utsStartupsField.length > 0)
      return utsStartupsField[0];
  } catch (_) {}
  return null;
}

// Fetch Team Members strictly by linked Startup record ID (avoid name-based cross matches)
async function listTeamMembersByStartupId(startupRecordId) {
  if (!startupRecordId) return [];
  const all = await base(process.env.TEAM_MEMBERS_TABLE_ID)
    .select({ pageSize: 100 })
    .all();
  const isLinked = (rec) => {
    // Prioritise common linked field names; values from linked fields are arrays of record IDs
    const candidates = [
      rec.get("Startup*"),
      rec.get("Startup"),
      rec.get("UTS Startups"),
    ];
    for (const v of candidates) {
      if (
        Array.isArray(v) &&
        v.some((x) => String(x) === String(startupRecordId))
      )
        return true;
    }
    return false;
  };
  return all.filter(isLinked);
}

async function fetchStartupAndMembers(startupRecordId) {
  const startupRec = await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).find(
    startupRecordId,
  );
  const startupName = startupRec.get("Startup Name (or working title)");
  const members = await listTeamMembersByStartupId(startupRecordId);
  return { startupRec, startupName, members };
}

function getField(rec, name) {
  if (!rec || !rec.get) return "";
  const v = rec.get(name);
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v))
    return v
      .map((x) => (x && x.name ? x.name : typeof x === "string" ? x : ""))
      .filter(Boolean)
      .join(", ");
  if (v && v.name) return v.name;
  return String(v);
}

// ------------------------------
// Public status mapping + job sanitizer
// ------------------------------
function mapReason(internal) {
  try {
    const s = String(
      (internal && internal.status) || internal || "",
    ).toLowerCase();
    if (s === "valid" || internal === "validated")
      return { code: "validated", message: "Validated" };
    if (s === "ambiguous")
      return { code: "ambiguous", message: "Multiple possible matches" };
    if (s === "unauthorized")
      return { code: "unauthorized", message: "Authorization is required" };
    if (s === "not_found")
      return { code: "not_found", message: "No matching record found" };
    if (s === "invalid" || s === "mismatch")
      return { code: "mismatch", message: "Does not match records" };
    if (s === "error") return { code: "error", message: "Validation error" };
    if (s === "skipped" || s === "no_request")
      return { code: "no_request", message: "No discount requested" };
    if (s === "manual" || s === "manual_override")
      return { code: "manual", message: "Manual check override" };
  } catch (_) {}
  return { code: null, message: "" };
}

function sanitizeJob(job) {
  if (!job || typeof job !== "object")
    return { state: "idle", progress: { validated: 0, total: 0 }, members: [] };
  const progress =
    job.progress && typeof job.progress === "object"
      ? {
          validated: Number(job.progress.validated || 0),
          total: Number(job.progress.total || 0),
        }
      : { validated: 0, total: 0 };

  const members = Array.isArray(job.members)
    ? job.members.map((m) => {
        const { code, message } = mapReason(
          m.reason_code || m.reason || m.status,
        );
        return {
          id: m.id,
          name: m.name,
          type: m.type,
          expected_bucket: m.expected_bucket,
          status: (m.status || "queued").toLowerCase(),
          reason_code: code,
          reason_message: message,
        };
      })
    : [];

  const result =
    job.result && job.result.pdf
      ? {
          pdf: {
            url: job.result.pdf.url,
            filename: job.result.pdf.filename,
            expiresAt: job.result.pdf.expiresAt,
          },
        }
      : undefined;

  return { state: job.state || "idle", progress, members, result };
}

async function runMemberValidationsSequential(
  members,
  { updateAirtable = true, onUpdate = null } = {},
) {
  const validator = require("./validation_generation/validation/blackbaudDiscountValidator");
  const devFake =
    DEV_MODE &&
    (String(process.env.DEV_FAKE_VALIDATION || "").toLowerCase() === "1" ||
      !(
        process.env.SKY_ACCESS_TOKEN &&
        (process.env.SKY_SUBSCRIPTION_KEYS ||
          process.env.SKY_SUBSCRIPTION_KEY ||
          process.env.SKY_SUBSCRIPTION_KEY_PRIMARY)
      ));
  const results = [];
  for (let i = 0; i < members.length; i++) {
    const r = members[i];
    // Mark as pending for UI
    if (typeof onUpdate === "function") {
      try {
        onUpdate(r.id, { status: "pending" });
      } catch (_) {}
    }
    // Build inputs mirroring /discount-check
    const search_id = (
      getField(r, process.env.AIRTABLE_MEMBERS_INTERNAL_ID_FIELD || "UTS ID") ||
      ""
    )
      .toString()
      .trim();
    // Expected discount category with manual override support
    let expected =
      getField(
        r,
        process.env.AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD ||
          "Discount Category",
      ) || "";
    const manual =
      getField(
        r,
        process.env.AIRTABLE_MEMBERS_MANUAL_OVERRIDE_FIELD ||
          "Manual Discount Check",
      ) || "";
    if (String(manual).trim()) {
      const manualCat =
        getField(
          r,
          process.env.AIRTABLE_MEMBERS_MANUAL_DISCOUNT_CATEGORY_FIELD ||
            "Manual Discount Category",
        ) || "";
      if (String(manualCat).trim()) expected = manualCat;
    }
    const email =
      getField(
        r,
        process.env.AIRTABLE_MEMBERS_PRIMARY_EMAIL_FIELD || "UTS Email",
      ) || "";
    const name =
      getField(r, process.env.AIRTABLE_MEMBERS_NAME_FIELD || "Name") ||
      getField(r, "Team member ID") ||
      "";
    const dob =
      getField(r, process.env.AIRTABLE_MEMBERS_DOB_FIELD || "Date of birth*") ||
      getField(r, "Date of Birth") ||
      getField(r, "DOB") ||
      "";

    // Manual override present: bypass validation and keep record as-is
    if (String(manual).trim()) {
      if (typeof onUpdate === "function") {
        try {
          onUpdate(r.id, {
            status: "skipped",
            reason_code: "manual",
            reason_message: "Manual check override",
          });
        } catch (_) {}
      }
      results.push({
        memberId: r.id,
        skipped: true,
        reason: "manual_override",
      });
      continue;
    }

    // Skip when no discount requested
    if (!hasDiscountRequest(expected)) {
      if (typeof onUpdate === "function") {
        try {
          onUpdate(r.id, {
            status: "skipped",
            reason_code: "no_request",
            reason_message: "No discount requested",
          });
        } catch (_) {}
      }
      results.push({
        memberId: r.id,
        skipped: true,
        reason: "no_discount_requested",
      });
      continue;
    }

    if (!search_id) {
      log("warn", "validation.member.skip", {
        memberId: r.id,
        reason: "missing search_id",
      });
      results.push({
        memberId: r.id,
        skipped: true,
        reason: "missing search_id",
      });
      continue;
    }

    let result;
    if (devFake) {
      const bucket = expected || "Current UTS Staff";
      result = {
        valid: true,
        status: "valid",
        expected_bucket: expected || null,
        derived_buckets: [bucket],
        primary_bucket: bucket,
        bb_record_id: "DEV-FAKE",
        candidate: { id: "DEV", name, email, lookup_id: search_id },
        codes: [],
        qualifies_other: false,
        alumni_commencement: null,
        alumni_expires_at: null,
      };
    } else {
      log("debug", "validation.member.start", {
        memberId: r.id,
        expected,
        hasEmail: !!email,
        hasDOB: !!dob,
      });
      result = await validator.validateDiscount(
        { search_id, expected_bucket: expected, email, name, dob },
        { debug: false },
      );
      // Attempt token refresh once on 401
      if (
        (result &&
          result.raw &&
          (result.raw.statusCode === 401 || result.raw.status === 401)) ||
        /401/.test(String(result?.reason || ""))
      ) {
        const rf = await runSkyRefresh();
        if (rf && rf.ok) {
          try {
            const SKY_ENV_FILE = process.env.SKY_ENV_FILE;
            if (SKY_ENV_FILE && fs.existsSync(SKY_ENV_FILE)) {
              require("dotenv").config({ path: SKY_ENV_FILE, override: true });
            } else {
              require("dotenv").config({ override: true });
            }
          } catch (_) {}
          result = await validator.validateDiscount(
            { search_id, expected_bucket: expected, email, name, dob },
            { debug: false },
          );
        }
      }
    }

    let airtableUpdate = null;
    if (updateAirtable) {
      try {
        airtableUpdate = await updateMemberValidation(r.id, result, expected);
      } catch (e) {
        airtableUpdate = { error: e.message };
      }
    }

    // Push sanitized public status to UI
    if (typeof onUpdate === "function") {
      try {
        const pub = mapReason(result.status || result.reason);
        onUpdate(r.id, {
          status:
            (result.status || "").toLowerCase() ||
            (result.valid ? "valid" : "invalid"),
          reason_code: pub.code,
          reason_message: pub.message,
        });
      } catch (_) {}
    }
    results.push({ memberId: r.id, result, airtableUpdate });
    log("info", "validation.member.result", {
      memberId: r.id,
      status: result.status,
      valid: result.valid,
      primary_bucket: result.primary_bucket,
    });
    // small pacing delay to be gentle on SKY
    await new Promise((res) => setTimeout(res, 250));
  }
  return results;
}

app.post(
  "/validate-and-generate/:token",
  orchestratorLimiter,
  verifyToken,
  async (req, res) => {
    try {
      // Resolve startup record id (prefer EOI link over token to avoid stale IDs)
      let startupRecordId = await resolveStartupRecordIdFromEOI(
        req.user?.startupId,
      );
      if (!startupRecordId)
        startupRecordId = getStartupRecordIdFromReqUser(req);
      if (!startupRecordId)
        return res.status(400).json({
          success: false,
          message: "No linked UTS Startups record found for this token.",
        });

      const existing = JOBS.get(startupRecordId);
      if (existing && existing.state === "running") {
        log("info", "orchestrator.already_running", { startupRecordId }, req);
        return res.status(202).json({
          success: true,
          message: "Validation/generation already in progress",
          job: {
            state: existing.state,
            startedAt: existing.startedAt,
            progress: existing.progress,
          },
        });
      }

      // Create new job entry
      const job = {
        state: "running",
        startedAt: new Date().toISOString(),
        progress: { validated: 0, total: 0 },
        result: null,
      };
      JOBS.set(startupRecordId, job);

      (async () => {
        try {
          // Fetch startup + members
          const { startupRec, startupName, members } =
            await fetchStartupAndMembers(startupRecordId);
          log(
            "info",
            "orchestrator.start",
            { startupRecordId, startupName, members: members.length },
            req,
          );
          job.progress.total = members.length;

          const startupFormSubmitted =
            asOne(startupRec.get("New onboarding form submitted")) ||
            asOne(startupRec.get("Onboarding Submitted"));
          // Seed member checklist for UI
          function fullName(r) {
            const n = (
              r.get("Name") ||
              r.get("Full name") ||
              r.get("Full Name") ||
              ""
            )
              .toString()
              .trim();
            if (n) return n;
            const fn = r.get("First Name") || "";
            const ln = r.get("Last Name") || "";
            return (String(fn).trim() + " " + String(ln).trim()).trim();
          }
          job.members = (members || []).map((r) => ({
            id: r.id,
            name: fullName(r) || r.id,
            type: r.get("Membership Type") || "",
            expected_bucket: (function () {
              try {
                const manualCheckField =
                  process.env.AIRTABLE_MEMBERS_MANUAL_OVERRIDE_FIELD ||
                  "Manual Discount Check";
                const manualCatField =
                  process.env.AIRTABLE_MEMBERS_MANUAL_DISCOUNT_CATEGORY_FIELD ||
                  "Manual Discount Category";
                const manualCheck = r.get(manualCheckField) || "";
                if (String(manualCheck).trim()) {
                  const manualCat = r.get(manualCatField) || "";
                  if (String(manualCat).trim()) return manualCat;
                }
              } catch (_) {}
              try {
                return (
                  r.get(
                    process.env.AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD ||
                      "Discount Category",
                  ) || ""
                );
              } catch (_) {}
              return "";
            })(),
            status: "queued",
            primary_bucket: null,
            reason: "",
          }));
          const submissionConfirmation = asOne(
            startupRec.get("Submission Confirmation"),
          );
          const anyRepSubmitted = members.some(
            (m) =>
              asOne(m.get("Representative")) &&
              asOne(m.get("New onboarding form submitted")),
          );
          log(
            "debug",
            "orchestrator.gates",
            { startupFormSubmitted, submissionConfirmation, anyRepSubmitted },
            req,
          );
          if (
            !(startupFormSubmitted && submissionConfirmation && anyRepSubmitted)
          ) {
            job.state = "blocked";
            job.result = {
              reason: "eligibility",
              details: {
                startupFormSubmitted,
                submissionConfirmation,
                anyRepSubmitted,
              },
            };
            job.finishedAt = new Date().toISOString();
            log("warn", "orchestrator.blocked", job.result.details, req);
            return;
          }

          // Run validations with live updates
          const results = await runMemberValidationsSequential(members, {
            updateAirtable: true,
            onUpdate: (memberId, partial) => {
              const m = (job.members || []).find((x) => x.id === memberId);
              if (!m) return;
              if (partial.status) m.status = partial.status;
              if (partial.reason_code) m.reason_code = partial.reason_code;
              if (partial.reason_message)
                m.reason_message = partial.reason_message;
              if (
                ["valid", "invalid", "ambiguous", "error", "skipped"].includes(
                  String(partial.status || "").toLowerCase(),
                )
              ) {
                job.progress.validated = Math.min(
                  (job.progress.validated || 0) + 1,
                  job.progress.total || 0,
                );
              }
            },
          });
          log(
            "info",
            "orchestrator.validations.done",
            { count: results.length },
            req,
          );

          // Build minimal payload and generate PDF
          const payload = await buildPdfPayload({ startupRecordId });
          const filename = suggestPdfFilename(
            payload?.legal_name || startupName || "agreement",
          );
          log("info", "orchestrator.pdf.start", { filename }, req);
          const pdfBuffer = await generatePdfBuffer(payload);

          // Cache and issue a one-time URL for Airtable attach (user will get a stable redirect URL)
          const tmpDir = path.join(os.tmpdir(), "pdf-cache");
          await fs.ensureDir(tmpDir);
          const tokenAirtable = crypto.randomBytes(12).toString("hex");
          const filePathA = path.join(tmpDir, `${tokenAirtable}.pdf`);
          await fs.writeFile(filePathA, pdfBuffer);
          const expiresAt = new Date(Date.now() + URL_TTL_SECONDS * 1000);
          PDF_TOKENS.set(tokenAirtable, {
            filePath: filePathA,
            expiresAt,
            filename,
          });

          // Attach to Airtable Startups 'Agreement' field (append)
          try {
            const existing = Array.isArray(startupRec.get("Agreement"))
              ? startupRec.get("Agreement")
              : [];
            const keep = existing
              .map((att) => (att && att.id ? { id: att.id } : null))
              .filter(Boolean);
            const attachment = {
              url: `${pdfBaseUrl(req)}/download/${tokenAirtable}`,
              filename,
            };
            await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).update(
              startupRecordId,
              { Agreement: [...keep, attachment] },
            );
            // Stamp the created date (date-only)
            try {
              await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).update(
                startupRecordId,
                { "Agreement Created Date": ymd() },
              );
            } catch (_) {}
            log(
              "info",
              "orchestrator.attach.ok",
              { startupRecordId, countBefore: keep.length, filename },
              req,
            );
          } catch (e) {
            log(
              "warn",
              "orchestrator.attach.error",
              { message: e.message },
              req,
            );
          }

          // In dev, also save a local copy for quick manual inspection
          if (DEV_MODE) {
            try {
              const outdir =
                process.env.PDF_OUTDIR ||
                path.join(process.cwd(), "out", "pdfs");
              await fs.ensureDir(outdir);
              await fs.writeFile(path.join(outdir, filename), pdfBuffer);
            } catch (e) {
              /* ignore */
            }
          }

          job.state = "done";
          const stableUrl = `${pdfBaseUrl(req)}/agreement/latest/${req.params.token}`;
          job.result = {
            pdf: { url: stableUrl, filename },
            validations: results,
          };
          job.finishedAt = new Date().toISOString();
          log(
            "info",
            "orchestrator.done",
            { filename, expiresAt: expiresAt.toISOString() },
            req,
          );
        } catch (e) {
          log("error", "orchestrator.exception", { message: e.message }, req);
          job.state = "error";
          job.result = { message: e.message };
          job.finishedAt = new Date().toISOString();
        }
      })();

      return res.status(202).json({
        success: true,
        message: "Validation and generation started",
        job: {
          state: job.state,
          startedAt: job.startedAt,
          progress: job.progress,
        },
      });
    } catch (e) {
      console.error("validate-and-generate error:", e);
      return res.status(500).json({
        success: false,
        message: "Failed to start validation/generation",
      });
    }
  },
);

app.get("/job-status/:token", verifyToken, async (req, res) => {
  try {
    let startupRecordId = getStartupRecordIdFromReqUser(req);
    if (!startupRecordId)
      startupRecordId = await resolveStartupRecordIdFromEOI(
        req.user?.startupId,
      );
    if (!startupRecordId)
      return res.status(400).json({
        success: false,
        message: "No linked UTS Startups record found for this token.",
      });
    const jobRaw = JOBS.get(startupRecordId) || {
      state: "idle",
      progress: { validated: 0, total: 0 },
      members: [],
    };
    const job = sanitizeJob(jobRaw);
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, max-age=0",
    );
    res.setHeader("Pragma", "no-cache");
    return res.json({ success: true, job });
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: "Failed to read job status" });
  }
});

// Stable redirect to latest Agreement attachment (user-facing download)
app.get("/agreement/latest/:token", verifyToken, async (req, res) => {
  try {
    let startupRecordId = getStartupRecordIdFromReqUser(req);
    if (!startupRecordId)
      startupRecordId = await resolveStartupRecordIdFromEOI(
        req.user?.startupId,
      );
    if (!startupRecordId)
      return res
        .status(400)
        .send("No linked UTS Startups record found for this token.");

    const tableId = process.env.UTS_STARTUPS_TABLE_ID;
    const agreementField =
      process.env.AIRTABLE_UNSIGNED_AGREEMENT_FIELD || "Agreement";

    let rec;
    try {
      rec = await airtableBase(tableId).find(startupRecordId);
    } catch (e) {
      return res.status(404).send("Startup record not found.");
    }

    const arr = Array.isArray(rec.get(agreementField))
      ? rec.get(agreementField)
      : [];
    if (!arr || arr.length === 0)
      return res.status(404).send("No agreement found.");
    // Latest is the one appended last
    const latest = arr[arr.length - 1];
    if (!latest || !latest.url)
      return res.status(404).send("Agreement URL missing.");

    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, latest.url);
  } catch (_) {
    return res.status(500).send("Failed to resolve latest agreement.");
  }
});
// ------------------------------
// Airtable Attachments Health Check
// Confirms whether attachment fields are writable by attempting a no-op update
// ------------------------------
app.get("/attachments-health/:token", verifyToken, async (req, res) => {
  try {
    // Resolve startup record id
    let startupRecordId = getStartupRecordIdFromReqUser(req);
    if (!startupRecordId)
      startupRecordId = await resolveStartupRecordIdFromEOI(
        req.user?.startupId,
      );
    if (!startupRecordId)
      return res.status(400).json({
        success: false,
        message: "No linked UTS Startups record found for this token.",
      });

    const tableId = process.env.UTS_STARTUPS_TABLE_ID;
    const signedField =
      process.env.AIRTABLE_SIGNED_AGREEMENT_FIELD || "Signed Agreement";
    const unsignedField =
      process.env.AIRTABLE_UNSIGNED_AGREEMENT_FIELD || "Agreement";

    // Fetch the record
    let rec;
    try {
      rec = await airtableBase(tableId).find(startupRecordId);
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to load Startup record",
        data: {
          statusCode: e?.statusCode,
          error: e?.error,
          reason: e?.message,
        },
      });
    }

    const fieldsList = Object.keys(rec.fields || {});
    function keepIdsFor(fieldName) {
      const arr = Array.isArray(rec.get(fieldName)) ? rec.get(fieldName) : [];
      return arr
        .map((att) => (att && att.id ? { id: att.id } : null))
        .filter(Boolean);
    }

    async function attemptNoopUpdate(fieldName) {
      const updateObj = {};
      updateObj[fieldName] = keepIdsFor(fieldName);
      try {
        await airtableBase(tableId).update(startupRecordId, updateObj);
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          statusCode: e?.statusCode,
          error: e?.error,
          message: e?.message,
        };
      }
    }

    const signedProbe = await attemptNoopUpdate(signedField);
    const unsignedProbe = await attemptNoopUpdate(unsignedField);

    const data = {
      tableId,
      startupRecordId,
      signedField,
      unsignedField,
      recordHasSignedKey: fieldsList.includes(signedField),
      recordHasUnsignedKey: fieldsList.includes(unsignedField),
      probes: {
        signed: signedProbe,
        unsigned: unsignedProbe,
      },
    };
    const ok = !!(signedProbe && signedProbe.ok);
    return res.json({ success: ok, data });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Attachments health check failed",
      reason: e?.message,
    });
  }
});

// Read-only pricing preview (dev/support). Mirrors buildPdfPayload pricing logic.
app.get("/pricing-preview/:token", verifyToken, async (req, res) => {
  try {
    // Resolve startup record id and name
    let startupRecordId = getStartupRecordIdFromReqUser(req);
    if (!startupRecordId)
      startupRecordId = await resolveStartupRecordIdFromEOI(
        req.user?.startupId,
      );
    if (!startupRecordId)
      return res.status(400).json({
        success: false,
        message: "No linked UTS Startups record found for this token.",
      });

    let startupName = "";
    try {
      const srec = await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).find(
        startupRecordId,
      );
      startupName = srec.get("Startup Name (or working title)") || "";
    } catch (_) {}

    // Fetch team members strictly by linked Startup recordId (same as buildPdfPayload)
    const teamMemberRecords = await listTeamMembersByStartupId(startupRecordId);

    // Local helpers (mirror buildPdfPayload)
    function normaliseType(raw) {
      const s = String(raw || "")
        .trim()
        .toLowerCase();
      if (s.includes("full")) return "Full Membership";
      if (s.includes("casual")) return "Casual Membership";
      if (s.includes("day")) return "Day Membership";
      return "Casual Membership";
    }
    function discountColumnFor(category) {
      const s = String(category || "").toLowerCase();
      if (s.includes("current") && s.includes("student"))
        return "Current UTS Student";
      if (s.includes("current") && s.includes("staff")) return "Current Staff";
      if (
        (s.includes("alumni") &&
          (s.includes("within") || s.includes("< 12"))) ||
        /<\s*12/.test(s)
      )
        return "UTS Alumni < 12m";
      if (
        (s.includes("alumni") &&
          (s.includes("more than") ||
            s.includes("over") ||
            s.includes("> 12"))) ||
        />\s*12/.test(s)
      )
        return "UTS Alumni > 12m";
      if (
        s.includes("former") &&
        s.includes("staff") &&
        (s.includes("within") || s.includes("< 12"))
      )
        return "Former Staff < 12m";
      if (
        s.includes("former") &&
        s.includes("staff") &&
        (s.includes("more than") || s.includes("over") || s.includes("> 12"))
      )
        return "Former Staff > 12m";
      return null;
    }

    function effectiveDiscountCategory(rec) {
      try {
        const manualCheckField =
          process.env.AIRTABLE_MEMBERS_MANUAL_OVERRIDE_FIELD ||
          "Manual Discount Check";
        const manualCatField =
          process.env.AIRTABLE_MEMBERS_MANUAL_DISCOUNT_CATEGORY_FIELD ||
          "Manual Discount Category";
        const manualCheck = rec.get(manualCheckField) || "";
        if (String(manualCheck).trim()) {
          const manualCat = rec.get(manualCatField) || "";
          if (String(manualCat).trim()) return manualCat;
        }
      } catch (_) {}
      try {
        const expectedField =
          process.env.AIRTABLE_MEMBERS_EXPECTED_DISCOUNT_FIELD ||
          "Discount Category";
        return rec.get(expectedField) || "";
      } catch (_) {}
      return "";
    }

    function isDiscountValidated(rec) {
      try {
        const manualCheckField =
          process.env.AIRTABLE_MEMBERS_MANUAL_OVERRIDE_FIELD ||
          "Manual Discount Check";
        const manualCatField =
          process.env.AIRTABLE_MEMBERS_MANUAL_DISCOUNT_CATEGORY_FIELD ||
          "Manual Discount Category";
        const manualCheck = rec.get(manualCheckField) || "";
        const manualCat = rec.get(manualCatField) || "";
        
        if (String(manualCheck).trim().toLowerCase() === 'valid' && String(manualCat).trim()) {
          return true;
        }
      } catch (_) {}
      
      try {
        return String(rec.get("Discount Validated") || "")
          .trim()
          .toLowerCase() === "valid";
      } catch (_) {}
      return false;
    }

    async function loadPricingMatrixViaSDK() {
      const out = {};
      const tableId = process.env.AIRTABLE_PRICING_TABLEID;
      if (!tableId) return out;
      try {
        const records = await airtableBase(tableId)
          .select({ pageSize: 100 })
          .all();
        for (const r of records) {
          const f = r.fields || {};
          const typeRaw = f["Membership Type"];
          if (!typeRaw) continue;
          const type = normaliseType(typeRaw);
          const baseRate =
            Number(String(f["Base Rate"] || "").replace(/[^0-9.\-]/g, "")) || 0;
          out[type] = {
            base: baseRate,
            discounts: {
              "Current UTS Student":
                Number(
                  String(f["Current UTS Student"] || "").replace(
                    /[^0-9.\-]/g,
                    "",
                  ),
                ) || 0,
              "UTS Alumni < 12m":
                Number(
                  String(f["UTS Alumni < 12m"] || "").replace(/[^0-9.\-]/g, ""),
                ) || 0,
              "UTS Alumni > 12m":
                Number(
                  String(f["UTS Alumni > 12m"] || "").replace(/[^0-9.\-]/g, ""),
                ) || 0,
              "Current Staff":
                Number(
                  String(f["Current Staff"] || "").replace(/[^0-9.\-]/g, ""),
                ) || 0,
              "Former Staff < 12m":
                Number(
                  String(f["Former Staff < 12m"] || "").replace(
                    /[^0-9.\-]/g,
                    "",
                  ),
                ) || 0,
              "Former Staff > 12m":
                Number(
                  String(f["Former Staff > 12m"] || "").replace(
                    /[^0-9.\-]/g,
                    "",
                  ),
                ) || 0,
            },
          };
        }
      } catch (e) {
        log("warn", "pricing.load.error", { message: e.message });
      }
      return out;
    }

    // Build preview
    const matrix = await loadPricingMatrixViaSDK();
    const rows = [];
    let sum = 0;
    for (const r of teamMemberRecords) {
      const submitted = asOne(r.get("New onboarding form submitted"));
      if (!submitted) continue;
      const type = normaliseType(r.get("Membership Type"));
      const expected = effectiveDiscountCategory(r);
      const validated = isDiscountValidated(r);
      const row = matrix[type] || { base: 0, discounts: {} };
      const base = Number(row.base) || 0;
      let chosen = base;
      let mapped = null;
      let applied = "base";
      if (validated) {
        mapped = discountColumnFor(expected);
        if (mapped && row.discounts && row.discounts[mapped] != null) {
          const val = Number(row.discounts[mapped]) || chosen;
          chosen = val;
          applied = mapped;
        }
      }
      sum += chosen;
      rows.push({
        id: r.id,
        name: r.get("Team member ID") || r.get("Name") || r.id,
        type,
        discountCategory: expected,
        validated,
        mappedColumn: mapped,
        base,
        appliedRate: chosen,
        appliedFrom: applied,
      });
    }

    return res.json({
      success: true,
      data: {
        startupRecordId,
        pricingTableId: process.env.AIRTABLE_PRICING_TABLEID || null,
        matrixLoaded: Object.keys(matrix).length > 0,
        members: rows,
        sum,
      },
    });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Failed to compute pricing preview",
      reason: e?.message,
    });
  }
});

// Return the exact PDF payload used for generation (dev/support)
app.get("/pdf-payload/:token", verifyToken, async (req, res) => {
  try {
    let startupRecordId = getStartupRecordIdFromReqUser(req);
    if (!startupRecordId)
      startupRecordId = await resolveStartupRecordIdFromEOI(
        req.user?.startupId,
      );
    if (!startupRecordId)
      return res.status(400).json({
        success: false,
        message: "No linked UTS Startups record found for this token.",
      });

    const payload = await buildPdfPayload({ startupRecordId });
    return res.json({ success: true, data: payload });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Failed to build PDF payload",
      reason: e?.message,
    });
  }
});

// Internal: fetch payload by explicit startupRecordId (requires X-Auth-Token)
app.get("/pdf-payload", verifyInternalOrJWT, async (req, res) => {
  try {
    const startupRecordId =
      req.query && req.query.startupRecordId
        ? String(req.query.startupRecordId)
        : null;
    if (!startupRecordId)
      return res
        .status(400)
        .json({ success: false, message: "startupRecordId is required" });
    const payload = await buildPdfPayload({ startupRecordId });
    return res.json({ success: true, data: payload });
  } catch (e) {
    return res.status(500).json({
      success: false,
      message: "Failed to build PDF payload",
      reason: e?.message,
    });
  }
});
// ------------------------------
// Signed agreement upload (JWT + multipart)
// ------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}); // 10 MB
app.post(
  "/agreement/upload-signed/:token",
  verifyToken,
  upload.single("file"),
  async (req, res) => {
    try {
      // Resolve Startups record id from token or EOI link
      let startupRecordId = await resolveStartupRecordIdFromEOI(
        req.user?.startupId,
      );
      if (!startupRecordId)
        startupRecordId = getStartupRecordIdFromReqUser(req);
      if (!startupRecordId)
        return res.status(400).json({
          success: false,
          message: "No linked UTS Startups record found for this token.",
        });
      log(
        "info",
        "upload_signed.start",
        {
          contentType: req.headers["content-type"],
          contentLength: req.headers["content-length"],
          hasFile: !!(req.file && req.file.buffer),
          originalname: req.file?.originalname,
          mimetype: req.file?.mimetype,
          size: req.file?.size,
        },
        req,
      );

      // Require multipart file
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          success: false,
          message: "No PDF file uploaded",
          reqId: req._reqId,
        });
      }
      const { originalname, mimetype, buffer, size } = req.file;
      const isPdf =
        mimetype === "application/pdf" || /\.pdf$/i.test(originalname || "");
      if (!isPdf)
        return res.status(415).json({
          success: false,
          message: "Only PDF files are accepted",
          reqId: req._reqId,
        });
      if (!buffer || size <= 0)
        return res
          .status(400)
          .json({ success: false, message: "Empty file", reqId: req._reqId });

      // Save to tmp and expose a one-time URL (same flow as unsigned)
      const tmpDir = path.join(os.tmpdir(), "pdf-cache");
      await fs.ensureDir(tmpDir);
      const token = crypto.randomBytes(12).toString("hex");
      const filePath = path.join(tmpDir, `${token}.pdf`);
      await fs.writeFile(filePath, buffer);
      const ttl = Math.max(
        60,
        parseInt(process.env.URL_TTL_SECONDS || "3600", 10),
      );
      const expiresAt = new Date(Date.now() + ttl * 1000);
      const filenameUp =
        originalname && /\.pdf$/i.test(originalname)
          ? originalname
          : suggestPdfFilename("Signed Agreement");
      PDF_TOKENS.set(token, { filePath, expiresAt, filename: filenameUp });
      const publicBase = pdfBaseUrl(req);
      const attachment = {
        url: `${publicBase}/download/${token}`,
        filename: filenameUp,
      };
      log(
        "info",
        "upload_signed.stored",
        {
          tmpDir,
          token,
          filePath,
          ttl,
          expiresAt: expiresAt.toISOString(),
          filename: filenameUp,
          url: attachment.url,
          base: publicBase,
        },
        req,
      );

      // Attach and stamp date with field detection and safe fallbacks
      let keep = [];
      let srec;
      let fieldsList = [];
      try {
        srec = await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).find(
          startupRecordId,
        );
        fieldsList = Object.keys(srec.fields || {});
      } catch (e) {
        log(
          "error",
          "upload_signed.fetch_record.error",
          { message: e?.message, statusCode: e?.statusCode },
          req,
        );
        return res.status(500).json({
          success: false,
          message: "Failed to load Startup record",
          reqId: req._reqId,
        });
      }

      const CFG_SIGNED_FIELD =
        process.env.AIRTABLE_SIGNED_AGREEMENT_FIELD || "Signed Agreement";
      const CFG_SIGNED_DATE_FIELD =
        process.env.AIRTABLE_SIGNED_AGREEMENT_DATE_FIELD ||
        "Signed Agreement Received Date";
      const overrideField =
        req.query && req.query.field ? String(req.query.field).trim() : null;
      const TARGET_FIELD = overrideField || CFG_SIGNED_FIELD;
      // IMPORTANT: Airtable SDK only includes fields with values in record.fields. A missing key here does not
      // prove the field is absent from the schema. Do not gate on fieldsList.includes(). Attempt update instead.
      const existing = Array.isArray(srec.get(TARGET_FIELD))
        ? srec.get(TARGET_FIELD)
        : [];
      keep = existing
        .map((att) => (att && att.id ? { id: att.id } : null))
        .filter(Boolean);
      log(
        "debug",
        "upload_signed.fields",
        {
          configuredSignedField: CFG_SIGNED_FIELD,
          configuredSignedDateField: CFG_SIGNED_DATE_FIELD,
          usingField: TARGET_FIELD,
          fieldsCount: fieldsList.length,
          recordHasSignedFieldKey: fieldsList.includes(CFG_SIGNED_FIELD),
          hasConfiguredDate: fieldsList.includes(CFG_SIGNED_DATE_FIELD),
          tableId: process.env.UTS_STARTUPS_TABLE_ID,
        },
        req,
      );

      try {
        log(
          "info",
          "upload_signed.attach.start",
          {
            startupRecordId,
            usingField: TARGET_FIELD,
            prevCount: keep.length,
            filename: attachment.filename,
          },
          req,
        );
        const updateObj = {};
        updateObj[TARGET_FIELD] = [...keep, attachment];
        await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).update(
          startupRecordId,
          updateObj,
        );
        log(
          "info",
          "upload_signed.attach.ok",
          {
            startupRecordId,
            usingField: TARGET_FIELD,
            countAfter: keep.length + 1,
          },
          req,
        );
      } catch (e) {
        const payload = {
          message: e?.message,
          statusCode: e?.statusCode,
          error: e?.error,
          stack: DEV_MODE ? e?.stack : undefined,
        };
        log("error", "upload_signed.attach.error", payload, req);
        return res.status(500).json({
          success: false,
          message: "Failed to attach to Airtable",
          reqId: req._reqId,
        });
      }

      if (fieldsList.includes(CFG_SIGNED_DATE_FIELD)) {
        try {
          const updateObj = {};
          updateObj[CFG_SIGNED_DATE_FIELD] = ymd();
          await airtableBase(process.env.UTS_STARTUPS_TABLE_ID).update(
            startupRecordId,
            updateObj,
          );
          log(
            "info",
            "upload_signed.date_stamp.ok",
            { date: ymd(), field: CFG_SIGNED_DATE_FIELD },
            req,
          );
        } catch (e) {
          const payload = {
            message: e?.message,
            statusCode: e?.statusCode,
            error: e?.error,
          };
          log("warn", "upload_signed.date_stamp.error", payload, req);
        }
      } else {
        log(
          "warn",
          "upload_signed.date_field.missing",
          { configuredDateField: CFG_SIGNED_DATE_FIELD },
          req,
        );
      }

      return res.json({
        success: true,
        message: "Signed agreement uploaded",
        url: attachment.url,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (e) {
      log(
        "error",
        "upload_signed.exception",
        { message: e?.message, stack: DEV_MODE ? e?.stack : undefined },
        req,
      );
      return res.status(500).json({
        success: false,
        message: "Failed to upload signed agreement",
        reqId: req._reqId,
      });
    }
  },
);

// Generate dashboard HTML
function generateDashboardHTML(data) {
  const { startup, teamMembers, token, isEOIApproved, formUrls } = data;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${startup.name} - UTS Startup Portal</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <link rel="stylesheet" href="/css/dashboard.css">
</head>
<body>
    <div class="dashboard-container">
        <!-- Header -->
        <header class="dashboard-header">
            <div class="header-content">
                <div class="logo-section">
                    <i class="fas fa-rocket"></i>
                    <h1>UTS Startup Portal</h1>
                </div>
                <div class="startup-info">
                    <h2>${startup.eoiName || startup.name}</h2>
                    <span class="status-badge ${startup.status?.toLowerCase().replace(/\s+/g, "-") || "pending"}">${startup.status || "Pending"}</span>
                </div>
            </div>
        </header>

        <!-- Main Content -->
        <main class="dashboard-main">
            ${isEOIApproved && startup.onboardingSubmitted === 0 ? generateOnboardingFlow(startup, formUrls, token) : '<p style="color: red;">Onboarding section not shown - conditions not met</p>'}

            <!-- Team Management Section -->
            <section class="team-section">
                <div class="section-header">
                    <h3><i class="fas fa-users"></i> Team Management</h3>
                    <p>Manage your team members and their information</p>
                </div>

                <div class="team-grid">
                    ${teamMembers.map((member) => generateTeamMemberCard(member, token)).join("")}
                </div>

                ${
                  teamMembers.length === 0
                    ? `
                <div class="empty-state">
                    <i class="fas fa-user-plus"></i>
                    <h4>No team members yet</h4>
                    <p>Add team members through the onboarding process above</p>
                </div>
                `
                    : ""
                }
            </section>
        </main>
    </div>

    <script src="/js/dashboard.js"></script>
    <script>
        // Initialize dashboard with data
        window.dashboardData = ${JSON.stringify(data)};

    </script>
</body>
</html>`;
}

function generateOnboardingFlow(startup, formUrls, token) {
  // Forms are now loaded dynamically via API calls - no static URLs needed

  return `
    <section class="onboarding-section">
        <div class="section-header">
            <h3><i class="fas fa-clipboard-check"></i> Complete Your Onboarding</h3>
            <p>Follow these steps to complete your startup registration</p>
        </div>

        <div class="onboarding-flow">
            <div class="onboarding-step" data-step="1" data-completed="false">
                <div class="step-header">
                    <div class="step-number">1</div>
                    <div class="step-info">
                        <h4>Startup Information</h4>
                        <p>Complete your startup details (pre-filled from your EOI)</p>
                    </div>
                    <div class="step-actions">
                        <div class="step-status">
                          <!--   <i class="fas fa-clock"></i> -->
                        </div>
                        <div class="step-toggle">
                            <i class="fas fa-chevron-down"></i>
                        </div>
                    </div>
                </div>
                <div class="step-content">
                    <!-- Content loaded dynamically via API -->
                </div>
            </div>

            <div class="onboarding-step" data-step="2" data-completed="false">
                <div class="step-header">
                    <div class="step-number">2</div>
                    <div class="step-info">
                        <h4>Startup Representative</h4>
                        <p>Add the primary contact information</p>
                    </div>
                    <div class="step-actions">
                        <div class="step-status">
                          <!--  <i class="fas fa-clock"></i> -->
                        </div>
                        <div class="step-toggle">
                            <i class="fas fa-chevron-down"></i>
                        </div>
                    </div>
                </div>
                <div class="step-content">
                    <!-- Content loaded dynamically via API -->
                </div>
            </div>

            <div class="onboarding-step" data-step="3" data-completed="false">
                <div class="step-header">
                    <div class="step-number">3</div>
                    <div class="step-info">
                        <h4>Team Members Details</h4>
                        <p>Add your team members</p>
                    </div>
                    <div class="step-actions">
                        <div class="step-status">
                          <!--  <i class="fas fa-clock"></i> -->
                        </div>
                        <div class="step-toggle">
                            <i class="fas fa-chevron-down"></i>
                        </div>
                    </div>
                </div>
                <div class="step-content">
                    <!-- Content loaded dynamically via API -->
                </div>
            </div>

            <!-- Action Buttons -->
            <div class="onboarding-actions">
                <button class="btn btn-secondary add-team-member-btn">
                    <i class="fas fa-plus"></i> Add Another Team Member
                </button>

                <button class="btn btn-primary submission-confirmation-btn">
                    <i class="fas fa-check-circle"></i> Submission Confirmation
                </button>
            </div>
        </div>
    </section>`;
}

function generateTeamMemberCard(member, token) {
  return `
    <div class="team-member-card" data-member-id="${member.id}">
        <div class="member-avatar">
            <i class="fas fa-user"></i>
        </div>
        <div class="member-info">
            <h4>${member.name || "Unknown Name"}</h4>
            <p class="member-position">${member.position || "No position specified"}</p>
            <div class="member-details">
                <div class="detail-item">
                    <i class="fas fa-envelope"></i>
                    <span>${member.email || "No email"}</span>
                </div>
                <div class="detail-item">
                    <i class="fas fa-phone"></i>
                    <span>${member.mobile || "No mobile"}</span>
                </div>
                <div class="detail-item">
                    <i class="fas fa-university"></i>
                    <span>${member.utsAssociation || "No UTS association"}</span>
                </div>
            </div>
        </div>
        <div class="member-actions">
            <button class="btn btn-outline edit-member-btn" onclick="editTeamMember('${member.id}', '${token}')">
                <i class="fas fa-edit"></i> Edit
            </button>
        </div>
    </div>`;
}

// Start server only when run directly (avoid port binding during tests)
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`?? UTS Startup Portal running on 0.0.0.0:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  });
}

module.exports = app;
