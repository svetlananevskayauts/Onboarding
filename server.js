const express = require('express');
const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Trust proxy (required for Replit environment)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com","https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://airtable.com"],
      imgSrc: ["'self'", "data:", "https:"],
      frameSrc: ["'self'", "https://airtable.com"],
      connectSrc: ["'self'", "https://api.airtable.com"]
    }
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 90 * 60 * 1000, // 90 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Airtable configuration
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// JWT token verification middleware
const verifyToken = (req, res, next) => {
  const token = req.params.token || req.body.token;

  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({message: 'Incorrect or expired link, please request a new one.'}); 
    //success: false, message: 'Invalid or expired token' });
  }
};

// Helper function to generate magic link
const generateMagicLink = (startupId, startupName, email) => {
  const token = jwt.sign(
    { 
      startupId, 
      startupName, 
      email,
      timestamp: Date.now()
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  // Auto-detect if running on Replit or use environment variables
  let baseUrl;

  if (process.env.REPLIT_DEV_DOMAIN) {
    // Running on Replit with dev domain
    baseUrl = `https://${process.env.REPLIT_DEV_DOMAIN}`;
  } else if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
    // Alternative Replit environment variables
    baseUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
  } else if (process.env.REPLIT_URL) {
    // Another Replit environment variable
    baseUrl = process.env.REPLIT_URL;
  } else if (process.env.NODE_ENV === 'production' && process.env.PRODUCTION_URL) {
    // Custom production URL
    baseUrl = process.env.PRODUCTION_URL;
  } else if (typeof process.env.REPLIT !== 'undefined' || process.env.REPL_ID) {
    // Auto-detect Replit environment and use the domain from request
    baseUrl = 'https://753aaab8-78b2-467e-9254-11a447b6ee4a-00-ikckowe1kplg.picard.replit.dev';
  } else {
    // Local development
    baseUrl = `http://localhost:${PORT}`;
  }

  return `${baseUrl}/dashboard/${token}`;
};

// Routes

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Email lookup and magic link generation
app.post('/lookup-email', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    let startup = null;
    let accessType = null; // 'onboarding' or 'management'
    let targetTable = null;

    // STEP 1: Check EOI table for approved startups, then check if they need onboarding
    try {
      const eoiRecords = await base(process.env.UTS_EOI_TABLE_ID).select({
        filterByFormula: `AND({Email} = "${email}", {Status} = "Approved")`
      }).firstPage();
      console.log('process.env.UTS_EOI_TABLE_ID', process.env.UTS_EOI_TABLE_ID);

      if (eoiRecords.length > 0) {
        const eoiRecord = eoiRecords[0];
        const startupName = eoiRecord.get('Startup Name');

        // Now check if this startup exists in Startups table and onboarding status
        try {
          const startupRecords = await base(process.env.UTS_STARTUPS_TABLE_ID).select({
            filterByFormula: `{Startup Name (or working title)} = "${startupName}"`
          }).firstPage();

          if (startupRecords.length > 0) {
            // Startup exists in Startups table - check onboarding status
            const startupRecord = startupRecords[0];
            const onboardingSubmitted = startupRecord.get('Onboarding Submitted') || 0;

            if (onboardingSubmitted === 0) {
              // Needs onboarding - store magic link in EOI table
              const utsStartupsField = eoiRecord.get('UTS Startups');
              let representativeFormUrl = null;

              // Get URL from linked UTS Startups record if it exists
              console.log('UTS Startups field value:', utsStartupsField);
              if (utsStartupsField && utsStartupsField.length > 0) {
                try {
                  console.log('Looking up linked record with ID:', utsStartupsField[0]);
                  const linkedStartupRecord = await base(process.env.UTS_STARTUPS_TABLE_ID).find(utsStartupsField[0]);
                  representativeFormUrl = linkedStartupRecord.get('03. Startup Representative Details Prefilled');
                  console.log('Fetched representativeFormUrl from linked record:', representativeFormUrl);
                } catch (error) {
                  console.log('Error fetching linked startup record:', error.message);
                }
              } else {
                console.log('UTS Startups field is empty or invalid');
              }

              startup = {
                id: eoiRecord.id,
                name: startupName,
                primaryContact: email,
                status: eoiRecord.get('Status'),
                isEOIApproved: true,
                needsOnboarding: true,
                eoiName: eoiRecord.get('EOI') || startupName,
                prefilledFormUrl: eoiRecord.get('02. Startup Onboarding Form Prefilled'),
                representativeFormUrl: representativeFormUrl,
                teamMemberFormUrl: representativeFormUrl,
                step2Unlocked: utsStartupsField && utsStartupsField.length > 0
              };
              accessType = 'onboarding';
              targetTable = process.env.UTS_EOI_TABLE_ID;
            } else {
              // Already onboarded - treat as management (use startups table)
              startup = {
                id: startupRecord.id,
                name: startupRecord.get('Startup Name (or working title)'),
                primaryContact: email,
                recordId: startupRecord.get('Record ID'),
                status: startupRecord.get('Startup status'),
                isEOIApproved: false,
                needsOnboarding: false,
                eoiName: startupRecord.get('Startup Name (or working title)'),
                representativeFormUrl: startupRecord.get('03. Startup Representative Details Prefilled'),
                teamMemberFormUrl: startupRecord.get('03. Startup Representative Details Prefilled')
              };
              accessType = 'management';
              targetTable = process.env.UTS_STARTUPS_TABLE_ID;
            }
          } else {
            // EOI approved but no startup record yet - needs onboarding
            const utsStartupsField = eoiRecord.get('UTS Startups');
            let representativeFormUrl = null;

            // Get URL from linked UTS Startups record if it exists
            if (utsStartupsField && utsStartupsField.length > 0) {
              try {
                const linkedStartupRecord = await base(process.env.UTS_STARTUPS_TABLE_ID).find(utsStartupsField[0]);
                representativeFormUrl = linkedStartupRecord.get('03. Startup Representative Details Prefilled');
                console.log('Fetched representativeFormUrl from linked record (no startup):', representativeFormUrl);
              } catch (error) {
                console.log('Error fetching linked startup record (no startup):', error.message);
              }
            }

            startup = {
              id: eoiRecord.id,
              name: startupName,
              primaryContact: email,
              status: eoiRecord.get('Status'),
              isEOIApproved: true,
              needsOnboarding: true,
              eoiName: eoiRecord.get('EOI') || startupName,
              prefilledFormUrl: eoiRecord.get('02. Startup Onboarding Form Prefilled'),
              representativeFormUrl: representativeFormUrl,
              step2Unlocked: utsStartupsField && utsStartupsField.length > 0
            };
            accessType = 'onboarding';
            targetTable = process.env.UTS_EOI_TABLE_ID;
          }
        } catch (startupError) {
          console.log('Error checking startup table:', startupError.message);
          // Fallback to onboarding flow
          const utsStartupsField = eoiRecord.get('UTS Startups');
          let representativeFormUrl = null;

          // Get URL from linked UTS Startups record if it exists
          if (utsStartupsField && utsStartupsField.length > 0) {
            try {
              const linkedStartupRecord = await base(process.env.UTS_STARTUPS_TABLE_ID).find(utsStartupsField[0]);
              representativeFormUrl = linkedStartupRecord.get('03. Startup Representative Details Prefilled');
              console.log('Fetched representativeFormUrl from linked record (fallback):', representativeFormUrl);
            } catch (error) {
              console.log('Error fetching linked startup record (fallback):', error.message);
            }
          }

          startup = {
            id: eoiRecord.id,
            name: startupName,
            primaryContact: email,
            status: eoiRecord.get('Status'),
            isEOIApproved: true,
            needsOnboarding: true,
            eoiName: eoiRecord.get('EOI') || startupName,
            prefilledFormUrl: eoiRecord.get('02. Startup Onboarding Form Prefilled'),
            representativeFormUrl: representativeFormUrl,
            step2Unlocked: utsStartupsField && utsStartupsField.length > 0
          };
          accessType = 'onboarding';
          targetTable = process.env.UTS_EOI_TABLE_ID;
        }
      }
    } catch (error) {
      console.log('EOI table check failed:', error.message);
    }

    // STEP 2: If not onboarding, check UTS Startups table for management
    console.log('DEBUG: Checking management path, startup is null:', !startup);
    if (!startup) {
      try {
        const startupRecords = await base(process.env.UTS_STARTUPS_TABLE_ID).select({
          filterByFormula: `{Primary contact email} = "${email}"`
        }).firstPage();

        console.log('DEBUG: Found startup records in management path:', startupRecords.length);
        if (startupRecords.length > 0) {
          const startupRecord = startupRecords[0];
                  startup = {
          id: startupRecord.id,
          name: startupRecord.get('Startup Name (or working title)'),
          primaryContact: email,
          recordId: startupRecord.get('Record ID'),
          status: startupRecord.get('Startup status'),
          isEOIApproved: false,
          needsOnboarding: false,
          eoiName: startupRecord.get('Startup Name (or working title)'),
          representativeFormUrl: startupRecord.get('03. Startup Representative Details Prefilled')
        };
          console.log('Management path - representativeFormUrl from Airtable:', startupRecord.get('03. Startup Representative Details Prefilled'));
          accessType = 'management';
          targetTable = process.env.UTS_STARTUPS_TABLE_ID;
        }
      } catch (error) {
        console.log('Startups table check failed:', error.message);
      }
    }



    if (!startup) {
      return res.status(404).json({ 
        success: false, 
        message: 'Email not found in our system. Please ensure you have submitted an EOI and it has been approved, or you are the primary contact for an existing startup.' 
      });
    }

    // Generate magic link
    const magicLink = generateMagicLink(startup.id, startup.name, email);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Update the target table with magic link
    await base(targetTable).update(startup.id, {
      'Magic Link': magicLink,
      'Token Expires At': expiresAt.toISOString(),
      'Link': magicLink
    });

    // Provide different messages based on access type
    let message = 'Magic link generated successfully!';
    if (accessType === 'onboarding') {
      message = 'Welcome! Complete your startup onboarding process.';
    } else if (accessType === 'management') {
      message = 'Access your startup dashboard to manage your team.';
    }

    res.json({ 
      success: true, 
      message: message,
      accessType: accessType,
      magicLink: magicLink // In production, this would be sent via email
    });

  } catch (error) {
    console.error('Email lookup error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while processing your request. Please try again.' 
    });
  }
});

