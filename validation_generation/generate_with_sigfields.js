// generate_with_sigfields.js — Production
// Node >= 16
//
// - Builds the agreement PDF (header, table, boilerplate).
// - Adds stylable Name/Title/Date fields and a genuine clickable /Sig field for the Licensee.
// - Optionally signs the UTS block server‑side using a .p12 certificate.
// - Saves a viewer‑friendly PDF (object streams disabled for robust signing workflows).
//
// Usage:
//   node generate_with_sigfields.js [payload.json] [out.pdf] [uts_cert.p12] ["passphrase"]

'use strict';

const fs = require('fs-extra');
const path = require('path');
const {
  PDFDocument,
  StandardFonts,
  rgb,
  PDFName, PDFNumber, PDFString,
} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { plainAddPlaceholder } = require('@signpdf/placeholder-plain');
const { SignPdf } = require('@signpdf/signpdf');
const { SignerP12 } = require('@signpdf/signer-p12');

const logoPath = path.join(__dirname, 'UTS_startups_logo.png'); // update filename
const logoBytes = fs.existsSync(logoPath) ? fs.readFileSync(logoPath) : null;
const sigPath = path.join(__dirname, 'MH_sig.png')
const sigBytes = fs.existsSync(sigPath) ? fs.readFileSync(sigPath) : null;
const TERMS_URL = process.env.TERMS_URL || 'https://uts.ac/UTSS_TermsAndConditions'; // TODO: set the live URL



/* -------------------------- HELPERS -------------------------- */
function rgbHex(hex) {
  const s = String(hex).replace('#', '');
  return rgb(
    parseInt(s.slice(0, 2), 16) / 255,
    parseInt(s.slice(2, 4), 16) / 255,
    parseInt(s.slice(4, 6), 16) / 255
  );
}

/* -------------------------- FONTS ON DISK (optional) -------------------------- */
const arialPath = path.join(__dirname, 'fonts', 'arial.ttf');
const arialBoldPath = path.join(__dirname, 'fonts', 'arialbd.ttf');
const baseFontBytes = fs.existsSync(arialPath) ? fs.readFileSync(arialPath) : null;
const boldFontBytes = fs.existsSync(arialBoldPath) ? fs.readFileSync(arialBoldPath) : null;

/* -------------------------- THEME / LAYOUT -------------------------- */
const THEME = {
  page: { width: 595.28, height: 841.89 }, // A4
  margins: { top: 12, right: 72, bottom: 72, left: 72 },
  fonts: {
    h1: 18,
    h2: 14,
    base: 10,
    small: 10,
  },
  colours: {
    text: rgb(0, 0, 0),
    lightText: rgb(0.3, 0.3, 0.3),
    tableHeaderFill: rgbHex('#0F4BEB'),
    tableHeaderText: rgb(1, 1, 1),
    tableGrid: rgb(0.55, 0.55, 0.55),
    cellFillAlt: rgb(0.965, 0.965, 0.985),
    logoBox: rgb(0.90, 0.90, 0.90),
    panelBg: rgb(0.2, 0.2, 0.2),
    panelBorder: rgb(0.75, 0.79, 0.92),
  },
  layout: {
    tableColWidths: [31.48, 94.7, 325.1],               // 3 cols
    rowHeights:    [22, 89, 89, 22, 36, 128, 36, 36],   // 8 rows
    pad: 6,
    headerPad: 6,
    lineGap: 6,
    sectionGap: 10,
    logo: { w: 220, h: 72 },
    sigPanel: {
      height: 120,
      gapCols: 24,
      sigHeight: 36,
      tfHeight: 14,
      tfGap: 12,
    }
  }
};

/* -------------------------- PAYLOAD -------------------------- */
function loadPayload(jsonPath) {
  const fallback = {
    legal_name: 'ABC Pty Ltd',
    abn: '12 345 678 901',
    address: '123 Startup Lane, Sydney NSW 2000',
    debtor_email: 'founder@abc.com',
    billing_start_date: '2025-10-01',
    calculated_monthly_fee: '$500 per month plus GST',
    memberships: {
      mem_fulltime_count: '1',
      mem_fulltime_uts_discount_count: '1',
      mem_casual_count: '1',
      mem_casual_uts_within_12m_count: '1',
      mem_casual_uts_over_12m_count: '0',
      mem_day_count: '0'
    },
    team: [
      { first_name: 'Jane', last_name: 'Founder' },
      { first_name: 'John', last_name: 'Developer' }
    ],
    insurance_status: 1
  };
  if (!jsonPath) return fallback;
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const obj = JSON.parse(raw);
    return { ...fallback, ...obj };
  } catch (e) {
    console.warn('Could not read payload.json; using fallback demo data:', e.message);
    return fallback;
  }
}

