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
        password    VARCHAR(255),
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_mobile (mobile),
        UNIQUE INDEX idx_email (email)
      )
    `);

    // Ensure existing users table has the new password column and unique email index
    try {
      await conn.execute(`ALTER TABLE users ADD COLUMN password VARCHAR(255)`);
      console.log('Migration: Added password column to users table');
    } catch (e) {
      // Column likely already exists
    }

    try {
      await conn.execute(`ALTER TABLE users ADD UNIQUE INDEX idx_email (email)`);
      console.log('Migration: Added unique index to email in users table');
    } catch (e) {
      // Index likely already exists or duplicate data prevents it
    }

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
        fuel_type       ENUM('petrol','diesel','cng','lpg','ev','hybrid') DEFAULT 'petrol',
        reg_state       VARCHAR(80),
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_reg (reg_number)
      )
    `);

    // Ensure existing tables are updated with 'lpg' in fuel_type (migration)
    try {
      await conn.execute(`
        ALTER TABLE vehicles MODIFY COLUMN fuel_type ENUM('petrol','diesel','cng','lpg','ev','hybrid') DEFAULT 'petrol'
      `);
    } catch (e) {
      console.log('Skipping vehicles alter table (already migrated or error):', e.message);
    }

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
    `);

    // ── NOC DOCUMENT UPLOADS TABLE ────────────────────────
    await conn.execute(`
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
    `);


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
    `);


    // ── BH APPLICATIONS TABLE ─────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS bh_applications (
        id                    INT AUTO_INCREMENT PRIMARY KEY,
        bh_ref                VARCHAR(40) NOT NULL UNIQUE,
        vehicle_id            INT,
        user_id               INT,
        eligibility_type      ENUM('central','defence','state','psu','private','mnc'),
        res_state             VARCHAR(80),
        district              VARCHAR(80),
        pincode               VARCHAR(10),
        city                  VARCHAR(80),
        address               TEXT,
        org_name              VARCHAR(150),
        employee_id           VARCHAR(50),
        designation           VARCHAR(100),
        office_city           VARCHAR(80),
        vehicle_type          ENUM('2w','4w','3w','lmv') DEFAULT '4w',
        fuel_type             ENUM('petrol','diesel','cng','lpg','ev','hybrid') DEFAULT 'petrol',
        engine_cc             INT,
        invoice_amount_paise  BIGINT,
        base_fee_paise        INT,
        hsrp_fee_paise        INT DEFAULT 55000,
        smart_card_paise      INT DEFAULT 20000,
        total_fee_paise       INT,
        submission_place      VARCHAR(100),
        status                ENUM('pending','documents_uploaded','rto_processing',
                                   'approved','bh_issued','rejected','cancelled')
                              DEFAULT 'pending',
        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL,
        FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE SET NULL,
        INDEX idx_bh_ref (bh_ref),
        INDEX idx_bh_status (status)
      )
    `);

    // ── BH DOCUMENTS TABLE ────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS bh_documents (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        application_id  INT NOT NULL,
        doc_type        VARCHAR(40) NOT NULL,
        file_name       VARCHAR(255),
        file_path       VARCHAR(500),
        uploaded_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_bh_doc (application_id, doc_type),
        FOREIGN KEY (application_id) REFERENCES bh_applications(id) ON DELETE CASCADE
      )
    `);


    // ── PUC RECORDS TABLE ─────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS puc_records (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        vehicle_id      INT NOT NULL,
        cert_number     VARCHAR(40) NOT NULL UNIQUE,
        issued_date     DATE NOT NULL,
        expiry_date     DATE,
        fuel_type       ENUM('petrol','diesel','cng','lpg','ev','hybrid') DEFAULT 'petrol',
        co_level        DECIMAL(5,2) DEFAULT 0,
        hc_level        INT DEFAULT 0,
        co2_level       DECIMAL(5,2) DEFAULT 0,
        opacity_level   DECIMAL(5,2) DEFAULT 0,
        centre_name     VARCHAR(150),
        status          ENUM('valid','expired','exempt','revoked') DEFAULT 'valid',
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE,
        INDEX idx_cert (cert_number),
        INDEX idx_vehicle_puc (vehicle_id, status)
      )
    `);

    // ── PUC CENTRES TABLE ─────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS puc_centres (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        name      VARCHAR(150) NOT NULL,
        address   TEXT,
        state     VARCHAR(80),
        district  VARCHAR(80),
        pincode   VARCHAR(10),
        contact   VARCHAR(20),
        timing    VARCHAR(60),
        fuel_types VARCHAR(100),
        lat       DECIMAL(10,7),
        lng       DECIMAL(10,7)
      )
    `);

    // Seed a few PUC centres if table is empty
    const [[centreCount]] = await conn.execute('SELECT COUNT(*) as cnt FROM puc_centres');
    if (centreCount.cnt === 0) {
      await conn.execute(`
        INSERT INTO puc_centres (name, address, state, district, pincode, contact, timing, fuel_types, lat, lng) VALUES
        ('Green Auto PUC Centre', 'Shop 14, Deccan Gymkhana Rd, Pune', 'Maharashtra', 'Pune', '411004', '020-2551-0001', '8am-8pm', 'Petrol/Diesel/CNG', 18.5195, 73.8553),
        ('Sharma Motors PUC', 'Near Shivaji Nagar, FC Road, Pune', 'Maharashtra', 'Pune', '411005', '020-2412-0002', '9am-7pm', 'Petrol/CNG', 18.5308, 73.8474),
        ('City Auto Works PUC', 'Kalyani Nagar, Nagar Road, Pune', 'Maharashtra', 'Pune', '411014', '020-2764-0003', '8am-6pm', 'Petrol/Diesel', 18.5460, 73.9012),
        ('Patil Auto Service', 'Hadapsar Industrial Estate, Pune', 'Maharashtra', 'Pune', '411028', '020-2683-0004', '8am-9pm', 'All Fuel Types', 18.4957, 73.9318),
        ('RTO-Authorised PUC Hub', 'Opposite RTO Office, Bund Garden, Pune', 'Maharashtra', 'Pune', '411001', '020-2612-0005', '9am-5pm', 'All Fuel Types', 18.5290, 73.8733),
        ('Delhi Green PUC', 'Nehru Place, New Delhi', 'Delhi', 'South Delhi', '110019', '011-4000-0006', '8am-8pm', 'Petrol/Diesel/CNG', 28.5485, 77.2520),
        ('Bangalore Auto Emission', 'Koramangala, Bangalore', 'Karnataka', 'Bangalore Urban', '560034', '080-4100-0007', '9am-7pm', 'Petrol/Diesel', 12.9352, 77.6245)
      `);
      console.log('✅ PUC centres seeded');
    }

    console.log('✅ Database schema ready');
  } catch (err) {
    console.error('❌ Schema init failed:', err.message);
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, testConnection, initSchema };