// Dashboard route
app.get('/dashboard/:token', verifyToken, async (req, res) => {
  try {
    const { startupId, startupName, email } = req.user;

    // Get startup information
    let startup = null;
    let isEOIApproved = false;

    // First try EOI table
    try {
      const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
      startup = {
        id: eoiRecord.id,
        name: eoiRecord.get('Startup Name (or working title)'),
        primaryContact: eoiRecord.get('Primary contact email'),
        status: eoiRecord.get('Status'),
        onboardingSubmitted: eoiRecord.get('Onboarding Submitted') || 0
      };
      isEOIApproved = true;
    } catch (error) {
      // Try UTS Startups table
      try {
        const startupRecord = await base(process.env.UTS_STARTUPS_TABLE_ID).find(startupId);
        startup = {
          id: startupRecord.id,
          name: startupRecord.get('Startup Name (or working title)'),
          primaryContact: startupRecord.get('Primary contact email'),
          recordId: startupRecord.get('Record ID'),
          status: startupRecord.get('Startup status'),
          onboardingSubmitted: startupRecord.get('Onboarding Submitted') || 0
        };
      } catch (innerError) {
        throw new Error('Startup not found');
      }
    }

    // Get team members
    const teamMemberRecords = await base(process.env.TEAM_MEMBERS_TABLE_ID).select({
      filterByFormula: `{Startup*} = "${startup.name}"`
    }).firstPage();

    const teamMembers = teamMemberRecords.map(record => ({
      id: record.id,
      name: record.get('Team member ID') || 'Unknown',
      email: record.get('Personal email*'),
      mobile: record.get('Mobile*'),
      position: record.get('Position at startup*'),
      utsAssociation: record.get('What is your association to UTS?*'),
      status: record.get('Team Member Status')
    }));

    const dashboardData = {
      startup,
      teamMembers,
      token: req.params.token,
      isEOIApproved,
      formUrls: {
        startupOnboarding: process.env.STARTUP_ONBOARDING_FORM_URL,
        teamMember: process.env.TEAM_MEMBER_FORM_URL
      }
    };

    res.send(generateDashboardHTML(dashboardData));

  } catch (error) {
    console.error('Dashboard error:', error);
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
app.post('/update-profile', verifyToken, async (req, res) => {
  try {
    const { memberId, updates } = req.body;

    if (!memberId || !updates) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    await base(process.env.TEAM_MEMBERS_TABLE_ID).update(memberId, updates);

    res.json({ success: true, message: 'Profile updated successfully!' });

  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ success: false, message: 'Failed to update profile. Please try again.' });
  }
});

// New API endpoints for individual form data fetching

// Endpoint to fetch header information (EOI and Email)
app.get('/get-header-info/:token', verifyToken, async (req, res) => {
  try {
    const { startupId } = req.user;

    // Get EOI and Email from EOI table
    const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
    const eoiName = eoiRecord.get('EOI');
    const email = eoiRecord.get('Email');

    res.json({
      success: true,
      eoiName: eoiName || 'No EOI Name',
      email: email || 'No Email'
    });

  } catch (error) {
    console.error('Get header info error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch header information.' });
  }
});