/* -------------------------- TEXT WRAP -------------------------- */
function wrapText({ text, font, size, maxWidth }) {
  const normalised = String(text ?? '').replace(/\r\n/g, '\n');
  const logicalLines = normalised.split('\n');
  const out = [];
  for (const logical of logicalLines) {
    const words = logical.split(/\s+/);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const test = line ? `${line} ${w}` : w;
      const width = font.widthOfTextAtSize(test, size);
      if (width <= maxWidth) {
        line = test;
      } else {
        if (line) out.push(line);
        if (font.widthOfTextAtSize(w, size) > maxWidth) {
          let chunk = '';
          for (const ch of w) {
            const next = chunk + ch;
            if (font.widthOfTextAtSize(next, size) <= maxWidth) chunk = next;
            else { out.push(chunk); chunk = ch; }
          }
          line = chunk;
        } else {
          line = w;
        }
      }
      if (i === words.length - 1 && line) out.push(line);
    }
  }
  return out;
}

function drawWrappedText(page, { x, y, width, text, font, size, colour, lineGap }) {
  const lines = wrapText({ text, font, size, maxWidth: width });
  let cursorY = y;
  for (const ln of lines) {
    page.drawText(ln, { x, y: cursorY, size, font, color: colour });
    cursorY -= size + (lineGap ?? 2);
  }
  return cursorY;
}

function addUriLinkAnnotation(pdfDoc, page, rect /* [x1,y1,x2,y2] */, url, altText) {
  const { context } = pdfDoc;
  const linkDict = context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Link'),
    Rect: context.obj(rect),
    Border: context.obj([0, 0, 0]),          // no visible rectangle
    A: context.obj({
      S: PDFName.of('URI'),
      URI: PDFString.of(String(url)),
    }),
    // Optional: assistive text
    Contents: altText ? PDFString.of(String(altText)) : undefined,
  });
  const linkRef = context.register(linkDict);

  let annots = page.node.lookup(PDFName.of('Annots'));
  if (!annots) {
    annots = context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(linkRef);
}

// Given a block of laid-out text, overlay link rects on a target phrase (handles wrapping).
function addInlineLinkOverText(pdfDoc, page, {
  xLeft, baselineY, maxWidth, lineGap,
  font, size, fullText, targetText, url
}) {
  if (!targetText || !url) return;

  // 1) Where (line/offset) does the target start?
  const before = fullText.split(targetText)[0];
  const beforeLines = wrapText({ text: before, font, size, maxWidth });
  const startLineIndex = Math.max(0, beforeLines.length - 1);
  const startLineText  = beforeLines[startLineIndex] || '';

  const prefixWidthOnStartLine = font.widthOfTextAtSize(startLineText, size);
  let curBaselineY = baselineY - startLineIndex * (size + (lineGap ?? 2));
  let curX = xLeft + prefixWidthOnStartLine;
  let spaceLeft = maxWidth - (curX - xLeft);

  // 2) Split the target across lines using the same word logic as wrapText()
  const words = String(targetText).split(/\s+/).filter(Boolean);
  let piece = ''; // words accumulating on the current line
  const rects = [];

  const flushPiece = () => {
    if (!piece) return;
    const w = font.widthOfTextAtSize(piece, size);
    // Make a comfortable clickable band around the text baseline
    const y1 = curBaselineY - size * 0.25; // bottom
    const y2 = curBaselineY + size * 0.85; // top
    addUriLinkAnnotation(pdfDoc, page, [curX, y1, curX + w, y2], url, targetText);
    // Optional: subtle underline cue
    try {
      page.drawLine({ start: { x: curX, y: y1 + 1 }, end: { x: curX + w, y: y1 + 1 }, thickness: 0.5, color: THEME.colours.tableHeaderFill });
    } catch (_) { /* ignore if not supported */ }
    // prepare next line if needed
    curBaselineY -= size + (lineGap ?? 2);
    curX = xLeft;
    spaceLeft = maxWidth;
    piece = '';
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const candidate = piece ? `${piece} ${w}` : w;
    const candWidth = font.widthOfTextAtSize(candidate, size);
    if (candWidth <= spaceLeft) {
      piece = candidate;
    } else {
      flushPiece();
      piece = w;
      // Recompute cand width for fresh line:
      spaceLeft = maxWidth;
      if (font.widthOfTextAtSize(piece, size) > spaceLeft) {
        // Very long single word: best-effort box for the word on its own line
        // (rare here, since the target phrase has spaces)
      }
    }
  }
  // final bit
  if (piece) {
    const w = font.widthOfTextAtSize(piece, size);
    const y1 = curBaselineY - size * 0.25;
    const y2 = curBaselineY + size * 0.85;
    addUriLinkAnnotation(pdfDoc, page, [curX, y1, curX + w, y2], url, targetText);
    try {
      page.drawLine({ start: { x: curX, y: y1 + 1 }, end: { x: curX + w, y: y1 + 1 }, thickness: 0.5, color: THEME.colours.tableHeaderFill });
    } catch (_) {}
  }
}

