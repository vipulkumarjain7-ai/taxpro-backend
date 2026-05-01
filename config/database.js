const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DB_PATH || "./taxpro.db";
const db = new Database(path.resolve(DB_PATH));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    firm_name TEXT,
    frn TEXT,
    role TEXT NOT NULL DEFAULT 'ca',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    gstin TEXT NOT NULL,
    state TEXT NOT NULL,
    type TEXT NOT NULL,
    turnover TEXT,
    status TEXT NOT NULL DEFAULT 'compliant',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, gstin)
  );
  CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    ref_no TEXT NOT NULL,
    type TEXT NOT NULL,
    issued_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    amount REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'medium',
    description TEXT,
    reply_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS returns (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    period TEXT NOT NULL,
    gstr1_status TEXT NOT NULL DEFAULT 'not-filed',
    gstr3b_status TEXT NOT NULL DEFAULT 'not-filed',
    gstr9_status TEXT NOT NULL DEFAULT 'not-filed',
    gstr1_date TEXT,
    gstr3b_date TEXT,
    gstr9_date TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    UNIQUE(user_id, client_id, period)
  );
  CREATE TABLE IF NOT EXISTS reconciliation (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    period TEXT NOT NULL,
    vendor_name TEXT NOT NULL,
    vendor_gstin TEXT NOT NULL,
    invoice_count INTEGER DEFAULT 0,
    gstr2a_amount REAL DEFAULT 0,
    gstr2b_amount REAL DEFAULT 0,
    books_amount REAL DEFAULT 0,
    difference REAL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    remarks TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );
`);

console.log("Database initialised at", DB_PATH);
module.exports = db;