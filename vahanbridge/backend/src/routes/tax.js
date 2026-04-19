const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const { body, validationResult } = require('express-validator');
const { calculate, submitApplication, getStatus } = require('../controllers/taxController');

const router = express.Router();

// ── File upload ───────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, process.env.UPLOAD_DIR || './uploads'),
  filename:    (req, file, cb) =>
    cb(null, `${Date.now()}-tax-doc${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 5) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /pdf|jpg|jpeg|png/.test(path.extname(file.originalname).toLowerCase());
    ok ? cb(null, true) : cb(new Error('Only PDF, JPG, PNG allowed.'));
  },
});

// ── Validation ────────────────────────────────────────────
const validateCalc = [
  body('taxPaid').isFloat({ min: 100 }).withMessage('Tax paid must be at least ₹100'),
  body('yearsUsed').isFloat({ min: 0, max: 15 }).withMessage('Years must be 0–15'),
  body('prevState').trim().notEmpty().withMessage('Previous state is required'),
  body('newState').trim().notEmpty().withMessage('New state is required'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
    next();
  },
];

const validateApply = [
  body('ownerName').trim().notEmpty().withMessage('Owner name is required'),
  body('mobile').matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit mobile required'),
  body('regNo').trim().notEmpty().withMessage('Registration number is required'),
  body('prevState').trim().notEmpty().withMessage('Previous state is required'),
  body('newState').trim().notEmpty().withMessage('New state is required'),
  body('taxPaid').isFloat({ min: 100 }).withMessage('Tax paid must be at least ₹100'),
  body('yearsUsed').isFloat({ min: 0, max: 15 }).withMessage('Years must be 0–15'),
  body('bankAccount').trim().notEmpty().withMessage('Bank account number is required'),
  body('ifscCode').trim().matches(/^[A-Z]{4}0[A-Z0-9]{6}$/).withMessage('Invalid IFSC code'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
    next();
  },
];

// ── Routes ────────────────────────────────────────────────

// POST /api/tax/calculate  — pure calculation, no DB
router.post('/calculate', validateCalc, calculate);

// POST /api/tax/apply      — file actual refund application
router.post(
  '/apply',
  upload.single('taxDoc'),   // optional receipt upload
  validateApply,
  submitApplication
);

// GET /api/tax/status/:taxRef
router.get('/status/:taxRef', getStatus);

module.exports = router;