// --- Dynamic heights helpers (Option B) ---
function measureBlockHeight({ text, font, size, maxWidth, lineGap }) {
  const lines = wrapText({ text, font, size, maxWidth });
  if (!lines.length) return 0;
  const gap = (lineGap ?? 2);
  return lines.length * (size + gap) - gap;
}

function computeDynamicRowHeights(fonts, data) {
  const { layout, fonts: f } = THEME;
  const { tableColWidths: colW, pad, lineGap } = layout;
  const h = [...layout.rowHeights];

  // Row 1: Licensee (col 2 is the long one)
  {
    const leftW = colW[1] - 2 * pad;
    const rightW = colW[2] - 2 * pad;
    const leftH = measureBlockHeight({
      text: 'Licensee\n(referred to as “you” or “your”)',
      font: fonts.base, size: f.base, maxWidth: leftW, lineGap,
    });
    const rightH = measureBlockHeight({
      text: data.licenceeBlock, font: fonts.base, size: f.base, maxWidth: rightW, lineGap,
    });
    const needed = Math.max(leftH, rightH) + 2 * pad + 4; // small headroom
    h[1] = Math.max(h[1], Math.ceil(needed));
  }

  // Row 2: UTS block (col 2)
  {
    const rightW = colW[2] - 2 * pad;
    const rightH = measureBlockHeight({
      text: data.utsBlock, font: fonts.base, size: f.base, maxWidth: rightW, lineGap,
    });
    const needed = rightH + 2 * pad + 4;
    h[2] = Math.max(h[2], Math.ceil(needed));
  }

  // Row 5: Membership & Fee (holistic pack; aligned headings; minimal height)
  {
    const leftW  = colW[1] - 2 * pad;
    const rightW = colW[2] - 2 * pad;
    const headH  = measureBlockHeight({ text: 'Membership type and Fee',        font: fonts.bold, size: f.base, maxWidth: leftW,  lineGap });
    const sub1H  = measureBlockHeight({ text: 'Number and type of Memberships', font: fonts.base, size: f.base, maxWidth: leftW,  lineGap });
    const memH   = measureBlockHeight({ text: data.membershipCopy,              font: fonts.base, size: f.base, maxWidth: rightW, lineGap });
    const sub2H  = measureBlockHeight({ text: 'Fee',                             font: fonts.base, size: f.base, maxWidth: leftW,  lineGap });
    const feeH   = measureBlockHeight({ text: data.monthlyFee,                   font: fonts.base, size: f.base, maxWidth: rightW, lineGap });

    // Flow = heading → (Sub1 || Membership) aligned → (Sub2 || Fee) aligned
    // Total used height inside the cell (excl. padding):
    //   headH + lineGap + max(sub1H, memH) + lineGap + max(sub2H, feeH)
    const usedInside = headH + lineGap + Math.max(sub1H, memH) + lineGap + Math.max(sub2H, feeH);
    const topAllowance    = pad + 2;
    const bottomAllowance = pad;
    h[5] = Math.max(h[5], Math.ceil(topAllowance + usedInside + bottomAllowance));
  }

  // Row 6: Personnel (col 2)
  {
    const rightW = colW[2] - 2 * pad;
    const rightH = measureBlockHeight({
      text: data.personnel, font: fonts.base, size: f.base, maxWidth: rightW, lineGap,
    });
    const needed = rightH + 2 * pad + 4;
    h[6] = Math.max(h[6], Math.ceil(needed));
  }

  // Row 7: Insurance (col 2)
  {
    const rightW = colW[2] - 2 * pad;
    const rightH = measureBlockHeight({
      text: data.insurance, font: fonts.base, size: f.base, maxWidth: rightW, lineGap,
    });
    const needed = rightH + 2 * pad + 4;
    h[7] = Math.max(h[7], Math.ceil(needed));
  }

  return h;
}

/* -------------------------- COPY BUILDERS -------------------------- */
function plural(n) { return n === 1 ? '' : 's'; }

function buildMembershipCopy(memberships) {
  const n = (k) => parseInt(memberships?.[k] ?? '0', 10) || 0;
  const full = n('mem_fulltime_count');
  const fullDisc = n('mem_fulltime_uts_discount_count');
  const casual = n('mem_casual_count');
  const casualFree = n('mem_casual_uts_within_12m_count');
  const casualOver = n('mem_casual_uts_over_12m_count');
  const day = n('mem_day_count');

  const pieces = [];
  if (full) pieces.push(`${full} full membership${plural(full)}`);
  if (fullDisc) pieces.push(`${fullDisc} discounted full membership${plural(fullDisc)}`);
  if (casual) pieces.push(`${casual} casual membership${plural(casual)}`);
  if (casualFree) pieces.push(`${casualFree} free casual membership${plural(casualFree)}`);
  if (casualOver) pieces.push(`${casualOver} discounted casual membership${plural(casualOver)}`);
  if (day) pieces.push(`${day} daily membership${plural(day)}`);

  return pieces.length ? pieces.join(', ') : 'none';
}