// Endpoint to fetch Startup Information form URL
app.get('/get-startup-form/:token', verifyToken, async (req, res) => {
  try {
    const { startupId } = req.user;

    // Get startup information from EOI table
    const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
    const startupFormUrl = eoiRecord.get('02. Startup Onboarding Form Prefilled');

    res.json({
      success: true,
      formUrl: startupFormUrl || null
    });

  } catch (error) {
    console.error('Get startup form error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch startup form URL.' });
  }
});

// Endpoint to fetch Startup Representative form URL
app.get('/get-representative-form/:token', verifyToken, async (req, res) => {
  try {
    const { startupId } = req.user;

    // Step 1: Get UTS Startups field from EOI table
    const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
    const utsStartupsField = eoiRecord.get('UTS Startups');

    if (!utsStartupsField || utsStartupsField.length === 0) {
      return res.json({
        success: false,
        message: 'Fill in Startup Information Form'
      });
    }

    // Step 2: Get representative form URL from linked UTS Startups record
    const linkedStartupRecord = await base(process.env.UTS_STARTUPS_TABLE_ID).find(utsStartupsField[0]);
    const representativeFormUrl = linkedStartupRecord.get('03. Startup Representative Details Prefilled');

    res.json({
      success: true,
      formUrl: representativeFormUrl || null
    });

  } catch (error) {
    console.error('Get representative form error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch representative form URL.' });
  }
});

