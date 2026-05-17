require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const jwt        = require("jsonwebtoken");
const bcrypt     = require("bcryptjs");
const { v4: uuid } = require("uuid");
const morgan     = require("morgan");
const multer     = require("multer");
const XLSX       = require("xlsx");
const https      = require("https");
const Database   = require("pg");
const path       = require("path");

const app  = express();
const PORT = process.env.PORT || 5000;
const JWT  = process.env.JWT_SECRET || "taxpro_secret_2024";

// ── Database ───────────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || "./taxpro.db");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL, firm_name TEXT, frn TEXT, role TEXT DEFAULT 'ca',
    parent_id TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
    gstin TEXT, state TEXT, type TEXT DEFAULT 'Trader', turnover TEXT,
    status TEXT DEFAULT 'compliant', notes TEXT, phone TEXT, email TEXT,
    address TEXT, city TEXT, pincode TEXT, pan TEXT, credit_limit REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
    ref_no TEXT NOT NULL, type TEXT NOT NULL, issued_date TEXT NOT NULL,
    due_date TEXT NOT NULL, amount REAL DEFAULT 0, status TEXT DEFAULT 'pending',
    priority TEXT DEFAULT 'medium', description TEXT, reply_text TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS returns (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
    period TEXT NOT NULL, gstr1_status TEXT DEFAULT 'not-filed',
    gstr3b_status TEXT DEFAULT 'not-filed', gstr9_status TEXT DEFAULT 'not-filed',
    gstr1_date TEXT, gstr3b_date TEXT, gstr9_date TEXT, notes TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, client_id, period)
  );
  CREATE TABLE IF NOT EXISTS reconciliation (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
    period TEXT NOT NULL, vendor_name TEXT NOT NULL, vendor_gstin TEXT NOT NULL,
    invoice_count INTEGER DEFAULT 0, gstr2a_amount REAL DEFAULT 0,
    gstr2b_amount REAL DEFAULT 0, books_amount REAL DEFAULT 0,
    difference REAL DEFAULT 0, status TEXT DEFAULT 'pending', remarks TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS challans (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
    challan_no TEXT NOT NULL, type TEXT NOT NULL, amount REAL DEFAULT 0,
    period TEXT, payment_date TEXT, status TEXT DEFAULT 'paid', notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
    code TEXT, hsn_sac TEXT, unit TEXT DEFAULT 'PCS', category TEXT,
    gst_rate REAL DEFAULT 18, purchase_price REAL DEFAULT 0,
    sale_price REAL DEFAULT 0, stock_qty REAL DEFAULT 0, min_stock REAL DEFAULT 0,
    description TEXT, is_service INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, invoice_no TEXT NOT NULL,
    invoice_type TEXT DEFAULT 'SALES', party_id TEXT, party_name TEXT NOT NULL,
    party_gstin TEXT, party_address TEXT, party_state TEXT,
    invoice_date TEXT NOT NULL, due_date TEXT, place_of_supply TEXT,
    is_igst INTEGER DEFAULT 0, subtotal REAL DEFAULT 0, discount REAL DEFAULT 0,
    taxable_amount REAL DEFAULT 0, igst_amount REAL DEFAULT 0,
    cgst_amount REAL DEFAULT 0, sgst_amount REAL DEFAULT 0,
    cess_amount REAL DEFAULT 0, total_tax REAL DEFAULT 0,
    total_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0,
    balance_due REAL DEFAULT 0, status TEXT DEFAULT 'unpaid',
    notes TEXT, terms TEXT, einvoice_irn TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS invoice_items (
    id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, product_id TEXT,
    name TEXT NOT NULL, hsn_sac TEXT, unit TEXT DEFAULT 'PCS',
    qty REAL DEFAULT 1, rate REAL DEFAULT 0, discount_pct REAL DEFAULT 0,
    taxable_value REAL DEFAULT 0, gst_rate REAL DEFAULT 18,
    igst_amount REAL DEFAULT 0, cgst_amount REAL DEFAULT 0,
    sgst_amount REAL DEFAULT 0, total_amount REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT NOT NULL,
    type TEXT NOT NULL, qty REAL NOT NULL, rate REAL DEFAULT 0,
    reference TEXT, invoice_id TEXT, notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, invoice_id TEXT,
    party_id TEXT, party_name TEXT, type TEXT DEFAULT 'RECEIVED',
    amount REAL DEFAULT 0, method TEXT DEFAULT 'CASH', reference_no TEXT,
    payment_date TEXT NOT NULL, notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bank_transactions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bank_name TEXT,
    account_no TEXT, txn_date TEXT NOT NULL, description TEXT NOT NULL,
    ref_no TEXT, debit REAL DEFAULT 0, credit REAL DEFAULT 0,
    balance REAL DEFAULT 0, category TEXT DEFAULT 'Uncategorized',
    sub_category TEXT, type TEXT DEFAULT 'UNKNOWN', is_reconciled INTEGER DEFAULT 0,
    notes TEXT, import_id TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bank_imports (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bank_name TEXT,
    account_no TEXT, from_date TEXT, to_date TEXT, total_txns INTEGER DEFAULT 0,
    total_debit REAL DEFAULT 0, total_credit REAL DEFAULT 0, filename TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
   CREATE TABLE IF NOT EXISTS companies (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    name            TEXT NOT NULL,
    legal_name      TEXT,
    gstin           TEXT,
    pan             TEXT,
    address         TEXT,
    city            TEXT,
    state           TEXT,
    pincode         TEXT,
    phone           TEXT,
    email           TEXT,
    financial_year  TEXT DEFAULT 'Apr-Mar',
    fy_start        TEXT DEFAULT '2025-04-01',
    fy_end          TEXT DEFAULT '2026-03-31',
    currency        TEXT DEFAULT 'INR',
    logo_url        TEXT,
    is_active       INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (datetime('now'))
  );
 
  CREATE TABLE IF NOT EXISTS ledger_groups (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    company_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    parent_id       TEXT,
    nature          TEXT NOT NULL,
    affects_gross   INTEGER DEFAULT 0,
    is_default      INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now'))
  );
 
  CREATE TABLE IF NOT EXISTS ledgers (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    company_id      TEXT NOT NULL,
    group_id        TEXT NOT NULL,
    name            TEXT NOT NULL,
    alias           TEXT,
    opening_balance REAL DEFAULT 0,
    opening_type    TEXT DEFAULT 'Dr',
    gstin           TEXT,
    pan             TEXT,
    address         TEXT,
    phone           TEXT,
    email           TEXT,
    bank_account    TEXT,
    bank_name       TEXT,
    ifsc_code       TEXT,
    credit_limit    REAL DEFAULT 0,
    credit_days     INTEGER DEFAULT 0,
    is_default      INTEGER DEFAULT 0,
    notes           TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );
 
  CREATE TABLE IF NOT EXISTS vouchers (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    company_id      TEXT NOT NULL,
    voucher_no      TEXT NOT NULL,
    voucher_type    TEXT NOT NULL,
    date            TEXT NOT NULL,
    ref_no          TEXT,
    narration       TEXT,
    party_ledger_id TEXT,
    party_name      TEXT,
    total_amount    REAL DEFAULT 0,
    is_posted       INTEGER DEFAULT 1,
    is_cancelled    INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );
 
  CREATE TABLE IF NOT EXISTS voucher_items (
    id              TEXT PRIMARY KEY,
    voucher_id      TEXT NOT NULL,
    ledger_id       TEXT NOT NULL,
    ledger_name     TEXT NOT NULL,
    dr_amount       REAL DEFAULT 0,
    cr_amount       REAL DEFAULT 0,
    narration       TEXT,
    sort_order      INTEGER DEFAULT 0
  );
 
  CREATE TABLE IF NOT EXISTS godowns (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    company_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    address         TEXT,
    is_default      INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now'))
  );
`);

console.log("✅ Database initialised at", process.env.DB_PATH || "./taxpro.db");

// ── Migration: Add new columns to existing tables ──────────────────────────
const migrations = [
  ["clients",  "phone",        "TEXT"],
  ["clients",  "email",        "TEXT"],
  ["clients",  "address",      "TEXT"],
  ["clients",  "city",         "TEXT"],
  ["clients",  "pincode",      "TEXT"],
  ["clients",  "pan",          "TEXT"],
  ["clients",  "credit_limit", "REAL DEFAULT 0"],
  ["users",    "parent_id",    "TEXT"],
  ["users",    "gstin",        "TEXT"],
  ["users",    "phone",        "TEXT"],
  ["users",    "logo_url",     "TEXT"],
  ["invoices", "cess_amount",  "REAL DEFAULT 0"],
  ["invoices", "einvoice_irn", "TEXT"],
  ["invoice_items", "discount_pct", "REAL DEFAULT 0"],
];
for (const [table, col, type] of migrations) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run(); }
  catch(e) { /* column already exists — ignore */ }
}
console.log("✅ Database migration complete");

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({ origin:"*", methods:["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allowedHeaders:["Content-Type","Authorization"] }));
app.use(morgan("combined"));
app.use(express.json({ limit:"10mb" }));
app.use(express.urlencoded({ extended:true }));

const upload = multer({ storage: multer.memoryStorage(), limits:{ fileSize:20*1024*1024 } });

// ── Auth Middleware ────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return res.status(401).json({ success:false, message:"No token" });
  try { req.user = jwt.verify(h.split(" ")[1], JWT); next(); }
  catch(e) { return res.status(401).json({ success:false, message:"Invalid token" }); }
};

// ── Helper: Groq AI call ───────────────────────────────────────────────────
const callGroq = (messages, system) => new Promise((resolve) => {
  if (!process.env.GROQ_API_KEY) return resolve("Groq API key not configured. Please add GROQ_API_KEY in Render environment variables.");
  const postData = JSON.stringify({ model:"llama-3.3-70b-versatile", messages:[{ role:"system", content:system },...messages], max_tokens:1500 });
  const options = { hostname:"api.groq.com", path:"/openai/v1/chat/completions", method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${process.env.GROQ_API_KEY}`, "Content-Length":Buffer.byteLength(postData) } };
  const req = https.request(options, (res) => {
    let data=""; res.on("data",c=>{data+=c;}); res.on("end",()=>{
      try { resolve(JSON.parse(data).choices?.[0]?.message?.content||"Sorry, could not process."); }
      catch(e) { resolve("Error processing response."); }
    });
  });
  req.on("error", ()=>resolve("Network error calling AI."));
  req.setTimeout(30000, ()=>{ req.destroy(); resolve("Request timed out."); });
  req.write(postData); req.end();
});