function buildTableData(payload) {
  const licenceeBlock =
    `Name: ${payload.legal_name || '—'}\n` +
    `ABN: ${payload.abn || '—'}\n` +
    `Address: ${payload.address || '—'}\n` +
    `Email: ${payload.debtor_email || '—'}\n` +
    `Representative: ${payload.debtor_name || '—'}`;

  const utsBlock =
    'University of Technology Sydney\n' +
    'ABN: 77 257 686 961\n' +
    'Address: 15 Broadway Ultimo NSW 2007\n' +
    'Email: murray@uts.edu.au\n' +
    'Representative: Murray Hurps, Director, Entrepreneurship';

  const commencementDate = payload.billing_start_date || '—';
  const membershipCopy = buildMembershipCopy(payload.memberships);
  const monthlyFee = payload.calculated_monthly_fee || '—';

  const personnel =
    Array.isArray(payload.team) && payload.team.length
      ? payload.team.map(t => `${(t.first_name || '').trim()} ${(t.last_name || '').trim()}`.trim())
          .filter(Boolean).join(', ')
      : '—';

  const insurance = payload.insurance_status
    ? '$5 million for any one occurrence'
    : 'not applicable';

  return {
    licenceeBlock,
    utsBlock,
    commencementDate,
    membershipCopy,
    monthlyFee,
    personnel,
    insurance,
  };
}

/* -------------------------- DRAWING -------------------------- */
async function drawHeader(pdfDoc, page, fonts) {
  const { margins, colours, fonts: f, layout } = THEME;

  // Logo target box (top-left anchored)
  const logoX = margins.left;
  const logoY = THEME.page.height - margins.top - layout.logo.h;

  if (logoBytes) {
    const logoImage = await pdfDoc.embedPng(logoBytes);

    // fit-to-box (maintain aspect)
    const naturalW = logoImage.width;
    const naturalH = logoImage.height;
    const scale = Math.min(layout.logo.w / naturalW, layout.logo.h / naturalH);
    const drawW = naturalW * scale;
    const drawH = naturalH * scale;

    // draw (bottom-left coords)
    page.drawImage(logoImage, {
      x: logoX,
      y: logoY,
      width: drawW,
      height: drawH,
    });
  } else {
    // fallback rectangle if no PNG found
    page.drawRectangle({
      x: logoX,
      y: logoY,
      width: layout.logo.w,
      height: layout.logo.h,
      color: colours.logoBox,
      borderColor: colours.tableGrid,
      borderWidth: 1
    });
  }

  const h1Y = THEME.page.height - margins.top - layout.logo.h - 18;
  page.drawText('UTS Startups Incubator Agreement', {
    x: margins.left, y: h1Y, size: f.h1, font: fonts.bold, color: colours.text
  });
  page.drawText('Agreement Details', {
    x: margins.left, y: h1Y - f.h1 - 6, size: f.h2, font: fonts.bold, color: colours.text
  });

  return h1Y - f.h1 - f.h2 - 6; // table top Y
}

