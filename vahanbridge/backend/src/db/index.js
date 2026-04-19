const mysql = require('mysql2/promise');

// Create connection pool (much better than single connection for production)
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'vahanbridge',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+05:30', // IST
});

// Test connection on startup
async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log('✅ MySQL connected successfully');
    conn.release();
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    process.exit(1);
  }
}

// Create all tables if they don't exist yet
async function initSchema() {
  const conn = await pool.getConnection();
  try {
    // ── USERS TABLE ───────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        full_name   VARCHAR(150) NOT NULL,
        mobile      VARCHAR(15)  NOT NULL,
        email       VARCHAR(150),
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_mobile (mobile)
      )
    `);

    // ── VEHICLES TABLE ────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS vehicles (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        user_id         INT,
        reg_number      VARCHAR(20) NOT NULL UNIQUE,
        chassis_last5   VARCHAR(5),
        engine_last5    VARCHAR(5),
        make            VARCHAR(80),
        model           VARCHAR(80),
        reg_year        YEAR,
        vehicle_type    ENUM('private','2w','commercial') DEFAULT 'private',
        fuel_type       ENUM('petrol','diesel','cng','ev','hybrid') DEFAULT 'petrol',
        reg_state       VARCHAR(80),
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_reg (reg_number)
      )
    `);

    // ── HSRP APPLICATIONS TABLE ───────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS hsrp_applications (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        booking_ref     VARCHAR(30) NOT NULL UNIQUE,
        vehicle_id      INT,
        user_id         INT,

        -- Plate details
        plate_set       ENUM('both','front','rear') DEFAULT 'both',
        special_req     VARCHAR(100),
        notes           TEXT,

        -- Appointment
        fitment_mode    ENUM('centre','doorstep') DEFAULT 'centre',
        rto_centre      VARCHAR(150),
        doorstep_address TEXT,
        appt_date       DATE,
        appt_slot       VARCHAR(20),

        -- Fees (in paise to avoid float issues)
        plate_fee_paise     INT DEFAULT 45000,
        sticker_fee_paise   INT DEFAULT 10000,
        fitment_fee_paise   INT DEFAULT 0,
        total_fee_paise     INT DEFAULT 55000,

        -- Status
        status          ENUM('pending','confirmed','documents_uploaded','fitted','cancelled')
                        DEFAULT 'pending',

        payment_status  ENUM('unpaid','paid','refunded') DEFAULT 'unpaid',
        payment_ref     VARCHAR(100),

        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
        FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE SET NULL,
        INDEX idx_ref (booking_ref),
        INDEX idx_status (status)
      )
    `);

    // ── DOCUMENT UPLOADS TABLE ────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS application_documents (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        application_id  INT NOT NULL,
        doc_type        ENUM('rc','idproof','insurance','puc','permit','fitness') NOT NULL,
        file_name       VARCHAR(255),
        file_path       VARCHAR(500),
        uploaded_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (application_id) REFERENCES hsrp_applications(id) ON DELETE CASCADE
      )
    `);


    // ── NOC APPLICATIONS TABLE ────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS noc_applications (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        noc_ref          VARCHAR(30) NOT NULL UNIQUE,
        vehicle_id       INT,
        user_id          INT,
        home_state       VARCHAR(80),
        new_state        VARCHAR(80),
        transfer_reason  VARCHAR(150),
        vehicle_type     ENUM('car','2w','com') DEFAULT 'car',
        status           ENUM('pending','documents_uploaded','rto_processing',
                              'noc_issued','new_state_registration','completed','cancelled')
                         DEFAULT 'pending',
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
        FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE SET NULL,
        INDEX idx_noc_ref (noc_ref),
        INDEX idx_noc_status (status)
      )
    \`);

    // ── NOC DOCUMENT UPLOADS TABLE ────────────────────────
    await conn.execute(\`
      CREATE TABLE IF NOT EXISTS noc_documents (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        application_id  INT NOT NULL,
        doc_type        VARCHAR(40) NOT NULL,
        file_name       VARCHAR(255),
        file_path       VARCHAR(500),
        uploaded_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_app_doc (application_id, doc_type),
        FOREIGN KEY (application_id) REFERENCES noc_applications(id) ON DELETE CASCADE
      )
    \`);


    // ── TAX REFUND APPLICATIONS TABLE ────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS tax_refund_applications (
        id                    INT AUTO_INCREMENT PRIMARY KEY,
        tax_ref               VARCHAR(30) NOT NULL UNIQUE,
        vehicle_id            INT,
        user_id               INT,
        prev_state            VARCHAR(80),
        new_state             VARCHAR(80),
        tax_paid_paise        INT NOT NULL,
        years_used            DECIMAL(4,2) NOT NULL,
        used_amount_paise     INT,
        refund_amount_paise   INT,
        new_state_tax_paise   INT,
        bank_account          VARCHAR(20),
        ifsc_code             VARCHAR(11),
        tax_receipt_path      VARCHAR(500),
        status                ENUM('pending','processing','refund_initiated',
                                   'refund_credited','rejected','cancelled')
                              DEFAULT 'pending',
        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
        FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE SET NULL,
        INDEX idx_tax_ref (tax_ref)
      )
    \`);

    console.log('✅ Database schema ready');
  } catch (err) {
    console.error('❌ Schema init failed:', err.message);
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, testConnection, initSchema };
