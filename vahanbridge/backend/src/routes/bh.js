const express = require('express');
const multer  = require('multer');
const path    = require('path');
const { body, validationResult } = require('express-validator');
const { pool } = require('../db');
const { submitApplication, calculateFee, getStatus } = require('../controllers/bhController');

const router = express.Router();

// ── File upload ───────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || './uploads'),
  filename:    (req, file, cb) =>
    cb(null, `${Date.now()}-bh-${file.fieldname}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 5) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /pdf|jpg|jpeg|png/.test(path.extname(file.originalname).toLowerCase());
    ok ? cb(null, true) : cb(new Error('Only PDF, JPG, PNG allowed.'));
  },
});

// BH document fields
const BH_DOC_FIELDS = [
  'emp_cert','emp_id','aadhaar','pan','photo','dl',
  'form21','form22','insurance','puc',
  'salary_slip','noc',
].map(name => ({ name, maxCount: 1 }));

// ── Validation ────────────────────────────────────────────
const validateApply = [
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('mobile').matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit mobile required'),
  body('eligibilityType').trim().notEmpty().withMessage('Eligibility type is required'),
  body('vehicleType').trim().notEmpty().withMessage('Vehicle type is required'),
  body('resState').trim().notEmpty().withMessage('State of residence is required'),
  body('orgName').trim().notEmpty().withMessage('Organisation name is required'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
    next();
  },
];

// ── Routes ────────────────────────────────────────────────

// POST /api/bh/calculate-fee  — stateless, no DB
router.post('/calculate-fee', calculateFee);

// POST /api/bh/apply  — full 7-step wizard submission
router.post('/apply', validateApply, submitApplication);

// GET /api/bh/status/:bhRef
router.get('/status/:bhRef', getStatus);

// POST /api/bh/upload-docs/:applicationId
router.post(
  '/upload-docs/:applicationId',
  upload.fields(BH_DOC_FIELDS),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const { applicationId } = req.params;
      const files = req.files;
      if (!files || !Object.keys(files).length) {
        return res.status(400).json({ success: false, error: 'No files uploaded' });
      }

      await conn.beginTransaction();
      const inserted = [];
      for (const [docType, fileArr] of Object.entries(files)) {
        const file = fileArr[0];
        await conn.execute(
          `INSERT INTO bh_documents (application_id, doc_type, file_name, file_path)
           VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE file_name=VALUES(file_name), file_path=VALUES(file_path)`,
          [applicationId, docType, file.originalname, file.path]
        );
        inserted.push(docType);
      }

      // Check if all 10 required docs are uploaded
      const required = ['emp_cert','emp_id','aadhaar','pan','photo','dl','form21','form22','insurance','puc'];
      const [existing] = await conn.execute(
        'SELECT doc_type FROM bh_documents WHERE application_id = ?', [applicationId]
      );
      const uploaded = new Set(existing.map(r => r.doc_type));
      const allReady = required.every(d => uploaded.has(d));
      if (allReady) {
        await conn.execute(
          `UPDATE bh_applications SET status='documents_uploaded' WHERE id=?`, [applicationId]
        );
      }

      await conn.commit();
      res.json({ success: true, uploaded: inserted, allRequiredUploaded: allReady });
    } catch (err) {
      await conn.rollback();
      console.error('[BH] uploadDocs error:', err);
      res.status(500).json({ success: false, error: 'Upload failed' });
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
