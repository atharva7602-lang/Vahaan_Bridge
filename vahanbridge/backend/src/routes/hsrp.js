const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const multer  = require('multer');
const path    = require('path');
const { pool } = require('../db');
const {
  submitApplication,
  getApplicationStatus,
  getAvailableSlots,
  checkVehicle,
} = require('../controllers/hsrpController');

const router = express.Router();

// ── File upload config ────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, process.env.UPLOAD_DIR || './uploads');
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = `${Date.now()}-${file.fieldname}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 5) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /pdf|jpg|jpeg|png/;
    const ok = allowed.test(path.extname(file.originalname).toLowerCase())
            && allowed.test(file.mimetype);
    if (ok) cb(null, true);
    else    cb(new Error('Only PDF, JPG, and PNG files are allowed.'));
  },
});

// ── Validation middleware ──────────────────────────────────
const validateApplication = [
  body('ownerName').trim().notEmpty().withMessage('Owner name is required'),
  body('mobile').trim().matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit Indian mobile number'),
  body('regNo').trim().notEmpty().withMessage('Registration number is required'),
  body('apptDate').isDate().withMessage('Enter a valid appointment date'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }
    next();
  },
];

// ── Routes ────────────────────────────────────────────────

// POST /api/hsrp/apply — submit full wizard form
router.post('/apply', validateApplication, submitApplication);

// GET /api/hsrp/status/:bookingRef — track application
router.get('/status/:bookingRef', getApplicationStatus);

// GET /api/hsrp/check-slot?date=&centre= — available time slots
router.get('/check-slot', getAvailableSlots);

// GET /api/hsrp/check-vehicle/:regNo — check for existing application
router.get('/check-vehicle/:regNo', checkVehicle);

// POST /api/hsrp/upload-docs/:applicationId — upload documents
router.post(
  '/upload-docs/:applicationId',
  upload.fields([
    { name: 'rc',        maxCount: 1 },
    { name: 'idproof',   maxCount: 1 },
    { name: 'insurance', maxCount: 1 },
    { name: 'puc',       maxCount: 1 },
    { name: 'permit',    maxCount: 1 },
    { name: 'fitness',   maxCount: 1 },
  ]),
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const { applicationId } = req.params;
      const files = req.files;
      if (!files || Object.keys(files).length === 0) {
        return res.status(400).json({ success: false, error: 'No files uploaded' });
      }

      await conn.beginTransaction();
      const inserted = [];
      for (const [docType, fileArr] of Object.entries(files)) {
        const file = fileArr[0];
        await conn.execute(
          `INSERT INTO application_documents (application_id, doc_type, file_name, file_path)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE file_name=VALUES(file_name), file_path=VALUES(file_path)`,
          [applicationId, docType, file.originalname, file.path]
        );
        inserted.push(docType);
      }

      // Update application status to documents_uploaded if all required docs are in
      const requiredDocs = ['rc', 'idproof', 'insurance', 'puc'];
      const [existing] = await conn.execute(
        'SELECT doc_type FROM application_documents WHERE application_id = ?',
        [applicationId]
      );
      const uploadedTypes = new Set(existing.map(r => r.doc_type));
      const allUploaded   = requiredDocs.every(d => uploadedTypes.has(d));
      if (allUploaded) {
        await conn.execute(
          `UPDATE hsrp_applications SET status = 'documents_uploaded' WHERE id = ?`,
          [applicationId]
        );
      }

      await conn.commit();
      res.json({ success: true, uploaded: inserted, allRequiredUploaded: allUploaded });
    } catch (err) {
      await conn.rollback();
      console.error('[HSRP] uploadDocs error:', err);
      res.status(500).json({ success: false, error: 'Document upload failed' });
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
