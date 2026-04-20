const { pool } = require('../db');

// ── BH Series fee schedule (MoRTH 2025-26) ────────────────
function calcBHFee(vehicleType, engineCC, fuelType) {
  let base = 0;
  const cc = parseInt(engineCC) || 0;

  if (vehicleType === '2w') {
    base = cc <= 40 ? 600 : cc <= 75 ? 1000 : 1500;
  } else if (vehicleType === '4w' || vehicleType === 'lmv') {
    base = cc <= 1000 ? 2500 : cc <= 1500 ? 3500 : 5500;
  } else if (vehicleType === '3w') {
    base = 1000;
  }

  // 50% EV concession
  if (fuelType === 'ev' || fuelType === 'hybrid') base = Math.round(base * 0.5);

  const hsrp        = 550;   // HSRP plate (avg)
  const smartCard   = 200;
  const serviceFee  = 50;
  const total       = base + hsrp + smartCard + serviceFee;

  return { base, hsrp, smartCard, serviceFee, total };
}

// ── Reference generator ────────────────────────────────────
function generateBHRef(state) {
  const stateCode = (state || 'XX').slice(0, 2).toUpperCase();
  const year      = new Date().getFullYear().toString().slice(-2);
  const seq       = (70000 + Math.floor(Math.random() * 29999));
  return `BH/${year}/${stateCode}/${seq}`;
}

// ──────────────────────────────────────────────────────────
// POST /api/bh/apply
// ──────────────────────────────────────────────────────────
async function submitApplication(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const {
      // Step 1 — eligibility
      eligibilityType,
      // Step 2 — personal
      firstName, lastName, mobile, email, aadhaar, pan,
      resState, district, pincode, city, address,
      // Step 3 — vehicle
      vehicleType, fuelType, vehicleMake, vehicleModel,
      engineCC, vehicleYear, chassisNo, engineNo,
      invoiceAmount,
      // Step 4 — employment
      orgName, employeeId, designation, officeCity,
      // Step 7 — OTP / place
      submissionPlace,
    } = req.body;

    const fullName = `${firstName || ''} ${lastName || ''}`.trim();

    // 1. Upsert user
    await conn.execute(
      `INSERT INTO users (full_name, mobile, email)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), email=VALUES(email)`,
      [fullName, mobile, email || null]
    );
    const [[userRow]] = await conn.execute(
      'SELECT id FROM users WHERE mobile = ?', [mobile]
    );
    const userId = userRow.id;

    // 2. Create vehicle record (BH = new registration, no reg_number yet)
    // Map BH vehicle types to vehicles table enum ('private','2w','commercial')
    const vehTableType = vehicleType === '2w' ? '2w'
                       : vehicleType === '3w' ? 'commercial'
                       : 'private'; // covers '4w' and 'lmv'

    const [vehResult] = await conn.execute(
      `INSERT INTO vehicles
         (user_id, reg_number, chassis_last5, engine_last5, make, model,
          reg_year, vehicle_type, fuel_type, reg_state)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        userId,
        `PENDING-${Date.now()}-${Math.floor(Math.random()*9999)}`,  // placeholder until BH number assigned
        chassisNo ? chassisNo.slice(-5) : null,
        engineNo  ? engineNo.slice(-5)  : null,
        vehicleMake  || null,
        vehicleModel || null,
        vehicleYear  || null,
        vehTableType,
        fuelType     || 'petrol',
        resState     || null,
      ]
    );
    const vehicleId = vehResult.insertId;

    // 3. Compute fees
    const fees = calcBHFee(vehicleType, engineCC, fuelType);

    // 4. Generate application ref
    const bhRef = generateBHRef(resState);

    // 5. Insert BH application
    await conn.execute(
      `INSERT INTO bh_applications
         (bh_ref, vehicle_id, user_id,
          eligibility_type,
          res_state, district, pincode, city, address,
          org_name, employee_id, designation, office_city,
          vehicle_type, fuel_type, engine_cc,
          invoice_amount_paise,
          base_fee_paise, hsrp_fee_paise, smart_card_paise,
          total_fee_paise,
          submission_place, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
      [
        bhRef, vehicleId, userId,
        eligibilityType || null,
        resState || null, district || null, pincode || null,
        city || null, address || null,
        orgName || null, employeeId || null, designation || null, officeCity || null,
        vehicleType || '4w', fuelType || 'petrol',
        parseInt(engineCC) || 0,
        Math.round((parseFloat(invoiceAmount) || 0) * 100),
        fees.base * 100, fees.hsrp * 100, fees.smartCard * 100,
        fees.total * 100,
        submissionPlace || null,
      ]
    );

    await conn.commit();
    res.status(201).json({
      success: true,
      bhRef,
      fees,
      message: 'BH Series application submitted. RTO will process in 7–10 working days.',
    });

  } catch (err) {
    await conn.rollback();
    console.error('[BH] submitApplication error:', err);
    res.status(500).json({ success: false, error: 'Submission failed. Please try again.' });
  } finally {
    conn.release();
  }
}

// ──────────────────────────────────────────────────────────
// POST /api/bh/calculate-fee
// Stateless fee calculator
// ──────────────────────────────────────────────────────────
function calculateFee(req, res) {
  try {
    const { vehicleType, engineCC, fuelType } = req.body;
    if (!vehicleType) return res.status(400).json({ success: false, error: 'vehicleType is required' });
    const fees = calcBHFee(vehicleType, engineCC, fuelType);
    res.json({ success: true, fees });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Calculation failed' });
  }
}

// ──────────────────────────────────────────────────────────
// GET /api/bh/status/:bhRef
// ──────────────────────────────────────────────────────────
async function getStatus(req, res) {
  try {
    const [[row]] = await pool.execute(
      `SELECT
         b.bh_ref, b.status, b.eligibility_type,
         b.res_state, b.org_name, b.designation,
         b.vehicle_type, b.fuel_type, b.engine_cc,
         b.base_fee_paise, b.total_fee_paise, b.created_at,
         v.make, v.model,
         u.full_name, u.mobile
       FROM bh_applications b
       LEFT JOIN vehicles v ON b.vehicle_id = v.id
       LEFT JOIN users    u ON b.user_id    = u.id
       WHERE b.bh_ref = ?`,
      [req.params.bhRef]
    );
    if (!row) return res.status(404).json({ success: false, error: 'Application not found' });
    res.json({
      success: true,
      application: {
        ...row,
        baseFee:  row.base_fee_paise  / 100,
        totalFee: row.total_fee_paise / 100,
      },
    });
  } catch (err) {
    console.error('[BH] getStatus error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
}

module.exports = { submitApplication, calculateFee, getStatus };
