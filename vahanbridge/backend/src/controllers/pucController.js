const { pool } = require('../db');
const crypto = require('crypto');

// ── Mock emission readings (realistic ranges) ──────────────
function generateReadings(fuelType) {
  if (fuelType === 'ev') return { co: 0, hc: 0, co2: 0, opacity: 0 };
  if (fuelType === 'diesel') {
    return {
      co:      0,
      hc:      0,
      co2:     0,
      opacity: parseFloat((10 + Math.random() * 15).toFixed(1)), // 10–25%
    };
  }
  return {
    co:  parseFloat((0.1 + Math.random() * 0.4).toFixed(2)),   // 0.1–0.5%
    hc:  Math.floor(40 + Math.random() * 160),                  // 40–200 ppm
    co2: parseFloat((12 + Math.random() * 3).toFixed(1)),       // 12–15%
    opacity: 0,
  };
}

// ── Validity by fuel type ──────────────────────────────────
function getValidityMonths(fuelType) {
  return fuelType === 'ev' ? null : 6;
}

function getExpiryDate(months) {
  if (!months) return null;
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split('T')[0];
}

// ── Certificate number generator ──────────────────────────
function generateCertNo(state, regNo) {
  const stCode = (state || 'MH').slice(0, 2).toUpperCase();
  const year   = new Date().getFullYear();
  const seq    = Math.floor(10000000 + Math.random() * 89999999);
  return `PUC/${stCode}/${year}/${seq}`;
}

// ── OTP store (in-memory — replace with Redis in production) ─
const otpStore = new Map(); // key: mobile, value: { otp, expiry, regNo }

// ──────────────────────────────────────────────────────────
// POST /api/puc/lookup
// Fetch PUC record for a vehicle (Step 1)
// ──────────────────────────────────────────────────────────
async function lookupVehicle(req, res) {
  try {
    const { regNo, chassisLast5, mobile, fuelType, regState } = req.body;
    if (!regNo || !chassisLast5 || !mobile) {
      return res.status(400).json({ success: false, error: 'regNo, chassisLast5 and mobile are required' });
    }

    const cleanReg = regNo.toUpperCase().replace(/[\s\-]/g, '');

    // Check DB for existing vehicle + recent PUC
    const [[vehicle]] = await pool.execute(
      `SELECT v.id, v.reg_number, v.make, v.model, v.vehicle_type, v.fuel_type, v.reg_state,
              u.full_name,
              p.cert_number, p.issued_date, p.expiry_date, p.centre_name, p.status as puc_status
       FROM vehicles v
       LEFT JOIN users u ON v.user_id = u.id
       LEFT JOIN puc_records p ON p.vehicle_id = v.id AND p.status = 'valid'
       WHERE v.reg_number = ?
       ORDER BY p.issued_date DESC LIMIT 1`,
      [cleanReg]
    );

    // Build response — use DB data if found, otherwise generate mock for demo
    const ownerName  = vehicle?.full_name  || 'Vehicle Owner';
    const vehicleClass = vehicle?.vehicle_type === '2w' ? 'Two-Wheeler' : 'LMV (Non-Transport)';
    const fuel       = vehicle?.fuel_type  || fuelType || 'petrol';
    const fuelLabel  = { petrol: 'Petrol (BS-VI)', diesel: 'Diesel (BS-VI)', cng: 'CNG (BS-VI)', ev: 'Electric (Exempt)', hybrid: 'Hybrid' }[fuel] || fuel;
    const make       = vehicle?.make       || '';
    const model      = vehicle?.model      || '';
    const state      = vehicle?.reg_state  || regState || 'MH';

    // Latest PUC info (from DB or generate fresh mock)
    const today      = new Date().toISOString().split('T')[0];
    const certNo     = vehicle?.cert_number || generateCertNo(state, cleanReg);
    const issuedDate = vehicle?.issued_date  ? vehicle.issued_date.toISOString?.()?.split('T')[0] || vehicle.issued_date : today;
    const expiryDate = vehicle?.expiry_date  ? vehicle.expiry_date.toISOString?.()?.split('T')[0] || vehicle.expiry_date : getExpiryDate(6);
    const centreName = vehicle?.centre_name  || 'Green Auto PUC Centre';
    const readings   = generateReadings(fuel);

    const isValid = fuel === 'ev' || (expiryDate && expiryDate >= today);

    res.json({
      success: true,
      found: true,
      vehicle: {
        regNo: cleanReg,
        ownerName,
        vehicleClass,
        fuel: fuelLabel,
        make,
        model,
        state,
      },
      puc: {
        certNumber:  certNo,
        issuedDate,
        expiryDate:  fuel === 'ev' ? 'N/A (EV Exempt)' : expiryDate,
        validMonths: getValidityMonths(fuel),
        status:      isValid ? 'valid' : 'expired',
        centreName,
        readings,
      },
    });

  } catch (err) {
    console.error('[PUC] lookupVehicle error:', err);
    res.status(500).json({ success: false, error: 'Lookup failed' });
  }
}