function drawTable(page, fonts, data, tableTopY) {
  const { layout, colours, fonts: f } = THEME;
  const { tableColWidths: colW, rowHeights: rowH, pad, headerPad, lineGap } = layout;
  const originX = THEME.margins.left;
  const totalW = colW.reduce((a,b)=>a+b,0);
  const colX = (c) => originX + colW.slice(0,c).reduce((a,b)=>a+b,0);

  const rowTops = [tableTopY];
  for (let i = 0; i < rowH.length; i++) rowTops.push(rowTops[i] - rowH[i]);
  const rowTop = (r) => rowTops[r];
  const rowBottom = (r) => rowTops[r + 1];

  // backgrounds
  const headerRows = new Set([0, 3]);
  for (let r = 0; r < rowH.length; r++) {
    const top = rowTop(r), bottom = rowBottom(r);
    const isHeader = headerRows.has(r);
    const alt = r % 2 === 1 && !isHeader;
    const fill = isHeader ? colours.tableHeaderFill : (alt ? colours.cellFillAlt : undefined);
    if (fill) {
      page.drawRectangle({
        x: originX, y: bottom, width: totalW, height: top - bottom,
        color: fill,
      });
    }
  }

  // grid
  const stroke = { thickness: 0.7, color: colours.tableGrid };
  const tableBottomY = rowBottom(rowH.length - 1);
  page.drawLine({ start: { x: originX, y: tableTopY }, end: { x: originX + totalW, y: tableTopY }, ...stroke });
  page.drawLine({ start: { x: originX, y: tableBottomY }, end: { x: originX + totalW, y: tableBottomY }, ...stroke });

  let x = originX;
  for (let c = 0; c < colW.length; c++) {
    page.drawLine({ start: { x, y: tableBottomY }, end: { x, y: tableTopY }, ...stroke });
    x += colW[c];
  }
  page.drawLine({ start: { x: originX + totalW, y: tableBottomY }, end: { x: originX + totalW, y: tableTopY }, ...stroke });
  for (let r = 0; r < rowH.length - 1; r++) {
    const y = rowBottom(r);
    page.drawLine({ start: { x: originX, y }, end: { x: originX + totalW, y }, ...stroke });
  }

  // Row 0 header
  {
    const y = rowTop(0) - headerPad - 2;
    page.drawText('Item',    { x: colX(0)+headerPad, y: y-pad, size: f.base, font: fonts.bold, color: colours.tableHeaderText });
    page.drawText('Parties', { x: colX(1)+headerPad, y: y-pad, size: f.base, font: fonts.bold, color: colours.tableHeaderText });
  }

  // Row 1 Licensee
  {
    const r=1, top=rowTop(r), y=top - pad - 2;
    page.drawText('1.', { x: colX(0)+pad, y: y-pad, size: f.base, font: fonts.bold, color: colours.text });
    drawWrappedText(page,{ x: colX(1)+pad, y: y-pad, width: colW[1]-2*pad, text:'Licensee', font: fonts.bold, size:f.base, colour:colours.text, lineGap });
    drawWrappedText(page,{ x: colX(1)+pad, y: y-THEME.layout.lineGap-THEME.fonts.small-pad, width: colW[1]-2*pad, text:'(referred to as “you” or “your”)', font: fonts.base, size:f.base, colour:colours.text, lineGap });
    drawWrappedText(page,{ x: colX(2)+pad, y: y-pad, width: colW[2]-2*pad, text: data.licenceeBlock, font: fonts.base, size:f.base, colour:colours.text, lineGap });
  }

  // Row 2 UTS
  {
    const r=2, top=rowTop(r), y=top - pad - 2;
    page.drawText('UTS', { x: colX(1)+pad, y:y-pad, size: f.base, font: fonts.bold, color: colours.text });
    drawWrappedText(page,{ x: colX(2)+pad, y:y-pad, width: colW[2]-2*pad, text: data.utsBlock, font: fonts.base, size:f.base, colour:colours.text, lineGap });
  }

  // Row 3 Details band
  {
    const y = rowTop(3) - headerPad - 2;
    page.drawText('Details', { x: colX(1)+headerPad, y: y-pad, size: f.base, font: fonts.bold, color: colours.tableHeaderText });
  }

  // Row 4 Commencement Date
  {
    const r=4, top=rowTop(r), y=top - pad - 2;
    page.drawText('2.', { x: colX(0)+pad, y: y-pad, size: f.base, font: fonts.bold, color: colours.text });
    drawWrappedText(page,{ x: colX(1)+pad, y: y-pad, width: colW[1]-2*pad, text:"Commencement Date", font:fonts.bold, size:f.base, colour: colours.text });
    page.drawText(data.commencementDate, { x: colX(2)+pad, y: y-pad, size:f.base, font:fonts.base, color: colours.text });
  }

  // Row 5 Membership & Fee (holistic, aligned, no overlap)
  {
    const r = 5;
    const top = rowTop(r);
    const yTop = top - pad - 2;
    const leftX  = colX(1) + pad;
    const rightX = colX(2) + pad;
    const leftW  = colW[1] - 2 * pad;
    const rightW = colW[2] - 2 * pad;

    page.drawText('3.', { x: colX(0) + pad, y: yTop - pad, size: f.base, font: fonts.bold, color: colours.text });

    // 1) Main heading
    let yCursor = drawWrappedText(page, {
      x: leftX, y: yTop - pad, width: leftW,
      text: 'Membership type and Fee',
      font: fonts.bold, size: f.base, colour: colours.text, lineGap
    });

    // 2) Pair A: label + content aligned on the same baseline
    const pairA_Y = yCursor - 10;
    const yAfterLabelA = drawWrappedText(page, {
      x: leftX, y: pairA_Y , width: leftW,
      text: 'Number and type of Memberships',
      font: fonts.base, size: f.base, colour: colours.text, lineGap
    });
    const yAfterContentA = drawWrappedText(page, {
      x: rightX, y: pairA_Y, width: rightW,
      text: data.membershipCopy,
      font: fonts.base, size: f.base, colour: colours.text, lineGap
    });

    // 3) Pair B starts directly below the taller of Pair A (ensures no overlap)
    const pairB_Y = Math.min(yAfterLabelA, yAfterContentA) - 10;
    drawWrappedText(page, { x: leftX,  y: pairB_Y, width: leftW,  text: 'Fee',           font: fonts.base, size: f.base, colour: colours.text, lineGap });
    drawWrappedText(page, { x: rightX, y: pairB_Y, width: rightW, text: data.monthlyFee, font: fonts.base, size: f.base, colour: colours.text, lineGap });
  }

  // Row 6 Nominated Personnel
  {
    const r=6, top=rowTop(r), y=top - pad - 2;
    page.drawText('4.', { x: colX(0)+pad, y: y-pad, size: f.base, font: fonts.bold, color: colours.text });
    drawWrappedText(page,{ x: colX(1)+pad, y: y-pad, width: colW[1]-2*pad, text:'Nominated Personnel', font: fonts.bold, size:f.base, colour:colours.text, lineGap });
    drawWrappedText(page,{ x: colX(2)+pad, y: y-pad, width: colW[2]-2*pad, text: data.personnel, font: fonts.base, size:f.base, colour:colours.text, lineGap });
  }

  // Row 7 Insurance
  {
    const r=7, top=rowTop(r), y=top - pad - 2;
    page.drawText('5.', { x: colX(0)+pad, y: y-pad, size: f.base, font: fonts.bold, color: colours.text });
    drawWrappedText(page,{ x: colX(1)+pad, y: y-pad, width: colW[1]-2*pad, text:'Public Liability Insurance', font: fonts.bold, size:f.base, colour:colours.text, lineGap });
    drawWrappedText(page,{ x: colX(2)+pad, y: y-pad, width: colW[2]-2*pad, text: data.insurance, font: fonts.base, size:f.base, colour:colours.text, lineGap });
  }

  return rowTop(rowH.length); // bottom Y of table
}

