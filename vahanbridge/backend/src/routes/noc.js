const express = require('express');
const { body, validationResult } = require('express-validator');
const multer  = require('multer');
const path    = require('path');
const { pool } = require('../db');
const { submitApplication, getStatus, checkExisting } = require('../controllers/nocController');

const router = express.Router();

// ── File upload config ─────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || './uploads'),
  filename:    (req, file, cb) => {
    cb(null, `${Date.now()}-${file.fieldname}${path.extname(file.originalname)}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 5) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /pdf|jpg|jpeg|png/.test(path.extname(file.originalname).toLowerCase());
    ok ? cb(null, true) : cb(new Error('Only PDF, JPG, PNG allowed.'));
  },
});

// ── Validation ─────────────────────────────────────────────
const validateNOC = [
  body('ownerName').trim().notEmpty().withMessage('Owner name is required'),
  body('mobile').trim().matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit mobile required'),
  body('regNo').trim().notEmpty().withMessage('Registration number is required'),
  body('homeState').trim().notEmpty().withMessage('Home state is required'),
  body('newState').trim().notEmpty().withMessage('Destination state is required'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ success: false, errors: errors.array() });
    }
    next();
  },
];

// ── Routes ─────────────────────────────────────────────────

// POST /api/noc/apply
router.post('/apply', validateNOC, submitApplication);

// GET /api/noc/status/:nocRef
router.get('/status/:nocRef', getStatus);

// GET /api/noc/check/:regNo
router.get('/check/:regNo', checkExisting);

// POST /api/noc/upload-docs/:applicationId
// Accepts all home-state + new-state documents in one call
const NOC_DOC_FIELDS = [
  'form28','rc','insurance','puc','idproof','addressproof',
  'taxclear','photos','loannoc',            // home state
  'newnoc','newrc','form20','form27',
  'newinsurance','newpuc','newaddress',
  'roadtax','newphotos',                    // new state
].map(name => ({ name, maxCount: 1 }));

router.post(
  '/upload-docs/:applicationId',
  upload.fields(NOC_DOC_FIELDS),
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
          `INSERT INTO noc_documents (application_id, doc_type, file_name, file_path)
           VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE file_name=VALUES(file_name), file_path=VALUES(file_path)`,
          [applicationId, docType, file.originalname, file.path]
        );
        inserted.push(docType);
      }

      // Check if core home-state docs are all uploaded
      const coreRequired = ['form28','rc','insurance','puc','idproof'];
      const [existing] = await conn.execute(
        'SELECT doc_type FROM noc_documents WHERE application_id = ?',
        [applicationId]
      );
      const uploaded = new Set(existing.map(r => r.doc_type));
      const coreReady = coreRequired.every(d => uploaded.has(d));
      if (coreReady) {
        await conn.execute(
          `UPDATE noc_applications SET status='documents_uploaded' WHERE id=?`,
          [applicationId]
        );
      }

      await conn.commit();
      res.json({ success: true, uploaded: inserted, coreDocumentsReady: coreReady });
    } catch (err) {
      await conn.rollback();
      console.error('[NOC] uploadDocs error:', err);
      res.status(500).json({ success: false, error: 'Upload failed' });
    } finally {
      conn.release();
    }
  }
);

module.exports = router;
