const express = require('express');
const { body, validationResult } = require('express-validator');
const { lookupVehicle, sendOTP, verifyOTP, saveCertificate, getHistory, getCentres, verifyCertificate } = require('../controllers/pucController');

const router = express.Router();

// ── Validation helpers ────────────────────────────────────
const validateLookup = [
  body('regNo').trim().notEmpty().withMessage('Registration number required'),
  body('chassisLast5').trim().notEmpty().withMessage('Chassis last 5 digits required'),
  body('mobile').matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit mobile required'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
    next();
  },
];

const validateOTPSend = [
  body('mobile').matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit mobile required'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
    next();
  },
];

const validateOTPVerify = [
  body('mobile').matches(/^[6-9]\d{9}$/).withMessage('Valid 10-digit mobile required'),
  body('otp').isLength({ min: 4, max: 6 }).withMessage('OTP must be 4–6 digits'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
    next();
  },
];

// ── Routes ────────────────────────────────────────────────

// POST /api/puc/lookup         — Step 1: fetch vehicle + PUC record
router.post('/lookup', validateLookup, lookupVehicle);

// POST /api/puc/send-otp       — Step 2a: send OTP to mobile
router.post('/send-otp', validateOTPSend, sendOTP);

// POST /api/puc/verify-otp     — Step 2b: verify OTP + create certificate record
router.post('/verify-otp', validateOTPVerify, verifyOTP);

// GET  /api/puc/history/:regNo — PUC history for a vehicle
router.get('/history/:regNo', getHistory);

// GET  /api/puc/centres        — List testing centres by state/district
router.get('/centres', getCentres);

// GET  /api/puc/verify/:input  — Verify certificate by cert number or reg number
router.get('/verify/:certOrReg', verifyCertificate);


// POST /api/puc/save  — save certificate directly without OTP
router.post('/save',
  [
    body('regNo').trim().notEmpty().withMessage('Registration number required'),
    (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
      next();
    },
  ],
  saveCertificate
);

module.exports = router;