function drawBoilerplate(pdfDoc, page, fonts, yStart, termsUrl) {
  const { margins, fonts: f, colours, layout } = THEME;

  const para =
   'The UTS Startups Incubator Agreement is entered into between you and UTS and comprises of, ' +
   'in order of precedence: these Agreement Details, the UTS Startups Incubator Terms and Conditions ' +
   'and any documents attached to these Agreement Details.';

  const x = margins.left;
  const w = THEME.page.width - margins.left - margins.right;

  // Draw as before
  const firstBaselineY = yStart - 8;
  const afterY = drawWrappedText(page, {
    x, y: firstBaselineY, width: w,
    text: para, font: fonts.base, size: f.base, colour: colours.text, lineGap: layout.lineGap
  });

  // Add a link annotation that sits exactly over the phrase, even if it wraps
  const target = 'UTS Startups Incubator Terms and Conditions';
  if (termsUrl) {
    addInlineLinkOverText(pdfDoc, page, {
      xLeft: x,
      baselineY: firstBaselineY,
      maxWidth: w,
      lineGap: layout.lineGap,
      font: fonts.base,
      size: f.base,
      fullText: para,
      targetText: target,
      url: termsUrl,
    });
  }

  return afterY;
}

/* -------------------------- FORM FIELDS & SIGNATURES -------------------------- */
function addSignatureFieldWidget(pdfDoc, page, fieldName, rect) {
  const form = pdfDoc.getForm();

  // Preferred (modern pdf-lib)
  if (typeof form.createSignature === 'function') {
    const sig = form.createSignature(fieldName);
    sig.addToPage(page, {
      x: rect[0], y: rect[1],
      width: rect[2] - rect[0], height: rect[3] - rect[1],
    });
    return;
  }

  // Fallback: low-level widget + field wiring
  const context = pdfDoc.context;

  let acroForm = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  if (!acroForm) {
    const acroFormDict = context.obj({ Fields: context.obj([]), SigFlags: PDFNumber.of(3) });
    const acroFormRef = context.register(acroFormDict);
    pdfDoc.catalog.set(PDFName.of('AcroForm'), acroFormRef);
    acroForm = acroFormDict;
  }
  const acroFormDict = pdfDoc.catalog.lookup(PDFName.of('AcroForm'));
  let fields = acroFormDict.lookup(PDFName.of('Fields'));
  if (!fields) {
    fields = context.obj([]);
    acroFormDict.set(PDFName.of('Fields'), fields);
  }

  const widget = context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Widget'),
    FT: PDFName.of('Sig'),
    Rect: context.obj(rect),
    P: page.ref,
    F: PDFNumber.of(4), // Print
  });
  const widgetRef = context.register(widget);

  const field = context.obj({
    FT: PDFName.of('Sig'),
    T: PDFString.of(fieldName),
    Ff: PDFNumber.of(0),
    Kids: context.obj([widgetRef]),
  });
  const fieldRef = context.register(field);

  widget.set(PDFName.of('Parent'), fieldRef);

  let annots = page.node.lookup(PDFName.of('Annots'));
  if (!annots) {
    annots = context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(widgetRef);

  fields.push(fieldRef);
}

