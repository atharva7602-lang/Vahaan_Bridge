const { pool } = require('../db');

// ── State-wise road tax rates (% of vehicle cost) ──────────
// Used to estimate new-state tax payable
const STATE_TAX_RATES = {
  'Maharashtra':        14,
  'Karnataka':          13,
  'Tamil Nadu':         10,
  'Delhi (NCT)':        4,
  'Uttar Pradesh':       8,
  'Gujarat':             6,
  'Rajasthan':          10,
  'West Bengal':         7,
  'Telangana':          12,
  'Andhra Pradesh':     12,
  'Kerala':             10,
  'Madhya Pradesh':      8,
  'Punjab':              6,
  'Haryana':             6,
  'Bihar':               7,
  'Odisha':              6,
  'Chhattisgarh':        7,
  'Jharkhand':           7,
  'Assam':               5,
  'Uttarakhand':         6,
  'Himachal Pradesh':    4,
  'Goa':                 9,
  'Chandigarh':          3,
  'default':             8,
};

function getStateRate(state) {
  return STATE_TAX_RATES[state] || STATE_TAX_RATES['default'];
}

// ── Pro-rata refund calculation ────────────────────────────
function calcRefund(taxPaid, yearsUsed) {
  const MAX_LIFE    = 15;         // vehicle tax life in India
  const used        = Math.min(Math.max(yearsUsed, 0), MAX_LIFE);
  const usedFrac    = used / MAX_LIFE;
  const usedAmount  = Math.round(taxPaid * usedFrac);
  const refundAmt   = taxPaid - usedAmount;
  return { usedAmount, refundAmt };
}

// ──────────────────────────────────────────────────────────
// POST /api/tax/calculate
// Pure calculation — no DB write, returns refund breakdown
// ──────────────────────────────────────────────────────────
function calculate(req, res) {
  try {
    const { taxPaid, yearsUsed, prevState, newState } = req.body;

    const paid  = parseFloat(taxPaid);
    const years = parseFloat(yearsUsed);

    if (!paid || paid <= 0)  return res.status(400).json({ success: false, error: 'Invalid tax paid amount' });
    if (years < 0 || years > 15) return res.status(400).json({ success: false, error: 'Years must be 0–15' });
    if (!prevState || !newState)  return res.status(400).json({ success: false, error: 'Both states are required' });
    if (prevState === newState)   return res.status(400).json({ success: false, error: 'Previous and new state cannot be the same' });

    const { usedAmount, refundAmt } = calcRefund(paid, years);

    // Estimate new state tax using state tax rate × (tax paid / approx old rate)
    // Simplified: new_tax = paid × (new_rate / old_rate)
    const oldRate = getStateRate(prevState);
    const newRate = getStateRate(newState);
    const newStateTax = Math.round(paid * (newRate / oldRate));

    const netSavings = refundAmt - newStateTax;

    res.json({
      success: true,
      breakdown: {
        taxPaid:      paid,
        yearsUsed:    years,
        usedAmount,
        refundAmt,
        newStateTax,
        netSavings,
        refundable:   netSavings >= 0,
        prevStateRate: oldRate,
        newStateRate:  newRate,
      },
    });
  } catch (err) {
    console.error('[TAX] calculate error:', err);
    res.status(500).json({ success: false, error: 'Calculation failed' });
  }
}

// ──────────────────────────────────────────────────────────
// POST /api/tax/apply
// File a tax refund application (saves to DB)
// ──────────────────────────────────────────────────────────
async function submitApplication(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const {
      ownerName, mobile, email,
      regNo, prevState, newState,
      taxPaid, yearsUsed,
      bankAccount, ifscCode,
    } = req.body;

    // 1. Upsert user
    await conn.execute(
      `INSERT INTO users (full_name, mobile, email)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE full_name=VALUES(full_name), email=VALUES(email)`,
      [ownerName, mobile, email || null]
    );
    const [[userRow]] = await conn.execute(
      'SELECT id FROM users WHERE mobile = ?', [mobile]
    );
    const userId = userRow.id;

    // 2. Upsert vehicle (minimal — reg number is enough)
    const cleanReg = regNo.toUpperCase().replace(/[\s\-]/g, '');
    await conn.execute(
      `INSERT INTO vehicles (user_id, reg_number, reg_state)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), reg_state=VALUES(reg_state)`,
      [userId, cleanReg, prevState || null]
    );
    const [[vehicleRow]] = await conn.execute(
      'SELECT id FROM vehicles WHERE reg_number = ?', [cleanReg]
    );
    const vehicleId = vehicleRow.id;

    // 3. Calculate amounts
    const paid  = parseFloat(taxPaid)  || 0;
    const years = parseFloat(yearsUsed) || 0;
    const { usedAmount, refundAmt } = calcRefund(paid, years);
    const oldRate     = getStateRate(prevState);
    const newRate     = getStateRate(newState);
    const newStateTax = Math.round(paid * (newRate / oldRate));

    // 4. Generate ref
    const ts    = Date.now().toString(36).toUpperCase().slice(-6);
    const rand  = Math.random().toString(36).toUpperCase().slice(2, 5);
    const taxRef = `TAX-${ts}-${rand}`;

    // 5. Insert application
    await conn.execute(
      `INSERT INTO tax_refund_applications
         (tax_ref, vehicle_id, user_id,
          prev_state, new_state,
          tax_paid_paise, years_used,
          used_amount_paise, refund_amount_paise, new_state_tax_paise,
          bank_account, ifsc_code, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
      [
        taxRef, vehicleId, userId,
        prevState, newState,
        Math.round(paid * 100),       // paise
        years,
        Math.round(usedAmount * 100),
        Math.round(refundAmt * 100),
        Math.round(newStateTax * 100),
        bankAccount || null,
        ifscCode    || null,
      ]
    );

    await conn.commit();
    res.status(201).json({
      success: true,
      taxRef,
      breakdown: {
        taxPaid: paid,
        usedAmount,
        refundAmt,
        newStateTax,
        netSavings: refundAmt - newStateTax,
      },
      message: 'Tax refund application filed. Refund processed in 15–21 working days.',
    });

  } catch (err) {
    await conn.rollback();
    console.error('[TAX] submitApplication error:', err);
    res.status(500).json({ success: false, error: 'Submission failed. Please try again.' });
  } finally {
    conn.release();
  }
}

// ──────────────────────────────────────────────────────────
// GET /api/tax/status/:taxRef
// ──────────────────────────────────────────────────────────
async function getStatus(req, res) {
  try {
    const [[row]] = await pool.execute(
      `SELECT
         t.tax_ref, t.status, t.prev_state, t.new_state,
         t.tax_paid_paise, t.refund_amount_paise, t.new_state_tax_paise,
         t.years_used, t.created_at,
         v.reg_number,
         u.full_name, u.mobile
       FROM tax_refund_applications t
       LEFT JOIN vehicles v ON t.vehicle_id = v.id
       LEFT JOIN users    u ON t.user_id    = u.id
       WHERE t.tax_ref = ?`,
      [req.params.taxRef]
    );
    if (!row) return res.status(404).json({ success: false, error: 'Application not found' });

    // Convert paise back to rupees for the response
    res.json({
      success: true,
      application: {
        ...row,
        taxPaid:     row.tax_paid_paise / 100,
        refundAmt:   row.refund_amount_paise / 100,
        newStateTax: row.new_state_tax_paise / 100,
      },
    });
  } catch (err) {
    console.error('[TAX] getStatus error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
}

module.exports = { calculate, submitApplication, getStatus };
