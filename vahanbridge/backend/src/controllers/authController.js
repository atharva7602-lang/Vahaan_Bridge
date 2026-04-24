const { pool } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'vahanbridge_super_secret_key_123';

// ── Register User ──────────────────────────────────────────
async function register(req, res) {
  try {
    const { fullName, email, mobile, password } = req.body;

    if (!fullName || !email || !mobile || !password) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    // Check if user already exists
    const [[existing]] = await pool.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existing) {
      return res.status(400).json({ success: false, error: 'User with this email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert user
    const [result] = await pool.execute(
      `INSERT INTO users (full_name, mobile, email, password) VALUES (?, ?, ?, ?)`,
      [fullName, mobile, email, hashedPassword]
    );

    const userId = result.insertId;

    // Create JWT
    const token = jwt.sign({ userId, email, fullName }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      success: true,
      token,
      user: { id: userId, fullName, email, mobile },
      message: 'Registration successful'
    });
  } catch (err) {
    console.error('[AUTH] register error:', err);
    res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
  }
}

// ── Login User ─────────────────────────────────────────────
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    // Find user
    const [[user]] = await pool.execute(
      'SELECT id, full_name, mobile, email, password FROM users WHERE email = ?',
      [email]
    );

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    if (!user.password) {
      return res.status(401).json({ success: false, error: 'Please reset your password or register again (old account)' });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    // Create JWT
    const token = jwt.sign({ userId: user.id, email: user.email, fullName: user.full_name }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      success: true,
      token,
      user: { id: user.id, fullName: user.full_name, email: user.email, mobile: user.mobile },
      message: 'Login successful'
    });
  } catch (err) {
    console.error('[AUTH] login error:', err);
    res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
  }
}

// ── Get Current User ───────────────────────────────────────
async function getMe(req, res) {
  try {
    const [[user]] = await pool.execute(
      'SELECT id, full_name, mobile, email, created_at FROM users WHERE id = ?',
      [req.user.userId]
    );

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, user });
  } catch (err) {
    console.error('[AUTH] getMe error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
}

module.exports = { register, login, getMe, JWT_SECRET };