// ──────────────────────────────────────────────────────────
// POST /api/puc/send-otp
// Generate & store OTP for mobile verification (Step 2)
// ──────────────────────────────────────────────────────────
function sendOTP(req, res) {
  try {
    const { mobile, regNo } = req.body;
    if (!mobile || !/^[6-9]\d{9}$/.test(mobile)) {
      return res.status(400).json({ success: false, error: 'Valid 10-digit mobile required' });
    }

    const otp    = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = Date.now() + 10 * 60 * 1000; // 10 minutes

    otpStore.set(mobile, { otp, expiry, regNo: regNo?.toUpperCase().replace(/[\s\-]/g, '') });

    // In production: send SMS via Twilio / MSG91 / 2Factor
    // For now: log OTP (remove in production!)
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[OTP] ${mobile} → ${otp} (dev only)`);
    }

    res.json({
      success: true,
      message: `OTP sent to ${mobile.replace(/(\d{6})(\d{4})/, '******$2')}`,
      // In production: never send OTP in response. Dev-only:
      ...(process.env.NODE_ENV !== 'production' && { devOtp: otp }),
    });
  } catch (err) {
    console.error('[PUC] sendOTP error:', err);
    res.status(500).json({ success: false, error: 'OTP send failed' });
  }
}

// ──────────────────────────────────────────────────────────
// POST /api/puc/verify-otp
// Verify OTP and issue certificate record (Step 3)
// ──────────────────────────────────────────────────────────
async function verifyOTP(req, res) {
  const conn = await pool.getConnection();
  try {
    const { mobile, otp, regNo, fuelType, regState } = req.body;
    if (!mobile || !otp) {
      return res.status(400).json({ success: false, error: 'mobile and otp are required' });
    }

    const stored = otpStore.get(mobile);

    // In dev mode: accept '000000' as master OTP
    const isDev    = process.env.NODE_ENV !== 'production';
    const otpValid = stored && stored.otp === otp && Date.now() < stored.expiry;
    const masterOk = isDev && otp === '000000';

    if (!otpValid && !masterOk) {
      return res.status(401).json({ success: false, error: 'Invalid or expired OTP' });
    }

    otpStore.delete(mobile); // consume OTP

    const cleanReg = (regNo || stored?.regNo || '').toUpperCase().replace(/[\s\-]/g, '');
    const fuel     = fuelType || 'petrol';
    const state    = regState || 'MH';
    const readings = generateReadings(fuel);
    const certNo   = generateCertNo(state, cleanReg);
    const today    = new Date().toISOString().split('T')[0];
    const expiry   = fuel === 'ev' ? null : getExpiryDate(6);

    await conn.beginTransaction();

    // Upsert vehicle
    await conn.execute(
      `INSERT INTO vehicles (reg_number, fuel_type, reg_state)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE fuel_type=VALUES(fuel_type), reg_state=VALUES(reg_state)`,
      [cleanReg, fuel, state]
    );
    const [[vRow]] = await conn.execute(
      'SELECT id FROM vehicles WHERE reg_number = ?', [cleanReg]
    );
    const vehicleId = vRow.id;

    // Mark any previous valid records as superseded
    await conn.execute(
      `UPDATE puc_records SET status='expired' WHERE vehicle_id=? AND status='valid'`,
      [vehicleId]
    );

    // Insert new PUC record
    await conn.execute(
      `INSERT INTO puc_records
         (vehicle_id, cert_number, issued_date, expiry_date,
          fuel_type, co_level, hc_level, co2_level, opacity_level,
          centre_name, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        vehicleId, certNo, today, expiry,
        fuel,
        readings.co, readings.hc, readings.co2, readings.opacity,
        'Green Auto PUC Centre',
        fuel === 'ev' ? 'exempt' : 'valid',
      ]
    );

    await conn.commit();

    res.json({
      success: true,
      certificate: {
        certNumber: certNo,
        regNo:      cleanReg,
        issuedDate: today,
        expiryDate: expiry || 'N/A (EV Exempt)',
        validity:   fuel === 'ev' ? 'Exempt' : '6 Months',
        fuelType:   fuel,
        readings,
        centreName: 'Green Auto PUC Centre',
      },
    });

  } catch (err) {
    await conn.rollback();
    console.error('[PUC] verifyOTP error:', err);
    res.status(500).json({ success: false, error: 'OTP verification failed' });
  } finally {
    conn.release();
  }
}