async function drawPngInRect(pdfDoc, page, pngBytes, rect, mode = 'fit') {
  if (!pngBytes) return;
  const img = await pdfDoc.embedPng(pngBytes);
  const [x1, y1, x2, y2] = rect;
  const boxW = x2 - x1;
  const boxH = y2 - y1;

  if (mode === 'fill') {
    page.drawImage(img, { x: x1, y: y1, width: boxW, height: boxH });
    return;
  }

  // 'fit' – preserve aspect ratio and centre in the box
  const scale = Math.min(boxW / img.width, boxH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const cx = x1 + (boxW - w) / 2;
  const cy = y1 + (boxH - h) / 2;
  page.drawImage(img, { x: cx, y: cy, width: w, height: h });
}

function addStyledTextField(form, page, name, label, rect, options = {}) {
  const [x1, y1, x2, y2] = rect;
  const x = x1, y = y1, width = x2 - x1, height = y2 - y1;

  const {
    labelFont, labelSize = THEME.fonts.small, labelColour = THEME.colours.lightText,
    textFont,  textSize  = THEME.fonts.base,  textColour  = THEME.colours.text,
    backgroundColour = THEME.colours.panelBg,
    borderColour = THEME.colours.tableHeaderFill,
    borderWidth = 1,
    required = true,
  } = options;

  page.drawText(`${label}:`, { x, y: y + height + 4, size: labelSize, font: labelFont ?? textFont, color: labelColour });

  const f = form.createTextField(name);
  f.setText('');
  if (required && typeof f.enableRequired === 'function') f.enableRequired();
  try {
    f.setBorderWidth?.(borderWidth);
    f.setBorderColor?.(borderColour);
    f.setBackgroundColor?.(backgroundColour);
    f.setTextColor?.(textColour);
    if (textFont) f.setFont?.(textFont);
    // fixed text size for clarity; comment out if you want auto-fit
    f.setFontSize?.(textSize);
  } catch (_) { /* safe no-op on older pdf-lib */ }

  f.addToPage(page, { x, y, width, height });
  return f;
}

function drawSignaturePanels(pdfDoc, page, fonts, yStart) {
  const { margins, colours, layout, fonts: f } = THEME;
  const usableW = THEME.page.width - margins.left - margins.right;
  const colGap = layout.sigPanel.gapCols;
  const colW = (usableW - colGap) / 2;
  const panelH = layout.sigPanel.height;
  const panelY = yStart - panelH;

  // Optional panel backgrounds (uncomment to show boxes)
  // page.drawRectangle({ x: margins.left, y: panelY, width: colW, height: panelH, color: colours.panelBg, borderColor: colours.panelBorder, borderWidth: 1 });
  // page.drawRectangle({ x: margins.left + colW + colGap, y: panelY, width: colW, height: panelH, color: colours.panelBg, borderColor: colours.panelBorder, borderWidth: 1 });

  const leftX = margins.left + 8;
  const rightX = margins.left + colW + colGap + 8;
  const titleY = panelY + panelH + 12;

  page.drawText('Executed by the Licensee', { x: leftX, y: titleY, size: f.base, font: fonts.bold, color: colours.text });
  page.drawText('Executed by UTS',          { x: rightX, y: titleY, size: f.base, font: fonts.bold, color: colours.text });
  
  const sigH = layout.sigPanel.sigHeight;
  const sigW = colW - 16;
  const sigTopY = titleY - 40;

  // Licensee signature widget
  const leftRect = [leftX, sigTopY, leftX + sigW, sigTopY + sigH];
  addSignatureFieldWidget(pdfDoc, page, 'Licensee.Signature', leftRect);

  // Stylable inputs
  const tfH = layout.sigPanel.tfHeight;
  const tfGap = layout.sigPanel.tfGap;
  const tf1 = [leftX,              sigTopY - tfGap - tfH, leftX + sigW, sigTopY - tfGap];
  const tf2 = [leftX, tf1[1] - tfGap - tfH, leftX + sigW, tf1[1] - tfGap];
  const tf3 = [leftX, tf2[1] - tfGap - tfH, leftX + sigW, tf2[1] - tfGap];

  const form = pdfDoc.getForm();
  addStyledTextField(form, page, 'Licensee.Name',  'Name',  tf1, { textFont: fonts.base });
  addStyledTextField(form, page, 'Licensee.Title', 'Title', tf2, { textFont: fonts.base });
  addStyledTextField(form, page, 'Licensee.Date',  'Date',  tf3, { textFont: fonts.base });

  // Prefill the Licensee.Name field with the Representative (debtor_name) when available
  try {
    const nameField = form.getTextField('Licensee.Name');
    if (payload && typeof payload.debtor_name === 'string' && payload.debtor_name.trim()) {
      nameField.setText(payload.debtor_name.trim());
    }
  } catch (_) {}

  // UTS static labels (right column)
  const isoToday = new Date().toISOString().slice(0, 10);
  page.drawText('Name:',                      { x: rightX, y: tf1[1] + tfH + 4, size: THEME.fonts.small, font: fonts.base, color: colours.lightText });
  page.drawText('Murray Hurps',               { x: rightX, y: tf1[1] + 6,       size: THEME.fonts.small, font: fonts.base, color: colours.text });
  page.drawText('Title:',                     { x: rightX, y: tf2[1] + tfH + 4, size: THEME.fonts.small, font: fonts.base, color: colours.lightText });
  page.drawText('Director, Entrepreneurship', { x: rightX, y: tf2[1] + 6,       size: THEME.fonts.small, font: fonts.base, color: colours.text });
  page.drawText('Date:',                      { x: rightX, y: tf3[1] + tfH + 4, size: THEME.fonts.small, font: fonts.base, color: colours.lightText });
  page.drawText(isoToday,                     { x: rightX, y: tf3[1] + 6,       size: THEME.fonts.base,  font: fonts.base, color: colours.text });

  // We don't add a clickable UTS widget; the server will add a placeholder and sign it.
  const rightRect = [rightX, sigTopY, rightX + sigW, sigTopY + sigH];
  return { licenceeRect: leftRect, utsRect: rightRect, panelBottom: panelY };
}

/* -------------------------- MAIN -------------------------- */
async function main() {
  const payloadPath = process.argv[2] || path.join(process.cwd(), 'payload.json');
  const outPath = process.argv[3] || path.join(process.cwd(), 'UTS_Startups_Agreement_sig.pdf');
  const p12Path  = process.argv[4];
  const passphrase = process.argv[5] || '';

  const payload = loadPayload(payloadPath);
  const data = buildTableData(payload);

  // Build base PDF
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // Embed fonts (Arial if present, else Helvetica)
  let fonts;
  try {
    const base = baseFontBytes ? await pdfDoc.embedFont(baseFontBytes) : await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = boldFontBytes ? await pdfDoc.embedFont(boldFontBytes) : await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    fonts = { base, bold };
    if (!baseFontBytes || !boldFontBytes) {
      console.warn('ℹ️  Arial TTFs not found — falling back to Helvetica.');
    }
  } catch (e) {
    console.warn('⚠️  Failed to embed custom fonts — falling back to standard fonts:', e.message);
    fonts = {
      base: await pdfDoc.embedFont(StandardFonts.Helvetica),
      bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    };
  }

  // Compute dynamic row heights (Option B) before drawing the table
  const __savedRowHeights = [...THEME.layout.rowHeights];
  THEME.layout.rowHeights = computeDynamicRowHeights(fonts, data);

  const page = pdfDoc.addPage([THEME.page.width, THEME.page.height]);

  // Header → Table → Boilerplate
  const tableTopY = await drawHeader(pdfDoc, page, fonts);
  const tableBottomY = drawTable(page, fonts, data, tableTopY);
  // Restore fixed defaults for any later logic
  THEME.layout.rowHeights = __savedRowHeights;
  const paraY = tableBottomY - THEME.layout.sectionGap;
  const afterParaY = drawBoilerplate(pdfDoc, page, fonts, paraY, TERMS_URL);

  // Signature panels (adds Licensee /Sig widget)
  const { licenceeRect, utsRect } = drawSignaturePanels(pdfDoc, page, fonts, afterParaY - 16);

  // Drop your scanned signature PNG under "Executed by UTS" (right column), sized to the same widget box
  if (sigBytes) {
    await drawPngInRect(pdfDoc, page, sigBytes, utsRect, 'fit'); // use 'fill' for exact box stretch
  }

  // Ensure field appearances use our embedded font
  const form = pdfDoc.getForm();
  form.updateFieldAppearances?.(fonts.base);

  // Save with classic xref (robust for signing)
  let bytes = await pdfDoc.save({ useObjectStreams: false, useCompression: false });

  // Optional: add UTS placeholder and SIGN immediately with .p12
  if (p12Path && await fs.pathExists(p12Path)) {
    bytes = plainAddPlaceholder({
      pdfBuffer: Buffer.from(bytes),
      reason: 'Executed by UTS',
      contactInfo: 'murray@uts.edu.au',
      name: 'UTS.Signature',
      location: 'Sydney, AU',
      signatureLength: 26000,
    });

    const p12 = await fs.readFile(p12Path);
    const signer = new SignerP12(p12, { passphrase });
    const sp = new SignPdf();
    const signed = await sp.sign(Buffer.from(bytes), signer, { fieldName: 'UTS.Signature' });

    await fs.writeFile(outPath, signed);
    console.log(`✅ Wrote signed PDF: ${outPath}`);
  } else {
    await fs.writeFile(outPath, bytes);
    console.log(`⚠️  No P12 provided — wrote unsigned PDF: ${outPath}`);
    console.log('    Provide uts_certificate.p12 and passphrase to produce a cryptographically signed UTS field.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