// Endpoint to fetch Team Members form URL
app.get('/get-team-members-form/:token', verifyToken, async (req, res) => {
  try {
    const { startupId } = req.user;

    // Step 1: Get UTS Startups field from EOI table
    const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
    const utsStartupsField = eoiRecord.get('UTS Startups');

    if (!utsStartupsField || utsStartupsField.length === 0) {
      return res.json({
        success: false,
        message: 'Fill in Startup Information Form'
      });
    }

    // Step 2: Get primary contact email from linked UTS Startups record
    const linkedStartupRecord = await base(process.env.UTS_STARTUPS_TABLE_ID).find(utsStartupsField[0]);
    const primaryContactEmail = linkedStartupRecord.get('Primary contact email');

    if (!primaryContactEmail) {
      return res.json({
        success: false,
        message: 'Primary contact email not found'
      });
    }

    // Step 3: Get team members form URL
    const teamMembersFormUrl = linkedStartupRecord.get('04. Nominated Personnel Details');

    res.json({
      success: true,
      formUrl: teamMembersFormUrl || null
    });

  } catch (error) {
    console.error('Get team members form error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch team members form URL.' });
  }
});

// Endpoint for submission confirmation
app.patch('/submission-confirmation/:token', verifyToken, async (req, res) => {
  try {
    const { startupId } = req.user;

    console.log('Submission confirmation request for startupId:', startupId);

    // Step 2.1: Fetch data from 'UTS Startups EOI' table from 'UTS Startups' field
    const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
    const utsStartupsField = eoiRecord.get('UTS Startups');

    console.log('UTS Startups field from EOI table:', utsStartupsField);

    if (!utsStartupsField || utsStartupsField.length === 0) {
      return res.json({
        success: false,
        message: 'No linked startup record found in EOI table'
      });
    }

    // Step 2.2: Get the record ID from the response
    const linkedRecordId = utsStartupsField[0];
    console.log('Linked record ID:', linkedRecordId);

    // Step 2.3: PATCH request to UTS Startups table to update Submission Confirmation
    const updateData = {
      "fields": {
        "Submission Confirmation": "true"
      }
    };

    console.log('Updating record with data:', updateData);

    await base(process.env.UTS_STARTUPS_TABLE_ID).update(linkedRecordId, {
      'Submission Confirmation': true
    });

    console.log('Successfully updated Submission Confirmation to true');

    res.json({
      success: true,
      message: 'Submission confirmed successfully',
      recordId: linkedRecordId
    });

  } catch (error) {
    console.error('Submission confirmation error:', error);
    res.status(500).json({ success: false, message: 'Failed to confirm submission: ' + error.message });
  }
});