// ──────────────────────────────────────────────────────────
// GET /api/puc/history/:regNo
// PUC history for a vehicle
// ──────────────────────────────────────────────────────────
async function getHistory(req, res) {
  try {
    const cleanReg = req.params.regNo.toUpperCase().replace(/[\s\-]/g, '');
    const [rows] = await pool.execute(
      `SELECT p.cert_number, p.issued_date, p.expiry_date,
              p.fuel_type, p.co_level, p.hc_level, p.status, p.centre_name
       FROM puc_records p
       JOIN vehicles v ON p.vehicle_id = v.id
       WHERE v.reg_number = ?
       ORDER BY p.issued_date DESC LIMIT 10`,
      [cleanReg]
    );
    res.json({ success: true, regNo: cleanReg, history: rows });
  } catch (err) {
    console.error('[PUC] getHistory error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ──────────────────────────────────────────────────────────
// GET /api/puc/centres?state=&district=
// List PUC testing centres (seeded static data)
// ──────────────────────────────────────────────────────────
async function getCentres(req, res) {
  try {
    const { state, district } = req.query;
    let query = 'SELECT * FROM puc_centres WHERE 1=1';
    const params = [];
    if (state)    { query += ' AND state = ?';    params.push(state); }
    if (district) { query += ' AND district = ?'; params.push(district); }
    query += ' ORDER BY name ASC LIMIT 20';

    const [rows] = await pool.execute(query, params);
    res.json({ success: true, centres: rows, total: rows.length });
  } catch (err) {
    console.error('[PUC] getCentres error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ──────────────────────────────────────────────────────────
// GET /api/puc/verify/:certOrReg
// Verify certificate authenticity
// ──────────────────────────────────────────────────────────
async function verifyCertificate(req, res) {
  try {
    const input   = req.params.certOrReg.toUpperCase().replace(/[\s\-]/g, '');
    const isRegNo = !input.startsWith('PUC/');

    const query = isRegNo
      ? `SELECT p.*, v.reg_number, v.make, v.model
         FROM puc_records p JOIN vehicles v ON p.vehicle_id = v.id
         WHERE v.reg_number = ? AND p.status IN ('valid','exempt')
         ORDER BY p.issued_date DESC LIMIT 1`
      : `SELECT p.*, v.reg_number, v.make, v.model
         FROM puc_records p JOIN vehicles v ON p.vehicle_id = v.id
         WHERE p.cert_number = ?`;

    const [[row]] = await pool.execute(query, [isRegNo ? input : req.params.certOrReg]);

    if (!row) {
      return res.json({ success: true, verified: false, message: 'Certificate not found in database' });
    }

    const today = new Date().toISOString().split('T')[0];
    const valid = row.status === 'exempt' || (row.expiry_date && row.expiry_date >= today);

    res.json({
      success:  true,
      verified: true,
      valid,
      certificate: {
        certNumber:  row.cert_number,
        regNo:       row.reg_number,
        issuedDate:  row.issued_date,
        expiryDate:  row.expiry_date,
        status:      valid ? 'valid' : 'expired',
        coLevel:     row.co_level,
        hcLevel:     row.hc_level,
        centreName:  row.centre_name,
      },
    });
  } catch (err) {
    console.error('[PUC] verifyCertificate error:', err);
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
}

module.exports = { lookupVehicle, sendOTP, verifyOTP, getHistory, getCentres, verifyCertificate };
