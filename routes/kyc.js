// server/routes/kyc.js
const express = require('express');
const vision  = require('@google-cloud/vision');
const path    = require('path');
const fs      = require('fs/promises');

// 🔹 Try to load sharp, but don't crash if it's missing on live
let sharp = null;
try {
  sharp = require('sharp');
  console.log('[KYC] sharp loaded, image compression enabled');
} catch (e) {
  console.warn('[KYC] sharp not available, will save raw images only:', e.message);
}

const visionClient = new vision.ImageAnnotatorClient();

// Where to store files on disk
const KYC_UPLOAD_ROOT =
  process.env.KYC_UPLOAD_ROOT ||
  path.join(__dirname, '..', 'uploads', 'kyc'); // e.g. server/uploads/kyc

// What URL prefix the frontend will use
const KYC_PUBLIC_PREFIX =
  process.env.KYC_PUBLIC_PREFIX || '/uploads/kyc';

module.exports = function makeKycRouter(db, requireAuth) {
  const router = express.Router();

  // all KYC endpoints require auth
  router.use(requireAuth);

  // ───────────────────────── tiny helpers ─────────────────────────

  const DEBUG_KYC = process.env.DEBUG_KYC === '1';

  // ✅ per-image decoded bytes cap (prevents mobile base64 from killing server)
  const KYC_MAX_IMAGE_BYTES = Number(process.env.KYC_MAX_IMAGE_BYTES || 8_000_000); // 8MB decoded

  function pickFirst(obj, keys) {
    for (const k of keys) {
      const v = obj?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return null;
  }

  function stripDataUrlPrefix(b64) {
    if (!b64) return b64;
    // safer non-greedy prefix strip
    return String(b64).replace(/^data:[^;]+;base64,/, '');
  }

  function approxDecodedBytesFromBase64(b64) {
    const s = stripDataUrlPrefix(b64);
    const len = s.length;
    if (!len) return 0;
    let padding = 0;
    if (s.endsWith('==')) padding = 2;
    else if (s.endsWith('=')) padding = 1;
    return Math.floor((len * 3) / 4) - padding;
  }

  function base64ToBuffer(b64, label = 'IMAGE') {
    const cleaned = stripDataUrlPrefix(b64);
    const approx = approxDecodedBytesFromBase64(cleaned);

    if (approx > KYC_MAX_IMAGE_BYTES) {
      const e = new Error(`${label}_TOO_LARGE_${approx}`);
      e.statusCode = 413;
      throw e;
    }

    const buf = Buffer.from(cleaned, 'base64');
    if (!buf?.length) throw new Error(`${label}_BAD_BASE64`);
    if (buf.length > KYC_MAX_IMAGE_BYTES) {
      const e = new Error(`${label}_TOO_LARGE_${buf.length}`);
      e.statusCode = 413;
      throw e;
    }
    return buf;
  }

  function toMysqlDate(d) {
    if (!d) return null;
    const s = String(d).trim();
    if (!s) return null;

    // Allow ISO (2025-01-01T...) → keep only date
    const ymd = s.length >= 10 ? s.slice(0, 10) : s;
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;

    // ✅ Also accept OCR formats like "OCTOBER 14, 1979"
    return sanitizeDob(s);
  }

  function allowedIdType(t) {
    const v = String(t || '').trim();
    if (!v) return null;
    const ok = new Set([
      'national_id',
      'driving_licence',
      'umid',
      'postal_id',
      'passport',
      // labels (extract only):
      'voter_id',
      'company_id',
      'unknown',
    ]);
    return ok.has(v) ? v : null;
  }

  // ───────────────────────── status ─────────────────────────

  /**
   * GET /v1/kyc/status
   * Returns: { status: 'unverified' | 'pending' | 'verified' | 'rejected', rejectionReason? }
   */
  router.get('/v1/kyc/status', async (req, res, next) => {
    try {
      const userId = req.userId;

      // 1) Base user (from users table)
      const [[user]] = await db.query(
        'SELECT full_name, phone, email FROM users WHERE id=? LIMIT 1',
        [userId]
      );

      // 2) Latest KYC record (from user_kyc table)
      const [rows] = await db.query(
        `SELECT status,
                rejection_reason,
                created_at,
                updated_at,
                first_name
           FROM user_kyc
          WHERE user_id = ?
          ORDER BY id DESC
          LIMIT 1`,
        [userId]
      );

      let status = 'unverified';
      let rejectionReason = null;
      let createdAt = null;
      let updatedAt = null;
      let kycFirstName = null;

      if (rows.length) {
        const r = rows[0];
        status = r.status || 'unverified';
        rejectionReason = r.rejection_reason || null;
        createdAt = r.created_at;
        updatedAt = r.updated_at;
        kycFirstName = r.first_name || null; // 🔹 from user_kyc
      }

      return res.json({
        status,
        rejectionReason,
        createdAt,
        updatedAt,
        userFullName: user?.full_name || null, // 🔹 from users
        kycFirstName, // 🔹 from user_kyc
        phone: user?.phone || null,
        email: user?.email || null,
      });
    } catch (err) {
      next(err);
    }
  });

  // ───────────────────────── extract-id (OCR) ─────────────────────────

  /**
   * POST /v1/kyc/extract-id
   * Body: { id_type, id_image_base64 }
   * Returns:
   * { readable: boolean, full_name?, dob?, address?, id_number?, confidence?, reason?, detected_type? }
   */
  router.post('/v1/kyc/extract-id', async (req, res, next) => {
    try {
      const body = req.body || {};

      // accept both snake + camel
      const idType = pickFirst(body, ['id_type', 'idType']) || null;
      const imgB64 = pickFirst(body, ['id_image_base64', 'idImageBase64', 'idImage']) || null;

      if (!imgB64) {
        return res.status(400).json({ readable: false, error: 'NO_IMAGE' });
      }

      let imgBuf;
      try {
        imgBuf = base64ToBuffer(imgB64, 'ID_IMAGE');
      } catch (e) {
        if (e?.statusCode === 413) {
          return res.status(413).json({ readable: false, error: 'IMAGE_TOO_LARGE' });
        }
        return res.status(400).json({ readable: false, error: 'BAD_BASE64' });
      }

      let fields = null;
      try {
        fields = await extractFromIdImage(imgBuf, idType);
      } catch (e) {
        console.error('[KYC][Vision] extractFromIdImage failed:', e);
      }

      // If nothing or mismatch → not readable
      if (!fields || fields.mismatch) {
        return res.json({
          readable: false,
          full_name: null,
          dob: null,
          address: null,
          id_number: null,
          confidence: fields?.confidence || 0,
          reason: fields?.mismatch ? 'id_type_mismatch' : 'ocr_error',
          detected_type: fields?.detectedType || null,
        });
      }

      const confidence = Number(fields.confidence || 0);

      return res.json({
        readable: true,
        full_name: fields.fullName || null,
        dob: fields.birthdate || null,
        address: fields.address || null,
        id_number: fields.idNumber || null,
        confidence,
        reason: 'ok',
        detected_type: fields.detectedType || null,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * OCR helper using Google Cloud Vision.
   * Returns: {
   *   fullName, birthdate, address, idNumber,
   *   confidence (0–100),
   *   detectedType,
   *   mismatch? (true if id_type mismatch)
   * }
   */
  async function extractFromIdImage(buffer, idType) {
    const [result] = await visionClient.textDetection({
      image: { content: buffer },
    });

    const fullText = result.fullTextAnnotation?.text || '';
    const rawText = fullText.replace(/\r/g, '');
    console.log('[KYC][Vision] raw text:\n', rawText);

    if (!rawText.trim()) return null;

    // 🔍 Detect actual ID type from OCR’d text
    const detectedType = detectIdType(rawText);

    // ❌ Hard block if chosen idType doesn’t match detectedType
    if (
      idType &&
      detectedType &&
      detectedType !== 'unknown' &&
      idType !== detectedType
    ) {
      return {
        fullName: null,
        birthdate: null,
        address: null,
        idNumber: null,
        confidence: 0,
        mismatch: true,
        detectedType,
      };
    }

    // ── Pick parser based on idType / detectedType ─────────────────────
    let parsed;
    const typeForParsing = idType || detectedType;

    switch (typeForParsing) {
      case 'national_id':
        parsed = parsePhilSys(rawText);
        break;
      case 'driving_licence':
        parsed = parseDriversLicense(rawText);
        break;
      case 'umid':
        parsed = parseUmid(rawText);
        break;
      case 'postal_id':
        parsed = parsePostalId(rawText);
        break;
      case 'passport':
        parsed = parsePassport(rawText);
        break;
      default:
        parsed = parseGenericId(rawText);
    }

    // Final cleaning per field (names, dates, address, id no.)
    parsed = sanitizeParsed(parsed, typeForParsing);

    let confidence = 0.8; // default
    try {
      const page = result.fullTextAnnotation?.pages?.[0];
      if (page && typeof page.confidence === 'number') {
        confidence = page.confidence; // 0–1
      }
    } catch {
      // ignore
    }

    const confidencePercent = Math.round(confidence * 100);

    return {
      fullName: parsed.fullName || null,
      birthdate: parsed.birthdate || null,
      address: parsed.address || null,
      idNumber: parsed.idNumber || null,
      confidence: confidencePercent,
      detectedType,
    };
  }

  // ───────────────────────── common helpers ─────────────────────────

  function normalizeWhitespace(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function detectIdType(rawText) {
    const t = rawText.toUpperCase();

    // PhilSys / National ID
    if (
      t.includes('PHILIPPINE IDENTIFICATION CARD') ||
      t.includes('PAMBANSANG PAGKAKAKILANLAN') ||
      t.includes('PHILIPPINE IDENTIFICATION SYSTEM') ||
      t.includes('PHILSYS')
    ) {
      return 'national_id';
    }

    // Passport
    if (
      (t.includes('PASSPORT') || t.includes('PASAPORTE')) &&
      t.includes('REPUBLIC OF THE PHILIPPINES')
    ) {
      return 'passport';
    }

    // Postal ID
    if (
      t.includes('POSTAL IDENTITY CARD') ||
      t.includes('PHLPOST') ||
      t.includes('POSTAL ID') ||
      t.includes('POSTAL I.D')
    ) {
      return 'postal_id';
    }

    // UMID
    if (t.includes('UNIFIED MULTI-PURPOSE ID') || t.includes('UMID')) {
      return 'umid';
    }

    // Driver’s license
    if (t.includes('DRIVER') && t.includes('LICENSE')) {
      return 'driving_licence';
    }

    // Voter / company IDs (just for label)
    if (t.includes('VOTER') && t.includes('ID')) {
      return 'voter_id';
    }
    if (t.includes('COMPANY ID')) {
      return 'company_id';
    }

    return 'unknown';
  }

  // ───────────────────────── PhilSys (national_id) parser ─────────────────────────

  function parsePhilSys(rawText) {
    let fullName = null;
    let birthdate = null;
    let address = null;
    let idNumber = null;

    const clean = rawText.replace(/\r/g, '');
    const lines = clean
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // ID NUMBER – e.g. 3065-8147-6039-1851
    const idMatch = clean.match(/\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/);
    if (idMatch) {
      idNumber = idMatch[0].replace(/[^\d-]/g, '').trim();
    }

    // NAME
    const idxLastName = lines.findIndex((l) =>
      /Apelyido\/?\s*Last Name/i.test(l)
    );
    const idxGivenName = lines.findIndex((l) =>
      /Mga Pangalan\/?\s*Given Names/i.test(l)
    );
    const idxMiddleName = lines.findIndex((l) =>
      /Gitnang Apelyido\/?\s*Middle Name/i.test(l)
    );

    let last = null;
    let given = null;
    let middle = null;

    if (idxLastName >= 0 && idxLastName + 1 < lines.length) {
      last = lines[idxLastName + 1];
    }
    if (idxGivenName >= 0 && idxGivenName + 1 < lines.length) {
      given = lines[idxGivenName + 1];
    }
    if (idxMiddleName >= 0 && idxMiddleName + 1 < lines.length) {
      middle = lines[idxMiddleName + 1];
      if (/NONE/i.test(middle)) {
        middle = null;
      }
    }

    const nameParts = [];
    if (given) nameParts.push(given);
    if (middle) nameParts.push(middle);
    if (last) nameParts.push(last);
    if (nameParts.length) {
      fullName = normalizeWhitespace(nameParts.join(' '));
    }

    // DOB helpers
    const monthMap = {
      JAN: '01',
      FEB: '02',
      MAR: '03',
      APR: '04',
      MAY: '05',
      JUN: '06',
      JUL: '07',
      AUG: '08',
      SEP: '09',
      OCT: '10',
      NOV: '11',
      DEC: '12',
    };

    const parseDobLine = (line) => {
      const s = line.trim().toUpperCase();

      // 1997-01-25 or 1997/1/25
      let m = s.match(/^((?:19|20)\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
      if (m) {
        const year = m[1];
        const mm = m[2].padStart(2, '0');
        const dd = m[3].padStart(2, '0');
        return `${year}-${mm}-${dd}`;
      }

      // JANUARY 25, 1997
      m = s.match(/^([A-Z]{3,9})\s+(\d{1,2}),?\s+((?:19|20)\d{2})$/);
      if (m) {
        const day = m[2].padStart(2, '0');
        const mon3 = m[1].substring(0, 3).toUpperCase();
        const mm = monthMap[mon3] || '01';
        return `${m[3]}-${mm}-${day}`;
      }

      return null;
    };

    const isDobLike = (line) => !!parseDobLine(line);

    // DOB: search near the Date of Birth label
    const idxDobLabel = lines.findIndex((l) =>
      /Petsa ng Kapanganakan\/?\s*Date of Birth|Date of Birth/i.test(l)
    );

    if (idxDobLabel >= 0) {
      for (let i = idxDobLabel + 1; i <= idxDobLabel + 3 && i < lines.length; i++) {
        const cand = lines[i];
        if (/^PHL$/i.test(cand)) continue; // nationality line
        const parsed = parseDobLine(cand);
        if (parsed) {
          birthdate = parsed;
          break;
        }
      }
    }

    // Fallback for DOB if still not found
    if (!birthdate) {
      const m1 = clean.match(/\b([A-Z]{3,9}\s+\d{1,2},?\s+(?:19|20)\d{2})\b/);
      if (m1) {
        birthdate = parseDobLine(m1[1]) || null;
      } else {
        const m2 = clean.match(/\b((?:19|20)\d{2}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/);
        if (m2) {
          birthdate = parseDobLine(m2[1]) || null;
        }
      }
    }

    // ADDRESS
    const idxAddrLabel = lines.findIndex((l) => /Tirahan\/Address/i.test(l));

    if (idxAddrLabel >= 0) {
      const acc = [];
      for (let i = idxAddrLabel + 1; i < lines.length; i++) {
        const l = lines[i];

        // skip labels / nationality / DOB
        if (/^PHL$/i.test(l)) continue;
        if (/Petsa ng Kapanganakan\/?\s*Date of Birth/i.test(l)) continue;
        if (isDobLike(l)) continue;
        if (!/[A-Za-z]/.test(l)) continue;

        acc.push(l);
      }

      if (acc.length) {
        address = normalizeWhitespace(acc.join(', '));
      }
    }

    // Fallback: last address-like line
    if (!address) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (/^PHL$/i.test(l)) continue;
        if (isDobLike(l)) continue;

        if (
          /[A-Z]/i.test(l) &&
          (l.includes(',') ||
            /\b(PUROK|BRGY|BARANGAY|CITY|PROVINCE|STREET|ROAD|PHILIPPINES|LEYTE|CEBU|DAVAO)\b/i.test(l))
        ) {
          address = normalizeWhitespace(l);
          break;
        }
      }
    }

    return { fullName, birthdate, address, idNumber };
  }

  // ───────────────────────── LTO Driver’s License parser ─────────────────────────

  function parseDriversLicense(rawText) {
    let fullName = null;
    let birthdate = null;
    let address = null;
    let idNumber = null;

    const nameBlockMatch = rawText.match(
      /Last Name\.?\s*First Name\.?\s*Middle Name\s*\n([^\n]+)/i
    );

    if (nameBlockMatch) {
      const line = nameBlockMatch[1].trim();
      const commaMatch = line.match(/^([^,]+),\s*(.+)$/);

      if (commaMatch) {
        const last = commaMatch[1].trim();
        const firstMid = commaMatch[2].trim();
        fullName = normalizeWhitespace(`${firstMid} ${last}`);
      } else {
        fullName = line;
      }
    }

    const addrMatch = rawText.match(/Address\s*\n([^\n]+)/i);
    if (addrMatch) {
      address = addrMatch[1].trim();
    }

    const dobMatch = rawText.match(
      /Date of Birth[\s\S]{0,60}?((?:19|20)\d{2}[\/\-]\d{1,2}[\/\-]\d{1,2})/i
    );
    if (dobMatch) {
      birthdate = dobMatch[1].trim();
    }

    const licenseBlockMatch = rawText.match(
      /License No\.?\s*\n(?:Expiration Date\s*\n)?([A-Z0-9\-]+)/i
    );
    if (licenseBlockMatch) {
      idNumber = licenseBlockMatch[1].trim();
    } else {
      const fallbackMatch =
        rawText.match(/\bM\d{2}-\d{2}-\d{6}\b/i) ||
        rawText.match(/\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/);
      if (fallbackMatch) {
        idNumber = fallbackMatch[0].trim();
      }
    }

    return { fullName, birthdate, address, idNumber };
  }

  // ───────────────────────── UMID / SSS ID parser ─────────────────────────

  function parseUmid(rawText) {
    if (!rawText) {
      return { fullName: null, birthdate: null, address: null, idNumber: null };
    }

    const lines = rawText
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const getAfter = (label) => {
      const idx = lines.findIndex((l) =>
        l.toUpperCase().startsWith(label.toUpperCase())
      );
      if (idx === -1 || idx + 1 >= lines.length) return null;
      return lines[idx + 1];
    };

    const surname = getAfter('SURNAME');
    const given   = getAfter('GIVEN NAME');
    const middle  = getAfter('MIDDLE NAME');

    let fullName = null;
    if (surname || given || middle) {
      const parts = [];
      if (given) parts.push(given);
      if (middle) parts.push(middle);
      if (surname) parts.push(surname);
      fullName = normalizeWhitespace(parts.join(' '));
    }

    let dob = null;
    const dobLine = lines.find((l) => /DATE OF BIRTH/i.test(l));
    if (dobLine) {
      const m = dobLine.match(/((?:19|20)\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
      if (m) {
        dob = `${m[1]}-${m[2]}-${m[3]}`;
      }
    }

    let idNumber = null;
    const crnLine = lines.find((l) => /CRN/i.test(l));
    if (crnLine) {
      const m = crnLine.match(/CRN[-\s]*([0-9\-]+)/i);
      idNumber = (m ? m[1] : crnLine.replace(/CRN[-\s]*/i, '')).trim();
    }

    let address = null;
    const addrIdx = lines.findIndex((l) => /^ADDRESS$/i.test(l));
    if (addrIdx !== -1 && addrIdx + 1 < lines.length) {
      const acc = [];
      for (let i = addrIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        acc.push(line);
        if (/PHL/i.test(line) || /\d{4,}/.test(line)) break;
      }
      address = normalizeWhitespace(acc.join(', '));
    }

    return {
      fullName: fullName || null,
      birthdate: dob || null,
      address: address || null,
      idNumber: idNumber || null,
    };
  }

  // ───────────────────────── Philippine Passport parser ─────────────────────────

  function parsePassport(rawText) {
    let fullName = null;
    let birthdate = null;
    let address = null;
    let idNumber = null;

    const lines = rawText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const monthMap = {
      JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
      JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    };

    const idxSurname = lines.findIndex((l) => /Apelyido\/Surname/i.test(l));
    const idxGiven   = lines.findIndex((l) => /Pangalan\/Given names/i.test(l));
    const idxMiddle  = lines.findIndex((l) => /Panggitnang apelyido\/Middle/i.test(l));

    let sur = null, given = null, middle = null;

    if (idxSurname >= 0 && idxSurname + 1 < lines.length) sur = lines[idxSurname + 1].trim();
    if (idxGiven   >= 0 && idxGiven   + 1 < lines.length) given = lines[idxGiven + 1].trim();
    if (idxMiddle  >= 0 && idxMiddle  + 1 < lines.length) {
      const m = lines[idxMiddle + 1].trim();
      if (!/NONE/i.test(m)) middle = m;
    }

    const nameParts = [];
    if (given) nameParts.push(given);
    if (middle) nameParts.push(middle);
    if (sur) nameParts.push(sur);
    if (nameParts.length) fullName = normalizeWhitespace(nameParts.join(' '));

    let dobLine = null;
    const idxDob = lines.findIndex((l) => /Date of birth/i.test(l));
    if (idxDob >= 0 && idxDob + 1 < lines.length) dobLine = lines[idxDob + 1].trim();
    else {
      const m = rawText.match(/\b\d{1,2}\s+[A-Z]{3}\s+(?:19|20)\d{2}\b/);
      if (m) dobLine = m[0];
    }

    if (dobLine) {
      const m = dobLine.toUpperCase().match(/^(\d{1,2})\s+([A-Z]{3})\s+((?:19|20)\d{2})$/);
      if (m) {
        const day = m[1].padStart(2, '0');
        const mon = monthMap[m[2]] || '01';
        const year = m[3];
        birthdate = `${year}-${mon}-${day}`;
      } else {
        birthdate = dobLine;
      }
    }

    const idxPlace = lines.findIndex((l) => /Lugar ng kapanganakan\/Place of birth/i.test(l));
    if (idxPlace >= 0 && idxPlace + 1 < lines.length) {
      const place = lines[idxPlace + 1].trim();
      if (place) address = normalizeWhitespace(place);
    }

    const idxPassNo = lines.findIndex((l) => /Pasaporte blg\/Passport no\.?/i.test(l));
    if (idxPassNo >= 0 && idxPassNo + 1 < lines.length) {
      idNumber = lines[idxPassNo + 1].replace(/[^A-Z0-9]/gi, '').toUpperCase();
    }

    if (!idNumber) {
      const mrzMatch = rawText.match(/\bP[0-9A-Z]{7,9}\b/);
      if (mrzMatch) idNumber = mrzMatch[0].toUpperCase();
    }

    return { fullName, birthdate, address, idNumber };
  }

  // ───────────────────────── Postal ID parser ─────────────────────────

  function parsePostalId(rawText) {
    let fullName = null;
    let birthdate = null;
    let address = null;
    let idNumber = null;

    const lines = rawText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const nameLine = lines.find(
      (l) =>
        /^[A-Z\s\.]+$/.test(l) &&
        /\s/.test(l) &&
        !l.includes('POSTAL') &&
        !l.includes('REPUBLIC') &&
        !l.includes('PHILIPPINE') &&
        !l.includes('PHLPOST')
    );
    if (nameLine) fullName = normalizeWhitespace(nameLine);

    if (nameLine) {
      const nameIdx = lines.indexOf(nameLine);
      const addressParts = [];
      for (let i = nameIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (/\b(19|20)\d{2}\b/.test(l) || /PRN/i.test(l) || /POSTAL/i.test(l) || /Date of Birth/i.test(l)) break;
        if (/[A-Za-z]/.test(l)) addressParts.push(l);
      }
      if (addressParts.length) address = normalizeWhitespace(addressParts.join(', '));
    }

    let dobLine = null;
    const dobIdx = lines.findIndex((l) => /Date of Birth/i.test(l));
    if (dobIdx >= 0 && dobIdx + 1 < lines.length) dobLine = lines[dobIdx + 1].trim();
    else {
      const m = rawText.match(/\b(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{2,4})\b/);
      if (m) dobLine = m[0];
    }

    if (dobLine) {
      const m = dobLine
        .toUpperCase()
        .replace(/^IB/, '18')
        .match(/(\d{1,2})\s+([A-Z]{3})\s+(\d{2,4})/);
      if (m) {
        const day = m[1].padStart(2, '0');
        const mon = m[2];
        let year = m[3];
        if (year.length === 2) year = `19${year}`;
        const monthMap = {
          JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
          JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
        };
        const mm = monthMap[mon] || '01';
        birthdate = `${year}-${mm}-${day}`;
      } else {
        birthdate = dobLine;
      }
    }

    const prnMatch = rawText.match(/\bPRN\s*([A-Z0-9]{6,})/i);
    if (prnMatch) idNumber = prnMatch[1].replace(/[^A-Z0-9]/gi, '').toUpperCase();

    return { fullName, birthdate, address, idNumber };
  }

  // ───────────────────────── Generic fallback parser ─────────────────────────

  function parseGenericId(rawText) {
    let fullName = null;
    let birthdate = null;
    let address = null;
    let idNumber = null;

    const nameMatch =
      rawText.match(/Name[: ]+\s*([^\n]+)/i) ||
      rawText.match(/Full Name[: ]+\s*([^\n]+)/i);
    if (nameMatch) fullName = nameMatch[1].trim();

    const dobMatch =
      rawText.match(/(Date of Birth|DOB)[: ]+\s*([^\n]+)/i) ||
      rawText.match(/((?:19|20)\d{2}[\/\-]\d{1,2}[\/\-]\d{1,2})/);
    if (dobMatch) {
      const rawDob = (dobMatch[2] || dobMatch[1]).trim();
      birthdate = rawDob;
    }

    const addrMatch =
      rawText.match(/Address[: ]+\s*([^\n]+)/i) ||
      rawText.match(/Address\s*\n([^\n]+)/i);
    if (addrMatch) address = addrMatch[1].trim();

    const idMatch =
      rawText.match(/\b[A-Z0-9]{4,}[- ]?[A-Z0-9]{4,}\b/) ||
      rawText.match(/\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/);
    if (idMatch) idNumber = idMatch[0].trim();

    return { fullName, birthdate, address, idNumber };
  }

  // ───────────────────────── Sanitizers (apply to ALL types) ─────────────────────────

  function sanitizeParsed(parsed, idType) {
    const p = parsed || {};
    return {
      fullName: sanitizeName(p.fullName),
      birthdate: sanitizeDob(p.birthdate),
      address: sanitizeAddress(p.address),
      idNumber: sanitizeIdNumber(p.idNumber, idType),
    };
  }

  function sanitizeName(name) {
    if (!name) return null;
    let s = String(name).normalize('NFKD');
    s = s.replace(/[^\p{L}\p{M}\s'.-]/gu, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s || null;
  }

  function sanitizeDob(dob) {
    if (!dob) return null;
    let s = String(dob).trim().toUpperCase();
    if (!s || s === 'PHL') return null;

    const monthMap = {
      JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
      JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    };

    let m = s.match(/^((?:19|20)\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (m) {
      const year = m[1];
      const mm = m[2].padStart(2, '0');
      const dd = m[3].padStart(2, '0');
      return `${year}-${mm}-${dd}`;
    }

    m = s.match(/^([A-Z]{3,9})\s+(\d{1,2}),?\s+((?:19|20)\d{2})$/);
    if (m) {
      const mon3 = m[1].substring(0, 3).toUpperCase();
      const day = m[2].padStart(2, '0');
      const mm = monthMap[mon3] || '01';
      return `${m[3]}-${mm}-${day}`;
    }

    m = s.match(/^(\d{1,2})\s+([A-Z]{3})\s+((?:19|20)\d{2})$/);
    if (m) {
      const day = m[1].padStart(2, '0');
      const mm = monthMap[m[2]] || '01';
      return `${m[3]}-${mm}-${day}`;
    }

    return null;
  }

  function sanitizeAddress(addr) {
    if (!addr) return null;
    let s = String(addr).normalize('NFKD');
    s = s.replace(/[^\p{L}\p{M}\p{N}\s,.\-#\/]/gu, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s || null;
  }

  function sanitizeIdNumber(id, idType) {
    if (!id) return null;
    let s = String(id).toUpperCase().trim();

    if (idType === 'national_id') s = s.replace(/[^0-9\-]/g, '');
    else s = s.replace(/[^A-Z0-9\-]/g, '');

    s = s.replace(/\-+/g, '-');
    s = s.replace(/^-|-$/g, '');
    return s || null;
  }

  // ───────────────────────── File saving helpers ─────────────────────────

  async function ensureKycDir() {
    await fs.mkdir(KYC_UPLOAD_ROOT, { recursive: true });
  }

  /**
   * Save base64 image into /uploads/kyc as compressed JPEG if possible.
   * Returns public URL string or null.
   */
  async function saveBase64KycImage(base64Str, userId, kind) {
    if (!base64Str) return null;

    let buffer;
    try {
      buffer = base64ToBuffer(base64Str, kind.toUpperCase());
    } catch (e) {
      console.warn('[KYC] Bad/large base64 image for user', userId, kind, e.message);
      throw e; // ✅ bubble up so submit can return 413
    }

    const fileName = `u${userId}-${kind}-${Date.now()}.jpg`;
    const outPath  = path.join(KYC_UPLOAD_ROOT, fileName);

    try {
      await ensureKycDir();

      if (sharp) {
        // ✅ safer sharp (prevents pixel-bomb / huge decode)
        await sharp(buffer, { failOnError: false, limitInputPixels: 25_000_000 })
          .rotate()
          .resize({
            width: 1200,
            height: 1200,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({
            quality: 80,
            mozjpeg: true,
            chromaSubsampling: '4:2:0',
          })
          .toFile(outPath);
      } else {
        await fs.writeFile(outPath, buffer);
      }
    } catch (e) {
      console.error('[KYC] saving KYC image failed', userId, kind, e);
      return null;
    }

    return `${KYC_PUBLIC_PREFIX}/${fileName}`;
  }

  // ───────────────────────── submit ─────────────────────────

  /**
   * POST /v1/kyc/submit
   * Accepts BOTH old and new bodies.
   */
  router.post('/v1/kyc/submit', async (req, res) => {
    try {
      const userId = req.userId;
      const body   = req.body || {};

      console.log('[KYC] /v1/kyc/submit user', userId, 'keys:', Object.keys(body));

      // Accept snake_case + camelCase
      const fullNameRaw = pickFirst(body, ['full_name', 'fullName', 'fullname']);
      const dobRaw      = pickFirst(body, ['dob', 'birthdate', 'birthDate', 'dateOfBirth']);
      const addressRaw  = pickFirst(body, ['address', 'addressLine', 'address_line']);
      const idTypeRaw   = pickFirst(body, ['id_type', 'idType', 'idtype']);
      const idNumRaw    = pickFirst(body, ['id_number', 'idNumber', 'idNo', 'id_no']);

      const idImageB64  = pickFirst(body, ['id_image_base64', 'idImageBase64', 'idImage']);
      const selfieB64   = pickFirst(body, ['selfie_image_base64', 'selfieImageBase64', 'selfieImage']);

      // Old field names (original API) still supported
      let firstName    = pickFirst(body, ['firstName', 'first_name']);
      let lastName     = pickFirst(body, ['lastName', 'last_name']);
      let birthdate    = pickFirst(body, ['birthdate', 'dob', 'birthDate', 'dateOfBirth']);
      let addressLine  = pickFirst(body, ['addressLine', 'address_line', 'address']);
      let idType       = pickFirst(body, ['idType', 'id_type']);
      let idNumber     = pickFirst(body, ['idNumber', 'id_number', 'idNo', 'id_no']);
      let idFrontUrl   = pickFirst(body, ['idFrontUrl', 'id_front_url']);
      let idBackUrl    = pickFirst(body, ['idBackUrl', 'id_back_url']);
      let selfieUrl    = pickFirst(body, ['selfieUrl', 'selfie_url']);

      // Map from fullName if first/last missing
      if ((!firstName || !lastName) && fullNameRaw) {
        const parts = String(fullNameRaw).trim().split(/\s+/);
        firstName = firstName || (parts[0] || '');
        lastName  = lastName  || (parts.slice(1).join(' ') || '(none)');
      }

      // Map other modern fields if missing
      birthdate   = birthdate   || dobRaw;
      addressLine = addressLine || addressRaw;
      idType      = idType      || idTypeRaw;
      idNumber    = idNumber    || idNumRaw;

      // Normalize idType + birthdate
      idType = allowedIdType(idType);
      birthdate = toMysqlDate(birthdate);

      if (!idNumber) idNumber = 'N/A';

      // Validate required fields
      if (!firstName || !lastName || !birthdate || !addressLine || !idType || !idNumber) {
        console.warn('[KYC] MISSING_FIELDS', {
          userId, firstName, lastName, birthdate, addressLine, idType, idNumber,
        });
        return res.status(400).json({
          ok: false,
          error: 'MISSING_FIELDS',
          missing: {
            firstName: !firstName,
            lastName: !lastName,
            birthdate: !birthdate,
            addressLine: !addressLine,
            idType: !idType,
            idNumber: !idNumber,
          },
        });
      }

      // Save images (✅ now can throw 413 if too large)
      if (idImageB64) {
        idFrontUrl = await saveBase64KycImage(idImageB64, userId, 'id-front');
        if (!idFrontUrl) return res.status(500).json({ ok:false, error:'ID_IMAGE_SAVE_FAILED' });
      }

      if (selfieB64) {
        selfieUrl = await saveBase64KycImage(selfieB64, userId, 'selfie');
        if (!selfieUrl) return res.status(500).json({ ok:false, error:'SELFIE_SAVE_FAILED' });
      }

      const now = new Date();

      await db.query(
        `INSERT INTO user_kyc
          (user_id, first_name, last_name, birthdate, address_line,
           id_type, id_number, id_front_url, id_back_url, selfie_url,
           status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)
         ON DUPLICATE KEY UPDATE
           first_name       = VALUES(first_name),
           last_name        = VALUES(last_name),
           birthdate        = VALUES(birthdate),
           address_line     = VALUES(address_line),
           id_type          = VALUES(id_type),
           id_number        = VALUES(id_number),
           id_front_url     = VALUES(id_front_url),
           id_back_url      = VALUES(id_back_url),
           selfie_url       = VALUES(selfie_url),
           status           = 'pending',
           rejection_reason = NULL,
           updated_at       = VALUES(updated_at)`,
        [
          userId,
          firstName,
          lastName,
          birthdate,
          addressLine,
          idType,
          idNumber,
          idFrontUrl || null,
          idBackUrl || null,
          selfieUrl || null,
          now,
          now,
        ]
      );

      return res.json({ ok: true, status: 'pending' });
    } catch (err) {
      console.error('[KYC] submit failed', err);

      // ✅ clean 413 for mobile
      if (err?.statusCode === 413 || String(err?.message || '').includes('TOO_LARGE')) {
        return res.status(413).json({
          ok: false,
          error: 'IMAGE_TOO_LARGE',
          message: err?.message || 'Image too large',
        });
      }

      const payload = {
        ok: false,
        error: 'KYC_SUBMIT_FAILED',
        message: err?.message || String(err),
      };

      if (DEBUG_KYC) {
        payload.code  = err?.code || null;
        payload.errno = err?.errno || null;
        payload.sqlState = err?.sqlState || null;
      }

      return res.status(500).json(payload);
    }
  });

  return router;
};