// ══════════════════════════════════════════════════════════════════════════
// ── AUTH ROUTES ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, firm_name, frn } = req.body;
    if (!name||!email||!password||!firm_name) return res.status(400).json({ success:false, message:"Name, email, password and firm name are required" });
    if (password.length < 6) return res.status(400).json({ success:false, message:"Password must be at least 6 characters" });
    const exists = db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase().trim());
    if (exists) return res.status(409).json({ success:false, message:"Email already registered. Please login." });
    const hashed = await bcrypt.hash(password, 12);
    const id = uuid();
    db.prepare("INSERT INTO users (id,name,email,password,firm_name,frn,role) VALUES (?,?,?,?,?,?,'ca')").run(id, name.trim(), email.toLowerCase().trim(), hashed, firm_name.trim(), frn||null);
    const token = jwt.sign({ id, name:name.trim(), email:email.toLowerCase().trim(), firm_name:firm_name.trim(), role:"ca" }, JWT, { expiresIn:"7d" });
    res.status(201).json({ success:true, token, user:{ id, name:name.trim(), email:email.toLowerCase().trim(), firm_name:firm_name.trim(), frn:frn||null, role:"ca" } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email||!password) return res.status(400).json({ success:false, message:"Email and password required" });
    const user = db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase().trim());
    if (!user) return res.status(401).json({ success:false, message:"Invalid email or password" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success:false, message:"Invalid email or password" });
    const token = jwt.sign({ id:user.id, name:user.name, email:user.email, firm_name:user.firm_name, role:user.role }, JWT, { expiresIn:"7d" });
    res.json({ success:true, token, user:{ id:user.id, name:user.name, email:user.email, firm_name:user.firm_name, frn:user.frn, role:user.role } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/auth/me", auth, (req, res) => {
  const user = db.prepare("SELECT id,name,email,firm_name,frn,role,created_at FROM users WHERE id=?").get(req.user.id);
  if (!user) return res.status(404).json({ success:false, message:"User not found" });
  res.json({ success:true, user });
});