// Check step progress endpoint
app.get('/check-progress/:token', verifyToken, async (req, res) => {
  try {
    const { startupName, startupId } = req.user;

    // Check UTS Startups table for form submission status
    let startupFormSubmitted = false;
    let representativeFormSubmitted = false;
    let step2Unlocked = false;

    try {
      const startupRecords = await base(process.env.UTS_STARTUPS_TABLE_ID).select({
        filterByFormula: `{Startup Name (or working title)} = "${startupName}"`
      }).firstPage();

      if (startupRecords.length > 0) {
        const startupRecord = startupRecords[0];
        startupFormSubmitted = (startupRecord.get('New onboarding form submitted') || 0) === 1;
      }
    } catch (error) {
      console.log('Error checking startup form submission:', error.message);
    }

    // Check EOI table for 'UTS Startups' field to determine Step 2 unlock status
    try {
      const eoiRecord = await base(process.env.UTS_EOI_TABLE_ID).find(startupId);
      const utsStartupsField = eoiRecord.get('UTS Startups');
      step2Unlocked = utsStartupsField && utsStartupsField.length > 0;
    } catch (error) {
      console.log('Error checking UTS Startups field in EOI table:', error.message);
    }

    // Check Team Members table for representative submission
    try {
      const teamMemberRecords = await base(process.env.TEAM_MEMBERS_TABLE_ID).select({
        filterByFormula: `{Startup*} = "${startupName}"`
      }).firstPage();

      if (teamMemberRecords.length > 0) {
        // Check if any team member has submission status = 1
        representativeFormSubmitted = teamMemberRecords.some(record => 
          (record.get('New onboarding form submitted') || 0) === 1
        );
      }
    } catch (error) {
      console.log('Error checking team member form submission:', error.message);
    }

    res.json({
      success: true,
      progress: {
        step1: startupFormSubmitted,
        step2: representativeFormSubmitted,
        step2Unlocked: step2Unlocked,
        step3: false // Step 3 is always available once step 2 is complete
      }
    });

  } catch (error) {
    console.error('Check progress error:', error);
    res.status(500).json({ success: false, message: 'Failed to check progress.' });
  }
});

// Complete onboarding endpoint
app.post('/complete-onboarding', verifyToken, async (req, res) => {
  try {
    const { startupId, startupName } = req.user;

    // Find or create the startup record in UTS Startups table
    try {
      const startupRecords = await base(process.env.UTS_STARTUPS_TABLE_ID).select({
        filterByFormula: `{Startup Name (or working title)} = "${startupName}"`
      }).firstPage();

      if (startupRecords.length > 0) {
        // Update existing startup record
        const startupRecord = startupRecords[0];
        await base(process.env.UTS_STARTUPS_TABLE_ID).update(startupRecord.id, {
          'Onboarding Submitted': 1
        });
      } else {
        // This shouldn't normally happen if onboarding forms create the record
        // But as a fallback, we could create it here
        console.log('Warning: Startup record not found in UTS Startups table during onboarding completion');
      }

      res.json({ success: true, message: 'Onboarding completed successfully!' });

    } catch (error) {
      console.error('Error updating startup record:', error);
      res.status(500).json({ success: false, message: 'Failed to complete onboarding. Please try again.' });
    }

  } catch (error) {
    console.error('Complete onboarding error:', error);
    res.status(500).json({ success: false, message: 'Failed to complete onboarding. Please try again.' });
  }
});

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
                    <span class="status-badge ${startup.status?.toLowerCase().replace(/\s+/g, '-') || 'pending'}">${startup.status || 'Pending'}</span>
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
                    ${teamMembers.map(member => generateTeamMemberCard(member, token)).join('')}
                </div>

                ${teamMembers.length === 0 ? `
                <div class="empty-state">
                    <i class="fas fa-user-plus"></i>
                    <h4>No team members yet</h4>
                    <p>Add team members through the onboarding process above</p>
                </div>
                ` : ''}
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
            <h4>${member.name || 'Unknown Name'}</h4>
            <p class="member-position">${member.position || 'No position specified'}</p>
            <div class="member-details">
                <div class="detail-item">
                    <i class="fas fa-envelope"></i>
                    <span>${member.email || 'No email'}</span>
                </div>
                <div class="detail-item">
                    <i class="fas fa-phone"></i>
                    <span>${member.mobile || 'No mobile'}</span>
                </div>
                <div class="detail-item">
                    <i class="fas fa-university"></i>
                    <span>${member.utsAssociation || 'No UTS association'}</span>
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

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 UTS Startup Portal running on 0.0.0.0:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});

module.exports = app;