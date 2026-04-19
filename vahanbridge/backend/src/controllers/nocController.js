const { pool } = require('../db');

// ── Helper: generate reference ─────────────────────────────
function generateNOCRef() {
  const ts   = Date.now().toString(36).toUpperCase().slice(-6);
  const rand = Math.random().toString(36).toUpperCase().slice(2, 5);
  return `NOC-${ts}-${rand}`;
}

// ──────────────────────────────────────────────────────────
// POST /api/noc/apply
// ──────────────────────────────────────────────────────────
async function submitApplication(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const {
      ownerName, aadhaar, mobile, email,
      regNo, engineNo, chassisNo, vehicleModel,
      homeState, newState, reason,
      vehicleType,
    } = req.body;

    // 1. Upsert user
    await conn.execute(
      `INSERT INTO users (full_name, mobile, email)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), email=VALUES(email)`,
      [ownerName, mobile, email || null]
    );
    const [[userRow]] = await conn.execute(
      'SELECT id FROM users WHERE mobile = ?', [mobile]
    );
    const userId = userRow.id;

    // 2. Upsert vehicle
    const cleanReg = regNo.toUpperCase().replace(/[\s\-]/g, '');
    await conn.execute(
      `INSERT INTO vehicles
         (user_id, reg_number, engine_last5, chassis_last5, model, vehicle_type, reg_state)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id=VALUES(user_id), engine_last5=VALUES(engine_last5),
         model=VALUES(model), vehicle_type=VALUES(vehicle_type)`,
      [
        userId, cleanReg,
        engineNo  ? engineNo.slice(-5)  : null,
        chassisNo ? chassisNo.slice(-5) : null,
        vehicleModel || null,
        vehicleType  || 'private',
        homeState    || null,
      ]
    );
    const [[vehicleRow]] = await conn.execute(
      'SELECT id FROM vehicles WHERE reg_number = ?', [cleanReg]
    );
    const vehicleId = vehicleRow.id;

    // 3. Create NOC application
    const nocRef = generateNOCRef();
    await conn.execute(
      `INSERT INTO noc_applications
         (noc_ref, vehicle_id, user_id,
          home_state, new_state, transfer_reason,
          vehicle_type, status)
       VALUES (?,?,?,?,?,?,?,'pending')`,
      [nocRef, vehicleId, userId, homeState, newState, reason || null, vehicleType || 'car']
    );

    await conn.commit();
    res.status(201).json({
      success: true,
      nocRef,
      message: 'NOC application submitted. Visit your Home State RTO with original documents.',
    });

  } catch (err) {
    await conn.rollback();
    console.error('[NOC] submitApplication error:', err);
    res.status(500).json({ success: false, error: 'Submission failed. Please try again.' });
  } finally {
    conn.release();
  }
}

// ──────────────────────────────────────────────────────────
// GET /api/noc/status/:nocRef
// ──────────────────────────────────────────────────────────
async function getStatus(req, res) {
  try {
    const [[row]] = await pool.execute(
      `SELECT
         n.noc_ref, n.status, n.home_state, n.new_state,
         n.transfer_reason, n.created_at,
         v.reg_number, v.model, v.vehicle_type,
         u.full_name, u.mobile
       FROM noc_applications n
       LEFT JOIN vehicles v ON n.vehicle_id = v.id
       LEFT JOIN users    u ON n.user_id    = u.id
       WHERE n.noc_ref = ?`,
      [req.params.nocRef]
    );
    if (!row) return res.status(404).json({ success: false, error: 'Application not found' });
    res.json({ success: true, application: row });
  } catch (err) {
    console.error('[NOC] getStatus error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ──────────────────────────────────────────────────────────
// GET /api/noc/check/:regNo
// Check for existing active NOC application
// ──────────────────────────────────────────────────────────
async function checkExisting(req, res) {
  try {
    const regNo = req.params.regNo.toUpperCase().replace(/[\s\-]/g, '');
    const [[row]] = await pool.execute(
      `SELECT n.noc_ref, n.status, n.home_state, n.new_state
       FROM noc_applications n
       JOIN vehicles v ON n.vehicle_id = v.id
       WHERE v.reg_number = ? AND n.status NOT IN ('completed','cancelled')
       ORDER BY n.created_at DESC LIMIT 1`,
      [regNo]
    );
    if (row) {
      return res.json({
        success: true,
        hasActiveApplication: true,
        nocRef: row.noc_ref,
        status: row.status,
        homeState: row.home_state,
        newState: row.new_state,
      });
    }
    res.json({ success: true, hasActiveApplication: false });
  } catch (err) {
    console.error('[NOC] checkExisting error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
}

module.exports = { submitApplication, getStatus, checkExisting };
