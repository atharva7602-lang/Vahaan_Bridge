const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');

// ── Helper: generate booking reference ────────────────────
function generateBookingRef() {
  const ts = Date.now().toString(36).toUpperCase().slice(-6);
  const rand = Math.random().toString(36).toUpperCase().slice(2, 6);
  return `HSRP-${ts}-${rand}`;
}

// ── Helper: fee calculator ─────────────────────────────────
function calculateFees(vehicleType, fitmentMode) {
  const plateFee   = vehicleType === '2w' ? 350 : vehicleType === 'commercial' ? 600 : 450;
  const stickerFee = 100;
  const fitmentFee = fitmentMode === 'doorstep' ? 200 : 0;
  return {
    plateFee,
    stickerFee,
    fitmentFee,
    totalFee: plateFee + stickerFee + fitmentFee,
    // also store in paise for the DB
    platePaise:   plateFee   * 100,
    stickerPaise: stickerFee * 100,
    fitmentPaise: fitmentFee * 100,
    totalPaise:   (plateFee + stickerFee + fitmentFee) * 100,
  };
}

// ──────────────────────────────────────────────────────────
// POST /api/hsrp/apply
// Body: full wizard form data (all 5 steps merged)
// ──────────────────────────────────────────────────────────
async function submitApplication(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const {
      // Step 1 - vehicle & owner
      ownerName, mobile, email,
      regNo, chassisNo, engineNo, regYear,
      vehicleType, fuelType, regState, vehicleMake, vehicleModel,
      // Step 2 - plate details
      plateSet, specialReq, notes,
      // Step 3 - appointment
      fitmentMode, rtoCentre, doorstepAddress, apptDate, apptSlot,
    } = req.body;

    // 1. Upsert user
    const [userRows] = await conn.execute(
      `INSERT INTO users (full_name, mobile, email)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), email = VALUES(email)`,
      [ownerName, mobile, email || null]
    );
    // Get user id (insert or existing)
    const [[userRow]] = await conn.execute(
      'SELECT id FROM users WHERE mobile = ?', [mobile]
    );
    const userId = userRow.id;

    // 2. Upsert vehicle
    await conn.execute(
      `INSERT INTO vehicles
         (user_id, reg_number, chassis_last5, engine_last5, make, model,
          reg_year, vehicle_type, fuel_type, reg_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id=VALUES(user_id), chassis_last5=VALUES(chassis_last5),
         make=VALUES(make), model=VALUES(model), fuel_type=VALUES(fuel_type)`,
      [
        userId,
        regNo.toUpperCase().replace(/\s+/g, ''),
        chassisNo || null,
        engineNo  || null,
        vehicleMake  || null,
        vehicleModel || null,
        regYear      || null,
        vehicleType  || 'private',
        fuelType     || 'petrol',
        regState     || null,
      ]
    );
    const [[vehicleRow]] = await conn.execute(
      'SELECT id FROM vehicles WHERE reg_number = ?',
      [regNo.toUpperCase().replace(/\s+/g, '')]
    );
    const vehicleId = vehicleRow.id;

    // 3. Compute fees
    const fees = calculateFees(vehicleType || 'private', fitmentMode || 'centre');

    // 4. Create HSRP application
    const bookingRef = generateBookingRef();
    await conn.execute(
      `INSERT INTO hsrp_applications
         (booking_ref, vehicle_id, user_id,
          plate_set, special_req, notes,
          fitment_mode, rto_centre, doorstep_address, appt_date, appt_slot,
          plate_fee_paise, sticker_fee_paise, fitment_fee_paise, total_fee_paise,
          status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
      [
        bookingRef, vehicleId, userId,
        plateSet    || 'both',
        specialReq  || null,
        notes       || null,
        fitmentMode || 'centre',
        rtoCentre   || null,
        doorstepAddress || null,
        apptDate    || null,
        apptSlot    || null,
        fees.platePaise, fees.stickerPaise, fees.fitmentPaise, fees.totalPaise,
      ]
    );

    await conn.commit();

    res.status(201).json({
      success: true,
      bookingRef,
      fees: {
        plate:   fees.plateFee,
        sticker: fees.stickerFee,
        fitment: fees.fitmentFee,
        total:   fees.totalFee,
      },
      message: 'HSRP application submitted successfully. Check SMS/email for confirmation.',
    });

  } catch (err) {
    await conn.rollback();
    console.error('[HSRP] submitApplication error:', err);
    res.status(500).json({ success: false, error: 'Application submission failed. Please try again.' });
  } finally {
    conn.release();
  }
}

// ──────────────────────────────────────────────────────────
// GET /api/hsrp/status/:bookingRef
// ──────────────────────────────────────────────────────────
async function getApplicationStatus(req, res) {
  try {
    const { bookingRef } = req.params;
    const [[row]] = await pool.execute(
      `SELECT
         h.booking_ref, h.status, h.payment_status, h.appt_date, h.appt_slot,
         h.rto_centre, h.fitment_mode, h.total_fee_paise,
         v.reg_number, v.make, v.model, v.vehicle_type,
         u.full_name, u.mobile
       FROM hsrp_applications h
       LEFT JOIN vehicles v ON h.vehicle_id = v.id
       LEFT JOIN users    u ON h.user_id    = u.id
       WHERE h.booking_ref = ?`,
      [bookingRef]
    );
    if (!row) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    res.json({
      success: true,
      application: {
        ...row,
        total_fee: row.total_fee_paise / 100,
      },
    });
  } catch (err) {
    console.error('[HSRP] getStatus error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ──────────────────────────────────────────────────────────
// GET /api/hsrp/check-slot?date=YYYY-MM-DD&centre=RTO+Name
// Returns available slots for a given date + centre
// ──────────────────────────────────────────────────────────
async function getAvailableSlots(req, res) {
  try {
    const { date, centre } = req.query;
    if (!date || !centre) {
      return res.status(400).json({ success: false, error: 'date and centre are required' });
    }

    // Get booked slots for this date + centre
    const [booked] = await pool.execute(
      `SELECT appt_slot FROM hsrp_applications
       WHERE appt_date = ? AND rto_centre = ? AND status != 'cancelled'`,
      [date, centre]
    );
    const bookedSlots = new Set(booked.map(r => r.appt_slot));

    const ALL_MORNING   = ['9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM','12:00 PM','12:30 PM'];
    const ALL_AFTERNOON = ['2:00 PM','2:30 PM','3:00 PM','3:30 PM','4:00 PM','4:30 PM'];
    const ALL_SLOTS = [...ALL_MORNING, ...ALL_AFTERNOON];

    const slots = ALL_SLOTS.map(slot => ({
      slot,
      available: !bookedSlots.has(slot),
    }));

    res.json({ success: true, date, centre, slots });
  } catch (err) {
    console.error('[HSRP] getAvailableSlots error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ──────────────────────────────────────────────────────────
// GET /api/hsrp/check-vehicle/:regNo
// Check if vehicle already has an active HSRP application
// ──────────────────────────────────────────────────────────
async function checkVehicle(req, res) {
  try {
    const regNo = req.params.regNo.toUpperCase().replace(/\s+/g, '');
    const [[row]] = await pool.execute(
      `SELECT h.booking_ref, h.status, h.appt_date
       FROM hsrp_applications h
       JOIN vehicles v ON h.vehicle_id = v.id
       WHERE v.reg_number = ? AND h.status NOT IN ('cancelled','fitted')
       ORDER BY h.created_at DESC LIMIT 1`,
      [regNo]
    );
    if (row) {
      return res.json({
        success: true,
        hasActiveApplication: true,
        bookingRef: row.booking_ref,
        status: row.status,
        apptDate: row.appt_date,
      });
    }
    res.json({ success: true, hasActiveApplication: false });
  } catch (err) {
    console.error('[HSRP] checkVehicle error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
}

module.exports = { submitApplication, getApplicationStatus, getAvailableSlots, checkVehicle };
