const { Pool } = require("pg");

// Show whether DATABASE_URL is being loaded
console.log("DATABASE_URL Loaded:", !!process.env.DATABASE_URL);

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing in .env file");
  process.exit(1);
}

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Initialize database
const initDB = async () => {
  try {
    // Test connection first
    const test = await pool.query("SELECT NOW()");
    console.log("✅ PostgreSQL Connected:", test.rows[0].now);

    // Create a simple table first to confirm permissions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        firm_name TEXT,
        frn TEXT,
        role TEXT DEFAULT 'ca',
        gstin TEXT,
        address TEXT,
        phone TEXT,
        logo_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("✅ Database initialised successfully");
  } catch (err) {
    console.error("❌ FULL DB ERROR:");
    console.error(err);
    process.exit(1);
  }
};

// Run initialization
initDB();

module.exports = pool;