// ══════════════════════════════════════════════════════════════════════════
// ── DASHBOARD ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/dashboard", auth, (req, res) => {
  try {
    const uid = req.user.id;
    const today = new Date().toISOString().split("T")[0];
    const in30  = new Date(Date.now()+30*24*60*60*1000).toISOString().split("T")[0];
    const totalC    = db.prepare("SELECT COUNT(*) as c FROM clients WHERE user_id=?").get(uid).c;
    const compliant = db.prepare("SELECT COUNT(*) as c FROM clients WHERE user_id=? AND status='compliant'").get(uid).c;
    const openN     = db.prepare("SELECT COUNT(*) as c FROM notices WHERE user_id=? AND status NOT IN ('closed','replied')").get(uid).c;
    const due30     = db.prepare("SELECT COUNT(*) as c FROM notices WHERE user_id=? AND due_date BETWEEN ? AND ? AND status NOT IN ('closed','replied')").get(uid,today,in30).c;
    const upcoming  = db.prepare("SELECT n.*,c.name as client_name FROM notices n JOIN clients c ON n.client_id=c.id WHERE n.user_id=? AND n.due_date BETWEEN ? AND ? AND n.status NOT IN ('closed','replied') ORDER BY n.due_date ASC LIMIT 5").all(uid,today,in30);
    const recent    = db.prepare("SELECT * FROM clients WHERE user_id=? ORDER BY created_at DESC LIMIT 5").all(uid);
    const lastPeriod = db.prepare("SELECT period FROM returns WHERE user_id=? ORDER BY period DESC LIMIT 1").get(uid);
    let returnsSummary = null;
    if (lastPeriod) {
      const p = lastPeriod.period;
      const count = (field, status) => db.prepare(`SELECT COUNT(*) as c FROM returns WHERE user_id=? AND period=? AND ${field}=?`).get(uid,p,status).c;
      returnsSummary = { period:p, gstr1:{filed:count("gstr1_status","filed"),pending:count("gstr1_status","pending"),not_filed:count("gstr1_status","not-filed")}, gstr3b:{filed:count("gstr3b_status","filed"),pending:count("gstr3b_status","pending"),not_filed:count("gstr3b_status","not-filed")}, gstr9:{filed:count("gstr9_status","filed"),pending:count("gstr9_status","pending"),not_filed:count("gstr9_status","not-filed")} };
    }
    res.json({ success:true, dashboard:{ clients:{ total:totalC, compliant, pending:db.prepare("SELECT COUNT(*) as c FROM clients WHERE user_id=? AND status='pending'").get(uid).c, overdue:db.prepare("SELECT COUNT(*) as c FROM clients WHERE user_id=? AND status='overdue'").get(uid).c }, notices:{ open:openN, overdue:db.prepare("SELECT COUNT(*) as c FROM notices WHERE user_id=? AND status='overdue'").get(uid).c, due_in_30_days:due30 }, upcoming_notices:upcoming, recent_clients:recent, returns_summary:returnsSummary } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── CLIENTS ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/clients", auth, (req, res) => {
  try {
    const { search, status } = req.query;
    let q = "SELECT c.*, (SELECT COUNT(*) FROM notices n WHERE n.client_id=c.id AND n.status NOT IN ('closed','replied')) as notice_count FROM clients c WHERE c.user_id=?";
    const params = [req.user.id];
    if (search) { q += " AND (c.name LIKE ? OR c.gstin LIKE ?)"; params.push(`%${search}%`,`%${search}%`); }
    if (status) { q += " AND c.status=?"; params.push(status); }
    q += " ORDER BY c.name ASC";
    res.json({ success:true, clients:db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/clients", auth, (req, res) => {
  try {
    const { name, gstin, state, type, turnover, notes, phone, email, address, city, pincode, pan } = req.body;
    if (!name) return res.status(400).json({ success:false, message:"Name is required" });
    const id = uuid();
    db.prepare("INSERT INTO clients (id,user_id,name,gstin,state,type,turnover,notes,phone,email,address,city,pincode,pan) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,req.user.id,name,gstin?.toUpperCase()||null,state||null,type||"Trader",turnover||null,notes||null,phone||null,email||null,address||null,city||null,pincode||null,pan||null);
    res.status(201).json({ success:true, message:"Client added", client:db.prepare("SELECT * FROM clients WHERE id=?").get(id) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.put("/api/clients/:id", auth, (req, res) => {
  try {
    const c = db.prepare("SELECT id FROM clients WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
    if (!c) return res.status(404).json({ success:false, message:"Not found" });
    const { name, gstin, state, type, turnover, notes, status, phone, email, address, city, pincode, pan } = req.body;
    db.prepare("UPDATE clients SET name=?,gstin=?,state=?,type=?,turnover=?,notes=?,status=?,phone=?,email=?,address=?,city=?,pincode=?,pan=?,updated_at=datetime('now') WHERE id=?").run(name,gstin?.toUpperCase()||null,state||null,type||"Trader",turnover||null,notes||null,status||"compliant",phone||null,email||null,address||null,city||null,pincode||null,pan||null,req.params.id);
    res.json({ success:true, message:"Updated", client:db.prepare("SELECT * FROM clients WHERE id=?").get(req.params.id) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/clients/:id", auth, (req, res) => {
  try {
    const c = db.prepare("SELECT id FROM clients WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
    if (!c) return res.status(404).json({ success:false, message:"Not found" });
    db.prepare("DELETE FROM clients WHERE id=?").run(req.params.id);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── NOTICES ───────────────────────────────────────════════════════════════
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/notices", auth, (req, res) => {
  try {
    const { status, client_id } = req.query;
    let q = "SELECT n.*,c.name as client_name,c.gstin FROM notices n JOIN clients c ON n.client_id=c.id WHERE n.user_id=?";
    const params = [req.user.id];
    if (status && status!=="all") { q+=" AND n.status=?"; params.push(status); }
    if (client_id) { q+=" AND n.client_id=?"; params.push(client_id); }
    q+=" ORDER BY n.due_date ASC";
    res.json({ success:true, notices:db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/notices", auth, (req, res) => {
  try {
    const { client_id, ref_no, type, issued_date, due_date, amount, priority, description } = req.body;
    if (!client_id||!ref_no||!type||!issued_date||!due_date) return res.status(400).json({ success:false, message:"Required fields missing" });
    const today = new Date().toISOString().split("T")[0];
    const status = new Date(due_date) < new Date(today) ? "overdue" : "pending";
    const id = uuid();
    db.prepare("INSERT INTO notices (id,user_id,client_id,ref_no,type,issued_date,due_date,amount,status,priority,description) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id,req.user.id,client_id,ref_no,type,issued_date,due_date,parseFloat(amount)||0,status,priority||"medium",description||null);
    res.status(201).json({ success:true, message:"Notice added", notice:db.prepare("SELECT * FROM notices WHERE id=?").get(id) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.patch("/api/notices/:id/status", auth, (req, res) => {
  try {
    db.prepare("UPDATE notices SET status=?,updated_at=datetime('now') WHERE id=? AND user_id=?").run(req.body.status,req.params.id,req.user.id);
    res.json({ success:true, message:"Updated" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/notices/:id", auth, (req, res) => {
  try {
    db.prepare("DELETE FROM notices WHERE id=? AND user_id=?").run(req.params.id,req.user.id);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── RETURNS ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/returns", auth, (req, res) => {
  try {
    const { period, client_id } = req.query;
    let q = "SELECT r.*,c.name as client_name,c.gstin FROM returns r JOIN clients c ON r.client_id=c.id WHERE r.user_id=?";
    const params = [req.user.id];
    if (period) { q+=" AND r.period=?"; params.push(period); }
    if (client_id) { q+=" AND r.client_id=?"; params.push(client_id); }
    q+=" ORDER BY c.name ASC";
    res.json({ success:true, returns:db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/returns", auth, (req, res) => {
  try {
    const { client_id, period, gstr1_status, gstr3b_status, gstr9_status } = req.body;
    if (!client_id||!period) return res.status(400).json({ success:false, message:"client_id and period required" });
    const exists = db.prepare("SELECT id FROM returns WHERE user_id=? AND client_id=? AND period=?").get(req.user.id,client_id,period);
    if (exists) return res.status(409).json({ success:false, message:"Record already exists for this period" });
    const id = uuid();
    db.prepare("INSERT INTO returns (id,user_id,client_id,period,gstr1_status,gstr3b_status,gstr9_status) VALUES (?,?,?,?,?,?,?)").run(id,req.user.id,client_id,period,gstr1_status||"not-filed",gstr3b_status||"not-filed",gstr9_status||"not-filed");
    res.status(201).json({ success:true, message:"Saved", return:db.prepare("SELECT * FROM returns WHERE id=?").get(id) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.put("/api/returns/:id", auth, (req, res) => {
  try {
    const { gstr1_status, gstr3b_status, gstr9_status } = req.body;
    db.prepare("UPDATE returns SET gstr1_status=?,gstr3b_status=?,gstr9_status=?,updated_at=datetime('now') WHERE id=? AND user_id=?").run(gstr1_status,gstr3b_status,gstr9_status,req.params.id,req.user.id);
    res.json({ success:true, message:"Updated" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── RECONCILIATION ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/reconciliation", auth, (req, res) => {
  try {
    const { client_id, period } = req.query;
    if (!client_id||!period) return res.status(400).json({ success:false, message:"client_id and period required" });
    const rows = db.prepare("SELECT * FROM reconciliation WHERE user_id=? AND client_id=? AND period=? ORDER BY vendor_name ASC").all(req.user.id,client_id,period);
    const matched  = rows.filter(r=>r.status==="matched").length;
    const mismatch = rows.filter(r=>r.status==="mismatch").length;
    const missing  = rows.filter(r=>r.status==="missing").length;
    const totalRisk = rows.reduce((a,r)=>a+(r.difference||0),0);
    res.json({ success:true, rows, summary:{ matched, mismatch, missing, total_itc_risk:totalRisk } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/reconciliation", auth, (req, res) => {
  try {
    const { client_id, period, vendor_name, vendor_gstin, invoice_count, gstr2a_amount, gstr2b_amount, books_amount, remarks } = req.body;
    const g2a=parseFloat(gstr2a_amount)||0, g2b=parseFloat(gstr2b_amount)||0, bks=parseFloat(books_amount)||0;
    const diff = g2b - bks;
    const status = g2b===0&&bks>0 ? "missing" : Math.abs(diff)>0 ? "mismatch" : "matched";
    const id = uuid();
    db.prepare("INSERT INTO reconciliation (id,user_id,client_id,period,vendor_name,vendor_gstin,invoice_count,gstr2a_amount,gstr2b_amount,books_amount,difference,status,remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,req.user.id,client_id,period,vendor_name,vendor_gstin?.toUpperCase()||"",parseInt(invoice_count)||0,g2a,g2b,bks,diff,status,remarks||null);
    res.status(201).json({ success:true, message:"Added", row:db.prepare("SELECT * FROM reconciliation WHERE id=?").get(id) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/reconciliation/:id", auth, (req, res) => {
  try {
    db.prepare("DELETE FROM reconciliation WHERE id=? AND user_id=?").run(req.params.id,req.user.id);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── PRODUCTS ──────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/products", auth, (req, res) => {
  try {
    const { search } = req.query;
    let q = "SELECT * FROM products WHERE user_id=?";
    const params = [req.user.id];
    if (search) { q+=" AND (name LIKE ? OR code LIKE ?)"; params.push(`%${search}%`,`%${search}%`); }
    q+=" ORDER BY name ASC";
    res.json({ success:true, products:db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/products", auth, (req, res) => {
  try {
    const { name, code, hsn_sac, unit, category, gst_rate, purchase_price, sale_price, stock_qty, min_stock, description, is_service } = req.body;
    if (!name) return res.status(400).json({ success:false, message:"Product name required" });
    const id = uuid();
    db.prepare("INSERT INTO products (id,user_id,name,code,hsn_sac,unit,category,gst_rate,purchase_price,sale_price,stock_qty,min_stock,description,is_service) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,req.user.id,name,code||null,hsn_sac||null,unit||"PCS",category||null,parseFloat(gst_rate)||18,parseFloat(purchase_price)||0,parseFloat(sale_price)||0,parseFloat(stock_qty)||0,parseFloat(min_stock)||0,description||null,is_service?1:0);
    if (parseFloat(stock_qty)>0) db.prepare("INSERT INTO stock_movements (id,user_id,product_id,type,qty,rate,reference,notes) VALUES (?,?,?,'OPENING',?,?,'Opening Stock','Opening stock')").run(uuid(),req.user.id,id,parseFloat(stock_qty),parseFloat(purchase_price)||0);
    res.status(201).json({ success:true, message:"Product added", product:db.prepare("SELECT * FROM products WHERE id=?").get(id) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.put("/api/products/:id", auth, (req, res) => {
  try {
    const { name, code, hsn_sac, unit, category, gst_rate, purchase_price, sale_price, min_stock, description, is_service } = req.body;
    db.prepare("UPDATE products SET name=?,code=?,hsn_sac=?,unit=?,category=?,gst_rate=?,purchase_price=?,sale_price=?,min_stock=?,description=?,is_service=?,updated_at=datetime('now') WHERE id=? AND user_id=?").run(name,code||null,hsn_sac||null,unit||"PCS",category||null,parseFloat(gst_rate)||18,parseFloat(purchase_price)||0,parseFloat(sale_price)||0,parseFloat(min_stock)||0,description||null,is_service?1:0,req.params.id,req.user.id);
    res.json({ success:true, message:"Updated", product:db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/products/:id", auth, (req, res) => {
  try {
    db.prepare("DELETE FROM products WHERE id=? AND user_id=?").run(req.params.id,req.user.id);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/products/:id/stock", auth, (req, res) => {
  try {
    const { type, qty, rate, notes } = req.body;
    const p = db.prepare("SELECT * FROM products WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
    if (!p) return res.status(404).json({ success:false, message:"Product not found" });
    const change = type==="IN" ? parseFloat(qty) : -parseFloat(qty);
    const newStock = parseFloat(p.stock_qty) + change;
    if (newStock < 0) return res.status(400).json({ success:false, message:"Insufficient stock" });
    db.prepare("UPDATE products SET stock_qty=?,updated_at=datetime('now') WHERE id=?").run(newStock,req.params.id);
    db.prepare("INSERT INTO stock_movements (id,user_id,product_id,type,qty,rate,notes) VALUES (?,?,?,?,?,?,?)").run(uuid(),req.user.id,req.params.id,type,Math.abs(parseFloat(qty)),parseFloat(rate)||0,notes||null);
    res.json({ success:true, message:"Stock updated", new_stock:newStock });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── INVOICES ──────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
const genInvNo = (userId, type) => {
  const prefix = type==="SALES"?"INV":type==="PURCHASE"?"PUR":"CN";
  const yr = new Date().getFullYear().toString().slice(-2);
  const mo = String(new Date().getMonth()+1).padStart(2,"0");
  const cnt = db.prepare("SELECT COUNT(*) as c FROM invoices WHERE user_id=? AND invoice_type=?").get(userId,type).c + 1;
  return `${prefix}/${yr}-${mo}/${String(cnt).padStart(4,"0")}`;
};

app.get("/api/invoices", auth, (req, res) => {
  try {
    const { type, status, search } = req.query;
    let q = "SELECT * FROM invoices WHERE user_id=?";
    const params = [req.user.id];
    if (type)   { q+=" AND invoice_type=?"; params.push(type); }
    if (status) { q+=" AND status=?"; params.push(status); }
    if (search) { q+=" AND (party_name LIKE ? OR invoice_no LIKE ?)"; params.push(`%${search}%`,`%${search}%`); }
    q+=" ORDER BY created_at DESC";
    const invoices = db.prepare(q).all(...params);
    const totalAmount = invoices.reduce((a,i)=>a+(i.total_amount||0),0);
    const totalPaid   = invoices.reduce((a,i)=>a+(i.paid_amount||0),0);
    const totalOut    = invoices.reduce((a,i)=>a+(i.balance_due||0),0);
    res.json({ success:true, count:invoices.length, invoices, summary:{ total_amount:totalAmount, total_paid:totalPaid, total_outstanding:totalOut } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/invoices/stats/summary", auth, (req, res) => {
  try {
    const uid = req.user.id;
    const today = new Date().toISOString().split("T")[0];
    const month = today.substring(0,7);
    const sales    = db.prepare("SELECT COALESCE(SUM(total_amount),0) as total FROM invoices WHERE user_id=? AND invoice_type='SALES' AND invoice_date LIKE ?").get(uid,`${month}%`).total;
    const purchases= db.prepare("SELECT COALESCE(SUM(total_amount),0) as total FROM invoices WHERE user_id=? AND invoice_type='PURCHASE' AND invoice_date LIKE ?").get(uid,`${month}%`).total;
    const outstanding=db.prepare("SELECT COALESCE(SUM(balance_due),0) as total FROM invoices WHERE user_id=? AND status IN ('unpaid','partial')").get(uid).total;
    const overdue  = db.prepare("SELECT COALESCE(SUM(balance_due),0) as total FROM invoices WHERE user_id=? AND status IN ('unpaid','partial') AND due_date < ?").get(uid,today).total;
    res.json({ success:true, stats:{ monthly_sales:sales, monthly_purchases:purchases, total_outstanding:outstanding, overdue_amount:overdue } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/invoices/:id", auth, (req, res) => {
  try {
    const inv = db.prepare("SELECT * FROM invoices WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
    if (!inv) return res.status(404).json({ success:false, message:"Not found" });
    const items    = db.prepare("SELECT * FROM invoice_items WHERE invoice_id=?").all(req.params.id);
    const payments = db.prepare("SELECT * FROM payments WHERE invoice_id=?").all(req.params.id);
    res.json({ success:true, invoice:{ ...inv, items, payments } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/invoices", auth, (req, res) => {
  try {
    const { invoice_type, party_id, party_name, party_gstin, party_address, party_state, invoice_date, due_date, place_of_supply, is_igst, notes, terms, items=[] } = req.body;
    if (!party_name) return res.status(400).json({ success:false, message:"Party name required" });
    if (!invoice_date) return res.status(400).json({ success:false, message:"Invoice date required" });
    if (items.length===0) return res.status(400).json({ success:false, message:"At least one item required" });

    const invoice_no = genInvNo(req.user.id, invoice_type||"SALES");
    let subtotal=0, totalIGST=0, totalCGST=0, totalSGST=0;

    const processedItems = items.map(item => {
      const qty=parseFloat(item.qty)||0, rate=parseFloat(item.rate)||0, disc=parseFloat(item.discount_pct)||0, gstRate=parseFloat(item.gst_rate)||0;
      const gross=qty*rate, discAmt=gross*disc/100, taxable=gross-discAmt;
      const igst=is_igst?taxable*gstRate/100:0;
      const cgst=!is_igst?taxable*(gstRate/2)/100:0;
      const sgst=!is_igst?taxable*(gstRate/2)/100:0;
      subtotal+=gross; totalIGST+=igst; totalCGST+=cgst; totalSGST+=sgst;
      return { ...item, taxable_value:taxable, igst_amount:igst, cgst_amount:cgst, sgst_amount:sgst, total_amount:taxable+igst+cgst+sgst };
    });

    const totalTax=totalIGST+totalCGST+totalSGST;
    const totalAmount=subtotal+totalTax;
    const id=uuid();

    db.prepare("INSERT INTO invoices (id,user_id,invoice_no,invoice_type,party_id,party_name,party_gstin,party_address,party_state,invoice_date,due_date,place_of_supply,is_igst,subtotal,taxable_amount,igst_amount,cgst_amount,sgst_amount,total_tax,total_amount,paid_amount,balance_due,status,notes,terms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)").run(id,req.user.id,invoice_no,invoice_type||"SALES",party_id||null,party_name,party_gstin||null,party_address||null,party_state||null,invoice_date,due_date||null,place_of_supply||null,is_igst?1:0,subtotal,subtotal,totalIGST,totalCGST,totalSGST,totalTax,totalAmount,totalAmount,"unpaid",notes||null,terms||null);

    for (const item of processedItems) {
      db.prepare("INSERT INTO invoice_items (id,invoice_id,product_id,name,hsn_sac,unit,qty,rate,discount_pct,taxable_value,gst_rate,igst_amount,cgst_amount,sgst_amount,total_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(uuid(),id,item.product_id||null,item.name,item.hsn_sac||null,item.unit||"PCS",item.qty,item.rate,item.discount_pct||0,item.taxable_value,item.gst_rate||0,item.igst_amount,item.cgst_amount,item.sgst_amount,item.total_amount);
      if (item.product_id) {
        const stockChange = (invoice_type==="SALES") ? -parseFloat(item.qty) : parseFloat(item.qty);
        const p = db.prepare("SELECT stock_qty FROM products WHERE id=?").get(item.product_id);
        if (p) {
          const newStock = Math.max(0, parseFloat(p.stock_qty)+stockChange);
          db.prepare("UPDATE products SET stock_qty=?,updated_at=datetime('now') WHERE id=?").run(newStock,item.product_id);
          db.prepare("INSERT INTO stock_movements (id,user_id,product_id,type,qty,rate,reference,invoice_id,notes) VALUES (?,?,?,?,?,?,?,?,?)").run(uuid(),req.user.id,item.product_id,invoice_type==="SALES"?"OUT":"IN",Math.abs(parseFloat(item.qty)),item.rate,invoice_no,id,`${invoice_type} Invoice`);
        }
      }
    }

    const inv = db.prepare("SELECT * FROM invoices WHERE id=?").get(id);
    const invItems = db.prepare("SELECT * FROM invoice_items WHERE invoice_id=?").all(id);
    res.status(201).json({ success:true, message:"Invoice created", invoice:{ ...inv, items:invItems } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/invoices/:id/payment", auth, (req, res) => {
  try {
    const { amount, method, reference_no, payment_date } = req.body;
    const inv = db.prepare("SELECT * FROM invoices WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
    if (!inv) return res.status(404).json({ success:false, message:"Not found" });
    const paidAmt = parseFloat(inv.paid_amount)+parseFloat(amount);
    const balance = Math.max(0, parseFloat(inv.total_amount)-paidAmt);
    const status  = balance<=0 ? "paid" : "partial";
    db.prepare("UPDATE invoices SET paid_amount=?,balance_due=?,status=?,updated_at=datetime('now') WHERE id=?").run(paidAmt,balance,status,req.params.id);
    db.prepare("INSERT INTO payments (id,user_id,invoice_id,party_name,type,amount,method,reference_no,payment_date) VALUES (?,?,?,?,'RECEIVED',?,?,?,?)").run(uuid(),req.user.id,req.params.id,inv.party_name,parseFloat(amount),method||"CASH",reference_no||null,payment_date);
    res.json({ success:true, message:"Payment recorded", paid_amount:paidAmt, balance_due:balance });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/invoices/:id", auth, (req, res) => {
  try {
    db.prepare("DELETE FROM invoice_items WHERE invoice_id=?").run(req.params.id);
    db.prepare("DELETE FROM invoices WHERE id=? AND user_id=?").run(req.params.id,req.user.id);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── PARTIES ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/parties", auth, (req, res) => {
  try {
    const { search } = req.query;
    let q = "SELECT c.*, COALESCE((SELECT SUM(balance_due) FROM invoices WHERE party_id=c.id AND status IN ('unpaid','partial')),0) as outstanding FROM clients c WHERE c.user_id=?";
    const params = [req.user.id];
    if (search) { q+=" AND (c.name LIKE ? OR c.gstin LIKE ?)"; params.push(`%${search}%`,`%${search}%`); }
    q+=" ORDER BY c.name ASC";
    res.json({ success:true, parties:db.prepare(q).all(...params) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/parties", auth, (req, res) => {
  try {
    const { name, gstin, state, type, phone, email, address, city, pincode, pan, credit_limit } = req.body;
    if (!name) return res.status(400).json({ success:false, message:"Name required" });
    const id = uuid();
    db.prepare("INSERT INTO clients (id,user_id,name,gstin,state,type,phone,email,address,city,pincode,pan,credit_limit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,req.user.id,name,gstin||null,state||null,type||"Customer",phone||null,email||null,address||null,city||null,pincode||null,pan||null,parseFloat(credit_limit)||0);
    res.status(201).json({ success:true, message:"Party added", party:db.prepare("SELECT * FROM clients WHERE id=?").get(id) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.put("/api/parties/:id", auth, (req, res) => {
  try {
    const { name, gstin, state, type, phone, email, address, city, pincode, pan, credit_limit } = req.body;
    db.prepare("UPDATE clients SET name=?,gstin=?,state=?,type=?,phone=?,email=?,address=?,city=?,pincode=?,pan=?,credit_limit=?,updated_at=datetime('now') WHERE id=? AND user_id=?").run(name,gstin||null,state||null,type||"Customer",phone||null,email||null,address||null,city||null,pincode||null,pan||null,parseFloat(credit_limit)||0,req.params.id,req.user.id);
    res.json({ success:true, message:"Updated" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/parties/:id/ledger", auth, (req, res) => {
  try {
    const party    = db.prepare("SELECT * FROM clients WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
    if (!party) return res.status(404).json({ success:false, message:"Not found" });
    const invoices = db.prepare("SELECT * FROM invoices WHERE party_id=? AND user_id=? ORDER BY invoice_date DESC").all(req.params.id,req.user.id);
    const payments = db.prepare("SELECT * FROM payments WHERE party_id=? AND user_id=? ORDER BY payment_date DESC").all(req.params.id,req.user.id);
    const outstanding = invoices.reduce((a,i)=>a+(i.balance_due||0),0);
    res.json({ success:true, party, invoices, payments, summary:{ total_sales:invoices.filter(i=>i.invoice_type==="SALES").reduce((a,i)=>a+(i.total_amount||0),0), total_purchases:invoices.filter(i=>i.invoice_type==="PURCHASE").reduce((a,i)=>a+(i.total_amount||0),0), outstanding } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/parties/:id", auth, (req, res) => {
  try {
    db.prepare("DELETE FROM clients WHERE id=? AND user_id=?").run(req.params.id,req.user.id);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── REPORTS ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/reports/sales-register", auth, (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    let q = "SELECT * FROM invoices WHERE user_id=? AND invoice_type='SALES'";
    const params = [req.user.id];
    if (from_date) { q+=" AND invoice_date>=?"; params.push(from_date); }
    if (to_date)   { q+=" AND invoice_date<=?"; params.push(to_date); }
    q+=" ORDER BY invoice_date ASC";
    const invoices = db.prepare(q).all(...params);
    res.json({ success:true, invoices, summary:{ total_invoices:invoices.length, total_taxable:invoices.reduce((a,i)=>a+(i.taxable_amount||0),0), total_igst:invoices.reduce((a,i)=>a+(i.igst_amount||0),0), total_cgst:invoices.reduce((a,i)=>a+(i.cgst_amount||0),0), total_sgst:invoices.reduce((a,i)=>a+(i.sgst_amount||0),0), total_amount:invoices.reduce((a,i)=>a+(i.total_amount||0),0) } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/reports/purchase-register", auth, (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    let q = "SELECT * FROM invoices WHERE user_id=? AND invoice_type='PURCHASE'";
    const params = [req.user.id];
    if (from_date) { q+=" AND invoice_date>=?"; params.push(from_date); }
    if (to_date)   { q+=" AND invoice_date<=?"; params.push(to_date); }
    q+=" ORDER BY invoice_date ASC";
    const invoices = db.prepare(q).all(...params);
    res.json({ success:true, invoices, summary:{ total_invoices:invoices.length, total_taxable:invoices.reduce((a,i)=>a+(i.taxable_amount||0),0), total_amount:invoices.reduce((a,i)=>a+(i.total_amount||0),0) } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/reports/gst-summary", auth, (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const uid = req.user.id;
    let where = "";
    const params = [uid];
    if (from_date) { where+=" AND invoice_date>=?"; params.push(from_date); }
    if (to_date)   { where+=" AND invoice_date<=?"; params.push(to_date); }
    const s = db.prepare(`SELECT COALESCE(SUM(taxable_amount),0) as taxable,COALESCE(SUM(igst_amount),0) as igst,COALESCE(SUM(cgst_amount),0) as cgst,COALESCE(SUM(sgst_amount),0) as sgst,COALESCE(SUM(total_amount),0) as total FROM invoices WHERE user_id=? AND invoice_type='SALES'${where}`).get(...params);
    const p = db.prepare(`SELECT COALESCE(SUM(taxable_amount),0) as taxable,COALESCE(SUM(igst_amount),0) as igst,COALESCE(SUM(cgst_amount),0) as cgst,COALESCE(SUM(sgst_amount),0) as sgst,COALESCE(SUM(total_amount),0) as total FROM invoices WHERE user_id=? AND invoice_type='PURCHASE'${where}`).get(...params);
    const outputTax = (s.igst||0)+(s.cgst||0)+(s.sgst||0);
    const inputTax  = (p.igst||0)+(p.cgst||0)+(p.sgst||0);
    res.json({ success:true, report:{ sales:s, purchase:p, output_tax:outputTax, input_tax:inputTax, net_gst_payable:outputTax-inputTax } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/reports/outstanding", auth, (req, res) => {
  try {
    const rows = db.prepare("SELECT party_name,party_gstin,COUNT(*) as invoice_count,SUM(total_amount) as total_billed,SUM(paid_amount) as total_paid,SUM(balance_due) as outstanding,MIN(due_date) as oldest_due FROM invoices WHERE user_id=? AND status IN ('unpaid','partial') AND invoice_type='SALES' GROUP BY party_name,party_gstin ORDER BY outstanding DESC").all(req.user.id);
    res.json({ success:true, parties:rows, total_outstanding:rows.reduce((a,r)=>a+(r.outstanding||0),0) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/reports/profit-loss", auth, (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const uid = req.user.id;
    let where = "";
    const params = [uid];
    if (from_date) { where+=" AND invoice_date>=?"; params.push(from_date); }
    if (to_date)   { where+=" AND invoice_date<=?"; params.push(to_date); }
    const sales    = db.prepare(`SELECT COALESCE(SUM(taxable_amount),0) as total FROM invoices WHERE user_id=? AND invoice_type='SALES'${where}`).get(...params).total;
    const purchases= db.prepare(`SELECT COALESCE(SUM(taxable_amount),0) as total FROM invoices WHERE user_id=? AND invoice_type='PURCHASE'${where}`).get(...params).total;
    const gross    = sales - purchases;
    res.json({ success:true, pl:{ income:{ sales, total:sales }, expenses:{ purchases, total:purchases }, gross_profit:gross, net_profit:gross } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/reports/day-book", auth, (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const invoices = db.prepare("SELECT * FROM invoices WHERE user_id=? AND invoice_date=? ORDER BY created_at ASC").all(req.user.id,date);
    const payments = db.prepare("SELECT * FROM payments WHERE user_id=? AND payment_date=? ORDER BY created_at ASC").all(req.user.id,date);
    res.json({ success:true, date, invoices, payments, summary:{ total_sales:invoices.filter(i=>i.invoice_type==="SALES").reduce((a,i)=>a+(i.total_amount||0),0), total_purchases:invoices.filter(i=>i.invoice_type==="PURCHASE").reduce((a,i)=>a+(i.total_amount||0),0), total_received:payments.filter(p=>p.type==="RECEIVED").reduce((a,p)=>a+(p.amount||0),0), total_paid:payments.filter(p=>p.type==="PAID").reduce((a,p)=>a+(p.amount||0),0) } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── BANK STATEMENT ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
const guessCategory = (desc) => {
  const d = (desc||"").toLowerCase();
  if (d.includes("salary")||d.includes("payroll")||d.includes("wages")) return "Salary";
  if (d.includes("rent")) return "Rent";
  if (d.includes("gst")||d.includes("tds")) return "Tax Payment";
  if (d.includes("electricity")||d.includes("water")||d.includes("utility")||d.includes("bescom")||d.includes("bses")) return "Utilities";
  if (d.includes("neft")||d.includes("rtgs")||d.includes("imps")) return "Fund Transfer";
  if (d.includes("atm")||d.includes("cash")) return "Cash";
  if (d.includes("emi")||d.includes("loan")) return "Loan Payment";
  if (d.includes("interest")||d.includes("int ")) return "Interest";
  if (d.includes("charges")||d.includes("fee")||d.includes("commission")) return "Bank Charges";
  if (d.includes("insurance")||d.includes("premium")||d.includes("lic")) return "Insurance";
  if (d.includes("purchase")||d.includes("vendor")||d.includes("supplier")) return "Purchase";
  if (d.includes("sale")||d.includes("receipt")||d.includes("payment rcv")) return "Sales Receipt";
  if (d.includes("amazon")||d.includes("flipkart")||d.includes("online")) return "Online Purchase";
  if (d.includes("petrol")||d.includes("fuel")||d.includes("diesel")) return "Fuel";
  if (d.includes("medical")||d.includes("hospital")||d.includes("pharma")) return "Medical";
  if (d.includes("swiggy")||d.includes("zomato")||d.includes("food")) return "Food & Dining";
  if (d.includes("travel")||d.includes("flight")||d.includes("hotel")) return "Travel";
  return "Uncategorized";
};

const guessType = (desc, isDebit) => {
  const d = (desc||"").toLowerCase();
  if (d.includes("gst")||d.includes("tds")||d.includes("tax")) return "TAX";
  if (d.includes("neft")||d.includes("rtgs")||d.includes("imps")||d.includes("transfer")) return "TRANSFER";
  if (d.includes("emi")||d.includes("loan")||d.includes("charges")||d.includes("fee")) return "BANK";
  if (!isDebit) return "INCOME";
  if (d.includes("salary")||d.includes("rent")||d.includes("utility")||d.includes("vendor")) return "EXPENSE";
  if (d.includes("purchase")||d.includes("supplier")) return "PURCHASE";
  return isDebit ? "EXPENSE" : "INCOME";
};

const parseTransactions = (text) => {
  const lines = text.split("\n").map(l=>l.trim()).filter(l=>l.length>5);
  const transactions = [];
  const dateReg = /(\d{2}[\/\-]\d{2}[\/\-]\d{4}|\d{2}[\/\-]\d{2}[\/\-]\d{2}|\d{2}\s+[A-Za-z]{3}\s+\d{4})/;
  const amtReg  = /(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;

  for (const line of lines) {
    const dateMatch = line.match(dateReg);
    if (!dateMatch) continue;
    const dateStr = dateMatch[1];
    const amounts = [];
    let m;
    while ((m=amtReg.exec(line))!==null) {
      const v = parseFloat(m[1].replace(/,/g,""));
      if (v>0) amounts.push(v);
    }
    if (amounts.length<2) continue;
    let desc = line.replace(dateStr,"").replace(/\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g,"").replace(/[Dr|Cr]+/g,"").replace(/\s+/g," ").trim();
    if (!desc||desc.length<3) continue;
    const isDebit = line.toLowerCase().includes("dr") || line.toLowerCase().includes("debit");
    const debit  = isDebit ? amounts[amounts.length-3]||amounts[0]||0 : 0;
    const credit = !isDebit ? amounts[amounts.length-2]||amounts[0]||0 : 0;
    const category = guessCategory(desc);
    const type     = guessType(desc, isDebit);
    transactions.push({ txn_date:dateStr.replace(/(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})/,(_,d,mo,y)=>`${y.length===2?"20"+y:y}-${mo}-${d}`), description:desc.substring(0,200), debit, credit, balance:amounts[amounts.length-1]||0, category, type });
  }
  return transactions;
};

app.post("/api/bank/upload", upload.single("file"), auth, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success:false, message:"PDF file required" });
    let text = "";
    try {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(req.file.buffer);
      text = data.text;
    } catch(e) { return res.status(400).json({ success:false, message:"Could not read PDF. Use a digital PDF, not scanned." }); }
    if (!text||text.length<50) return res.status(400).json({ success:false, message:"No text found in PDF." });
    const transactions = parseTransactions(text);
    if (transactions.length===0) return res.status(400).json({ success:false, message:"No transactions found. Ensure this is a bank statement PDF." });
    const totalDebit  = transactions.reduce((a,t)=>a+(t.debit||0),0);
    const totalCredit = transactions.reduce((a,t)=>a+(t.credit||0),0);
    res.json({ success:true, message:`Found ${transactions.length} transactions`, preview:{ bank_name:req.body.bank_name||"Unknown Bank", account_no:req.body.account_no||"", total_txns:transactions.length, total_debit:totalDebit, total_credit:totalCredit, transactions } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/bank/import", auth, (req, res) => {
  try {
    const { bank_name, account_no, transactions } = req.body;
    if (!transactions||transactions.length===0) return res.status(400).json({ success:false, message:"No transactions" });
    const importId = uuid();
    const totalDebit  = transactions.reduce((a,t)=>a+(t.debit||0),0);
    const totalCredit = transactions.reduce((a,t)=>a+(t.credit||0),0);
    db.prepare("INSERT INTO bank_imports (id,user_id,bank_name,account_no,total_txns,total_debit,total_credit,filename) VALUES (?,?,?,?,?,?,?,?)").run(importId,req.user.id,bank_name||"Unknown",account_no||"",transactions.length,totalDebit,totalCredit,`statement_${Date.now()}.pdf`);
    const insertTxn = db.prepare("INSERT INTO bank_transactions (id,user_id,bank_name,account_no,txn_date,description,debit,credit,balance,category,type,import_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    const insertMany = db.transaction((txns) => { for (const t of txns) insertTxn.run(uuid(),req.user.id,bank_name||"Unknown",account_no||"",t.txn_date,t.description,t.debit||0,t.credit||0,t.balance||0,t.category||"Uncategorized",t.type||"UNKNOWN",importId); });
    insertMany(transactions);
    res.json({ success:true, message:`${transactions.length} transactions imported successfully!`, import_id:importId });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/bank/transactions", auth, (req, res) => {
  try {
    const { type, from_date, to_date, search } = req.query;
    let q = "SELECT * FROM bank_transactions WHERE user_id=?";
    const params = [req.user.id];
    if (type&&type!=="all") { q+=" AND type=?"; params.push(type); }
    if (from_date) { q+=" AND txn_date>=?"; params.push(from_date); }
    if (to_date)   { q+=" AND txn_date<=?"; params.push(to_date); }
    if (search)    { q+=" AND description LIKE ?"; params.push(`%${search}%`); }
    q+=" ORDER BY txn_date DESC, created_at DESC";
    const rows = db.prepare(q).all(...params);
    const totalDebit  = rows.reduce((a,t)=>a+(t.debit||0),0);
    const totalCredit = rows.reduce((a,t)=>a+(t.credit||0),0);
    res.json({ success:true, count:rows.length, transactions:rows, summary:{ total_debit:totalDebit, total_credit:totalCredit, net:totalCredit-totalDebit } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/bank/imports", auth, (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM bank_imports WHERE user_id=? ORDER BY created_at DESC").all(req.user.id);
    res.json({ success:true, imports:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.patch("/api/bank/transactions/:id", auth, (req, res) => {
  try {
    const { category, type, notes } = req.body;
    db.prepare("UPDATE bank_transactions SET category=?,type=?,notes=? WHERE id=? AND user_id=?").run(category,type,notes||null,req.params.id,req.user.id);
    res.json({ success:true, message:"Updated" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── AI ROUTES ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/ai/chat", auth, async (req, res) => {
  try {
    const reply = await callGroq(req.body.messages||[], "You are an expert Indian GST consultant and accounting professional. Help with GST compliance, ITC, notices, returns, reconciliation, and accounting queries. Be concise and cite relevant sections. Use Rs. for rupees.");
    res.json({ success:true, reply });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/ai/generate-reply", auth, async (req, res) => {
  try {
    const { client_name, gstin, notice_type, ref_no, amount, description } = req.body;
    const prompt = `Generate a professional GST notice reply:\nClient: ${client_name}\nGSTIN: ${gstin}\nNotice Type: ${notice_type}\nRef No: ${ref_no}\nAmount: Rs.${amount}\nDetails: ${description||"Not provided"}\n\nWrite a formal reply citing relevant CGST Act sections.`;
    const reply = await callGroq([{ role:"user", content:prompt }], "You are an expert GST lawyer. Write formal, professional notice replies to GST department notices.");
    res.json({ success:true, reply });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── CHALLANS ──────────────────────────────────────────────────────────────
app.get("/api/challans", auth, (req, res) => {
  try {
    const rows = db.prepare("SELECT ch.*,c.name as client_name,c.gstin FROM challans ch JOIN clients c ON ch.client_id=c.id WHERE ch.user_id=? ORDER BY ch.created_at DESC").all(req.user.id);
    res.json({ success:true, challans:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/challans", auth, (req, res) => {
  try {
    const { client_id, challan_no, type, amount, period, payment_date, notes } = req.body;
    const id = uuid();
    db.prepare("INSERT INTO challans (id,user_id,client_id,challan_no,type,amount,period,payment_date,notes) VALUES (?,?,?,?,?,?,?,?,?)").run(id,req.user.id,client_id,challan_no,type,parseFloat(amount)||0,period||null,payment_date,notes||null);
    res.status(201).json({ success:true, message:"Challan added" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/challans/:id", auth, (req, res) => {
  try {
    db.prepare("DELETE FROM challans WHERE id=? AND user_id=?").run(req.params.id,req.user.id);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── IMPORT EXCEL ──────────────────────────────────────────────────────────
app.post("/api/import/clients", upload.single("file"), auth, (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer,{ type:"buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    let imported=0, skipped=0;
    for (const row of rows) {
      const gstin=(row["GSTIN"]||row["gstin"]||"").toString().trim().toUpperCase();
      const name=(row["Name"]||row["name"]||row["Trade Name"]||"").toString().trim();
      if (!gstin||!name){ skipped++; continue; }
      const exists=db.prepare("SELECT id FROM clients WHERE user_id=? AND gstin=?").get(req.user.id,gstin);
      if (exists){ skipped++; continue; }
      db.prepare("INSERT INTO clients (id,user_id,name,gstin,state,type,status) VALUES (?,?,?,?,?,?,'compliant')").run(uuid(),req.user.id,name,gstin,(row["State"]||row["state"]||"").toString().trim(),(row["Type"]||row["type"]||"Trader").toString().trim());
      imported++;
    }
    res.json({ success:true, message:`${imported} clients imported, ${skipped} skipped` });
  } catch(e) { res.status(500).json({ success:false, message:"Import failed: "+e.message }); }
});

// ── GSTR-2A PREVIEW & IMPORT ──────────────────────────────────────────────
app.post("/api/gstr2a/preview", upload.single("file"), auth, (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer,{ type:"buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:"" });
    const grouped = {};
    for (const row of rows) {
      const gstin=(row["GSTIN of Supplier"]||row["GSTIN"]||row["gstin"]||row["ctin"]||"").toString().trim().toUpperCase();
      if (!gstin||gstin.length<15) continue;
      const name=(row["Trade/Legal name of the Supplier"]||row["Trade Name"]||row["Supplier Name"]||row["trdnm"]||"").toString().trim();
      const igst=parseFloat(row["Integrated Tax Amount"]||row["IGST Amount"]||row["iamt"]||0)||0;
      const cgst=parseFloat(row["Central Tax Amount"]||row["CGST Amount"]||row["camt"]||0)||0;
      const sgst=parseFloat(row["State/UT Tax Amount"]||row["SGST Amount"]||row["samt"]||0)||0;
      const itc=igst+cgst+sgst;
      if (!grouped[gstin]) grouped[gstin]={ gstin, name, invoices:0, igst:0, cgst:0, sgst:0, itc:0 };
      grouped[gstin].invoices++; grouped[gstin].igst+=igst; grouped[gstin].cgst+=cgst; grouped[gstin].sgst+=sgst; grouped[gstin].itc+=itc;
    }
    const suppliers=Object.values(grouped);
    res.json({ success:true, preview:{ total_invoices:rows.length, total_suppliers:suppliers.length, total_itc:suppliers.reduce((a,s)=>a+s.itc,0), suppliers } });
  } catch(e) { res.status(500).json({ success:false, message:"Preview failed: "+e.message }); }
});

app.post("/api/gstr2a/import", upload.single("file"), auth, (req, res) => {
  try {
    const { client_id, period } = req.body;
    const wb = XLSX.read(req.file.buffer,{ type:"buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval:"" });
    const grouped = {};
    for (const row of rows) {
      const gstin=(row["GSTIN of Supplier"]||row["GSTIN"]||row["gstin"]||row["ctin"]||"").toString().trim().toUpperCase();
      if (!gstin||gstin.length<15) continue;
      const name=(row["Trade/Legal name of the Supplier"]||row["Trade Name"]||row["trdnm"]||"").toString().trim();
      const itc=(parseFloat(row["Integrated Tax Amount"]||row["iamt"]||0)||0)+(parseFloat(row["Central Tax Amount"]||row["camt"]||0)||0)+(parseFloat(row["State/UT Tax Amount"]||row["samt"]||0)||0);
      if (!grouped[gstin]) grouped[gstin]={ gstin, name, count:0, itc:0 };
      grouped[gstin].count++; grouped[gstin].itc+=itc;
    }
    const suppliers=Object.values(grouped);
    let saved=0;
    for (const s of suppliers) {
      const diff=s.itc-0, status="mismatch";
      db.prepare("INSERT OR IGNORE INTO reconciliation (id,user_id,client_id,period,vendor_name,vendor_gstin,invoice_count,gstr2a_amount,gstr2b_amount,books_amount,difference,status,remarks) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,'Imported from GSTR-2A')").run(uuid(),req.user.id,client_id,period,s.name,s.gstin,s.count,s.itc,s.itc,diff,status);
      saved++;
    }
    res.json({ success:true, message:`${saved} suppliers imported to Reconciliation!`, summary:{ total_invoices:rows.length, saved, total_itc:suppliers.reduce((a,s)=>a+s.itc,0) } });
  } catch(e) { res.status(500).json({ success:false, message:"Import failed: "+e.message }); }
});

// ── GSTIN VERIFY ──────────────────────────────────────────────────────────
const STATES_MAP = {"01":"Jammu & Kashmir","02":"Himachal Pradesh","03":"Punjab","04":"Chandigarh","05":"Uttarakhand","06":"Haryana","07":"Delhi","08":"Rajasthan","09":"Uttar Pradesh","10":"Bihar","11":"Sikkim","18":"Assam","19":"West Bengal","20":"Jharkhand","21":"Odisha","22":"Chhattisgarh","23":"Madhya Pradesh","24":"Gujarat","27":"Maharashtra","29":"Karnataka","30":"Goa","32":"Kerala","33":"Tamil Nadu","36":"Telangana","37":"Andhra Pradesh"};
app.get("/api/gstin/validate/:gstin", auth, (req, res) => {
  const g = req.params.gstin.toUpperCase().trim();
  const valid = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(g);
  if (!valid) return res.json({ success:true, valid:false, message:"Invalid GSTIN format" });
  res.json({ success:true, valid:true, message:"Valid GSTIN format", details:{ gstin:g, state_code:g.substring(0,2), state:STATES_MAP[g.substring(0,2)]||"Unknown", pan:g.substring(2,12) } });
});

// ── STAFF ─────────────────────────────────────────────────────────────────
app.get("/api/staff", auth, (req, res) => {
  try {
    const rows = db.prepare("SELECT id,name,email,role,firm_name,created_at FROM users WHERE parent_id=?").all(req.user.id);
    res.json({ success:true, staff:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/staff", auth, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name||!email||!password) return res.status(400).json({ success:false, message:"All fields required" });
    const exists = db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
    if (exists) return res.status(409).json({ success:false, message:"Email already exists" });
    const hashed = await bcrypt.hash(password, 12);
    const id = uuid();
    db.prepare("INSERT INTO users (id,name,email,password,firm_name,role,parent_id) VALUES (?,?,?,?,?,'staff',?)").run(id,name,email.toLowerCase(),hashed,req.user.firm_name,req.user.id);
    res.status(201).json({ success:true, message:"Staff added", staff:{ id,name,email,role:"staff" } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/staff/:id", auth, (req, res) => {
  try {
    db.prepare("DELETE FROM users WHERE id=? AND parent_id=?").run(req.params.id,req.user.id);
    res.json({ success:true, message:"Staff removed" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── Health ────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ success:true, message:"TaxPro Complete v3.0", db:"SQLite" }));
app.use((req, res) => res.status(404).json({ success:false, message:`Route ${req.method} ${req.url} not found` }));

app.listen(PORT, () => {
  console.log(`\n🚀 TaxPro Complete running on http://localhost:${PORT}`);
  console.log(`📋 Environment: ${process.env.NODE_ENV||"development"}\n`);
});
app.use("/api/accounting", require("./routes/accounting"));

module.exports = app;