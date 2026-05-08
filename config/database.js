const { Pool } = require("pg");
console.log("DATABASE_URL exists:", !!process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
  connectionTimeoutMillis: 10000,
});
pool.connect()
  .then(() => console.log("✅ PostgreSQL Connected"))
  .catch(err => {
    console.error("❌ PostgreSQL Connection Error:", err.message);
    process.exit(1);
  });
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        email       TEXT NOT NULL UNIQUE,
        password    TEXT NOT NULL,
        firm_name   TEXT,
        frn         TEXT,
        role        TEXT NOT NULL DEFAULT 'ca',
        parent_id   TEXT,
        created_at  TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS clients (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        name        TEXT NOT NULL,
        gstin       TEXT NOT NULL,
        state       TEXT NOT NULL,
        type        TEXT NOT NULL,
        turnover    TEXT,
        status      TEXT NOT NULL DEFAULT 'compliant',
        notes       TEXT,
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, gstin)
      );
      CREATE TABLE IF NOT EXISTS notices (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        client_id    TEXT NOT NULL,
        ref_no       TEXT NOT NULL,
        type         TEXT NOT NULL,
        issued_date  TEXT NOT NULL,
        due_date     TEXT NOT NULL,
        amount       REAL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'pending',
        priority     TEXT NOT NULL DEFAULT 'medium',
        description  TEXT,
        reply_text   TEXT,
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS returns (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        client_id      TEXT NOT NULL,
        period         TEXT NOT NULL,
        gstr1_status   TEXT NOT NULL DEFAULT 'not-filed',
        gstr3b_status  TEXT NOT NULL DEFAULT 'not-filed',
        gstr9_status   TEXT NOT NULL DEFAULT 'not-filed',
        gstr1_date     TEXT,
        gstr3b_date    TEXT,
        gstr9_date     TEXT,
        notes          TEXT,
        created_at     TIMESTAMP DEFAULT NOW(),
        updated_at     TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, client_id, period)
      );
      CREATE TABLE IF NOT EXISTS reconciliation (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        client_id       TEXT NOT NULL,
        period          TEXT NOT NULL,
        vendor_name     TEXT NOT NULL,
        vendor_gstin    TEXT NOT NULL,
        invoice_count   INTEGER DEFAULT 0,
        gstr2a_amount   REAL DEFAULT 0,
        gstr2b_amount   REAL DEFAULT 0,
        books_amount    REAL DEFAULT 0,
        difference      REAL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'pending',
        remarks         TEXT,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS challans (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        client_id    TEXT NOT NULL,
        challan_no   TEXT NOT NULL,
        type         TEXT NOT NULL,
        amount       REAL DEFAULT 0,
        period       TEXT,
        payment_date TEXT,
        status       TEXT NOT NULL DEFAULT 'paid',
        notes        TEXT,
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ PostgreSQL Database initialised");
  } catch (err) {
    console.error("❌ DB Error:", err.message);
    process.exit(1);
  }
};

initDB();
module.exports = pool;