
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
const { Pool }   = require("pg");
const path       = require("path");

const app  = express();
const PORT = process.env.PORT || 5000;
const JWT  = process.env.JWT_SECRET || "taxpro_secret_2024";

// ── Database (PostgreSQL) ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

// Helper: run a query
const db = {
  query: (text, params) => pool.query(text, params),
  get: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows[0] || null;
  },
  all: async (text, params) => {
    const res = await pool.query(text, params);
    return res.rows;
  },
  run: async (text, params) => {
    const res = await pool.query(text, params);
    return res;
  }
};

// ── Init Tables ────────────────────────────────────────────────────────────
const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, firm_name TEXT, frn TEXT, role TEXT DEFAULT 'ca',
      parent_id TEXT, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      gstin TEXT, state TEXT, type TEXT DEFAULT 'Trader', turnover TEXT,
      status TEXT DEFAULT 'compliant', notes TEXT, phone TEXT, email TEXT,
      address TEXT, city TEXT, pincode TEXT, pan TEXT, credit_limit REAL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS notices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
      ref_no TEXT NOT NULL, type TEXT NOT NULL, issued_date TEXT NOT NULL,
      due_date TEXT NOT NULL, amount REAL DEFAULT 0, status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'medium', description TEXT, reply_text TEXT,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
      period TEXT NOT NULL, gstr1_status TEXT DEFAULT 'not-filed',
      gstr3b_status TEXT DEFAULT 'not-filed', gstr9_status TEXT DEFAULT 'not-filed',
      gstr1_date TEXT, gstr3b_date TEXT, gstr9_date TEXT, notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, client_id, period)
    );
    CREATE TABLE IF NOT EXISTS reconciliation (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
      period TEXT NOT NULL, vendor_name TEXT NOT NULL, vendor_gstin TEXT NOT NULL,
      invoice_count INTEGER DEFAULT 0, gstr2a_amount REAL DEFAULT 0,
      gstr2b_amount REAL DEFAULT 0, books_amount REAL DEFAULT 0,
      difference REAL DEFAULT 0, status TEXT DEFAULT 'pending', remarks TEXT,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS challans (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
      challan_no TEXT NOT NULL, type TEXT NOT NULL, amount REAL DEFAULT 0,
      period TEXT, payment_date TEXT, status TEXT DEFAULT 'paid', notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      code TEXT, hsn_sac TEXT, unit TEXT DEFAULT 'PCS', category TEXT,
      gst_rate REAL DEFAULT 18, purchase_price REAL DEFAULT 0,
      sale_price REAL DEFAULT 0, stock_qty REAL DEFAULT 0, min_stock REAL DEFAULT 0,
      description TEXT, is_service INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
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
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
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
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, invoice_id TEXT,
      party_id TEXT, party_name TEXT, type TEXT DEFAULT 'RECEIVED',
      amount REAL DEFAULT 0, method TEXT DEFAULT 'CASH', reference_no TEXT,
      payment_date TEXT NOT NULL, notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bank_name TEXT,
      account_no TEXT, txn_date TEXT NOT NULL, description TEXT NOT NULL,
      ref_no TEXT, debit REAL DEFAULT 0, credit REAL DEFAULT 0,
      balance REAL DEFAULT 0, category TEXT DEFAULT 'Uncategorized',
      sub_category TEXT, type TEXT DEFAULT 'UNKNOWN', is_reconciled INTEGER DEFAULT 0,
      notes TEXT, import_id TEXT, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bank_imports (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bank_name TEXT,
      account_no TEXT, from_date TEXT, to_date TEXT, total_txns INTEGER DEFAULT 0,
      total_debit REAL DEFAULT 0, total_credit REAL DEFAULT 0, filename TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("✅ Database initialised");
};

initDB().catch(console.error);

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

// ── Groq AI ───────────────────────────────────────────────────────────────
const callGroq = (messages, system) => new Promise((resolve) => {
  if (!process.env.GROQ_API_KEY) return resolve("Groq API key not configured.");
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
    const exists = await db.get("SELECT id FROM users WHERE email=$1", [email.toLowerCase().trim()]);
    if (exists) return res.status(409).json({ success:false, message:"Email already registered. Please login." });
    const hashed = await bcrypt.hash(password, 12);
    const id = uuid();
    await db.run("INSERT INTO users (id,name,email,password,firm_name,frn,role) VALUES ($1,$2,$3,$4,$5,$6,'ca')", [id, name.trim(), email.toLowerCase().trim(), hashed, firm_name.trim(), frn||null]);
    const token = jwt.sign({ id, name:name.trim(), email:email.toLowerCase().trim(), firm_name:firm_name.trim(), role:"ca" }, JWT, { expiresIn:"7d" });
    res.status(201).json({ success:true, token, user:{ id, name:name.trim(), email:email.toLowerCase().trim(), firm_name:firm_name.trim(), frn:frn||null, role:"ca" } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email||!password) return res.status(400).json({ success:false, message:"Email and password required" });
    const user = await db.get("SELECT * FROM users WHERE email=$1", [email.toLowerCase().trim()]);
    if (!user) return res.status(401).json({ success:false, message:"Invalid email or password" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success:false, message:"Invalid email or password" });
    const token = jwt.sign({ id:user.id, name:user.name, email:user.email, firm_name:user.firm_name, role:user.role }, JWT, { expiresIn:"7d" });
    res.json({ success:true, token, user:{ id:user.id, name:user.name, email:user.email, firm_name:user.firm_name, frn:user.frn, role:user.role } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/auth/me", auth, async (req, res) => {
  const user = await db.get("SELECT id,name,email,firm_name,frn,role,created_at FROM users WHERE id=$1", [req.user.id]);
  if (!user) return res.status(404).json({ success:false, message:"User not found" });
  res.json({ success:true, user });
});

// ══════════════════════════════════════════════════════════════════════════
// ── DASHBOARD ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/dashboard", auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const today = new Date().toISOString().split("T")[0];
    const in30  = new Date(Date.now()+30*24*60*60*1000).toISOString().split("T")[0];
    const totalC    = (await db.get("SELECT COUNT(*) as c FROM clients WHERE user_id=$1", [uid])).c;
    const compliant = (await db.get("SELECT COUNT(*) as c FROM clients WHERE user_id=$1 AND status='compliant'", [uid])).c;
    const openN     = (await db.get("SELECT COUNT(*) as c FROM notices WHERE user_id=$1 AND status NOT IN ('closed','replied')", [uid])).c;
    const due30     = (await db.get("SELECT COUNT(*) as c FROM notices WHERE user_id=$1 AND due_date BETWEEN $2 AND $3 AND status NOT IN ('closed','replied')", [uid,today,in30])).c;
    const upcoming  = await db.all("SELECT n.*,c.name as client_name FROM notices n JOIN clients c ON n.client_id=c.id WHERE n.user_id=$1 AND n.due_date BETWEEN $2 AND $3 AND n.status NOT IN ('closed','replied') ORDER BY n.due_date ASC LIMIT 5", [uid,today,in30]);
    const recent    = await db.all("SELECT * FROM clients WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5", [uid]);
    res.json({ success:true, dashboard:{ clients:{ total:parseInt(totalC), compliant:parseInt(compliant) }, notices:{ open:parseInt(openN), due_in_30_days:parseInt(due30) }, upcoming_notices:upcoming, recent_clients:recent } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── CLIENTS ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/clients", auth, async (req, res) => {
  try {
    const { search, status } = req.query;
    let q = "SELECT * FROM clients WHERE user_id=$1";
    const params = [req.user.id];
    let i = 2;
    if (search) { q += ` AND (name ILIKE $${i} OR gstin ILIKE $${i+1})`; params.push(`%${search}%`,`%${search}%`); i+=2; }
    if (status) { q += ` AND status=$${i}`; params.push(status); i++; }
    q += " ORDER BY name ASC";
    res.json({ success:true, clients: await db.all(q, params) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/clients", auth, async (req, res) => {
  try {
    const { name, gstin, state, type, turnover, notes, phone, email, address, city, pincode, pan } = req.body;
    if (!name) return res.status(400).json({ success:false, message:"Name is required" });
    const id = uuid();
    await db.run("INSERT INTO clients (id,user_id,name,gstin,state,type,turnover,notes,phone,email,address,city,pincode,pan) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [id,req.user.id,name,gstin?.toUpperCase()||null,state||null,type||"Trader",turnover||null,notes||null,phone||null,email||null,address||null,city||null,pincode||null,pan||null]);
    res.status(201).json({ success:true, message:"Client added", client: await db.get("SELECT * FROM clients WHERE id=$1", [id]) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.put("/api/clients/:id", auth, async (req, res) => {
  try {
    const c = await db.get("SELECT id FROM clients WHERE id=$1 AND user_id=$2", [req.params.id,req.user.id]);
    if (!c) return res.status(404).json({ success:false, message:"Not found" });
    const { name, gstin, state, type, turnover, notes, status, phone, email, address, city, pincode, pan } = req.body;
    await db.run("UPDATE clients SET name=$1,gstin=$2,state=$3,type=$4,turnover=$5,notes=$6,status=$7,phone=$8,email=$9,address=$10,city=$11,pincode=$12,pan=$13,updated_at=NOW() WHERE id=$14", [name,gstin?.toUpperCase()||null,state||null,type||"Trader",turnover||null,notes||null,status||"compliant",phone||null,email||null,address||null,city||null,pincode||null,pan||null,req.params.id]);
    res.json({ success:true, message:"Updated", client: await db.get("SELECT * FROM clients WHERE id=$1", [req.params.id]) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/clients/:id", auth, async (req, res) => {
  try {
    await db.run("DELETE FROM clients WHERE id=$1 AND user_id=$2", [req.params.id,req.user.id]);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── NOTICES ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/notices", auth, async (req, res) => {
  try {
    const { status, client_id } = req.query;
    let q = "SELECT n.*,c.name as client_name,c.gstin FROM notices n JOIN clients c ON n.client_id=c.id WHERE n.user_id=$1";
    const params = [req.user.id]; let i=2;
    if (status && status!=="all") { q+=` AND n.status=$${i}`; params.push(status); i++; }
    if (client_id) { q+=` AND n.client_id=$${i}`; params.push(client_id); }
    q+=" ORDER BY n.due_date ASC";
    res.json({ success:true, notices: await db.all(q, params) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/notices", auth, async (req, res) => {
  try {
    const { client_id, ref_no, type, issued_date, due_date, amount, priority, description } = req.body;
    if (!client_id||!ref_no||!type||!issued_date||!due_date) return res.status(400).json({ success:false, message:"Required fields missing" });
    const today = new Date().toISOString().split("T")[0];
    const status = new Date(due_date) < new Date(today) ? "overdue" : "pending";
    const id = uuid();
    await db.run("INSERT INTO notices (id,user_id,client_id,ref_no,type,issued_date,due_date,amount,status,priority,description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [id,req.user.id,client_id,ref_no,type,issued_date,due_date,parseFloat(amount)||0,status,priority||"medium",description||null]);
    res.status(201).json({ success:true, message:"Notice added", notice: await db.get("SELECT * FROM notices WHERE id=$1", [id]) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.patch("/api/notices/:id/status", auth, async (req, res) => {
  try {
    await db.run("UPDATE notices SET status=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3", [req.body.status,req.params.id,req.user.id]);
    res.json({ success:true, message:"Updated" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/notices/:id", auth, async (req, res) => {
  try {
    await db.run("DELETE FROM notices WHERE id=$1 AND user_id=$2", [req.params.id,req.user.id]);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── RETURNS ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/returns", auth, async (req, res) => {
  try {
    const { period, client_id } = req.query;
    let q = "SELECT r.*,c.name as client_name,c.gstin FROM returns r JOIN clients c ON r.client_id=c.id WHERE r.user_id=$1";
    const params = [req.user.id]; let i=2;
    if (period) { q+=` AND r.period=$${i}`; params.push(period); i++; }
    if (client_id) { q+=` AND r.client_id=$${i}`; params.push(client_id); }
    q+=" ORDER BY c.name ASC";
    res.json({ success:true, returns: await db.all(q, params) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/returns", auth, async (req, res) => {
  try {
    const { client_id, period, gstr1_status, gstr3b_status, gstr9_status } = req.body;
    if (!client_id||!period) return res.status(400).json({ success:false, message:"client_id and period required" });
    const exists = await db.get("SELECT id FROM returns WHERE user_id=$1 AND client_id=$2 AND period=$3", [req.user.id,client_id,period]);
    if (exists) return res.status(409).json({ success:false, message:"Record already exists for this period" });
    const id = uuid();
    await db.run("INSERT INTO returns (id,user_id,client_id,period,gstr1_status,gstr3b_status,gstr9_status) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id,req.user.id,client_id,period,gstr1_status||"not-filed",gstr3b_status||"not-filed",gstr9_status||"not-filed"]);
    res.status(201).json({ success:true, message:"Saved", return: await db.get("SELECT * FROM returns WHERE id=$1", [id]) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.put("/api/returns/:id", auth, async (req, res) => {
  try {
    const { gstr1_status, gstr3b_status, gstr9_status } = req.body;
    await db.run("UPDATE returns SET gstr1_status=$1,gstr3b_status=$2,gstr9_status=$3,updated_at=NOW() WHERE id=$4 AND user_id=$5", [gstr1_status,gstr3b_status,gstr9_status,req.params.id,req.user.id]);
    res.json({ success:true, message:"Updated" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── RECONCILIATION ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/reconciliation", auth, async (req, res) => {
  try {
    const { client_id, period } = req.query;
    if (!client_id||!period) return res.status(400).json({ success:false, message:"client_id and period required" });
    const rows = await db.all("SELECT * FROM reconciliation WHERE user_id=$1 AND client_id=$2 AND period=$3 ORDER BY vendor_name ASC", [req.user.id,client_id,period]);
    res.json({ success:true, rows, summary:{ matched:rows.filter(r=>r.status==="matched").length, mismatch:rows.filter(r=>r.status==="mismatch").length, missing:rows.filter(r=>r.status==="missing").length, total_itc_risk:rows.reduce((a,r)=>a+(r.difference||0),0) } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/reconciliation", auth, async (req, res) => {
  try {
    const { client_id, period, vendor_name, vendor_gstin, invoice_count, gstr2a_amount, gstr2b_amount, books_amount, remarks } = req.body;
    const g2a=parseFloat(gstr2a_amount)||0, g2b=parseFloat(gstr2b_amount)||0, bks=parseFloat(books_amount)||0;
    const diff = g2b - bks;
    const status = g2b===0&&bks>0 ? "missing" : Math.abs(diff)>0 ? "mismatch" : "matched";
    const id = uuid();
    await db.run("INSERT INTO reconciliation (id,user_id,client_id,period,vendor_name,vendor_gstin,invoice_count,gstr2a_amount,gstr2b_amount,books_amount,difference,status,remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [id,req.user.id,client_id,period,vendor_name,vendor_gstin?.toUpperCase()||"",parseInt(invoice_count)||0,g2a,g2b,bks,diff,status,remarks||null]);
    res.status(201).json({ success:true, message:"Added", row: await db.get("SELECT * FROM reconciliation WHERE id=$1", [id]) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/reconciliation/:id", auth, async (req, res) => {
  try {
    await db.run("DELETE FROM reconciliation WHERE id=$1 AND user_id=$2", [req.params.id,req.user.id]);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── PRODUCTS ──────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/products", auth, async (req, res) => {
  try {
    const { search } = req.query;
    let q = "SELECT * FROM products WHERE user_id=$1";
    const params = [req.user.id];
    if (search) { q+=" AND (name ILIKE $2 OR code ILIKE $3)"; params.push(`%${search}%`,`%${search}%`); }
    q+=" ORDER BY name ASC";
    res.json({ success:true, products: await db.all(q, params) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/products", auth, async (req, res) => {
  try {
    const { name, code, hsn_sac, unit, category, gst_rate, purchase_price, sale_price, stock_qty, min_stock, description, is_service } = req.body;
    if (!name) return res.status(400).json({ success:false, message:"Product name required" });
    const id = uuid();
    await db.run("INSERT INTO products (id,user_id,name,code,hsn_sac,unit,category,gst_rate,purchase_price,sale_price,stock_qty,min_stock,description,is_service) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [id,req.user.id,name,code||null,hsn_sac||null,unit||"PCS",category||null,parseFloat(gst_rate)||18,parseFloat(purchase_price)||0,parseFloat(sale_price)||0,parseFloat(stock_qty)||0,parseFloat(min_stock)||0,description||null,is_service?1:0]);
    res.status(201).json({ success:true, message:"Product added", product: await db.get("SELECT * FROM products WHERE id=$1", [id]) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.put("/api/products/:id", auth, async (req, res) => {
  try {
    const { name, code, hsn_sac, unit, category, gst_rate, purchase_price, sale_price, min_stock, description, is_service } = req.body;
    await db.run("UPDATE products SET name=$1,code=$2,hsn_sac=$3,unit=$4,category=$5,gst_rate=$6,purchase_price=$7,sale_price=$8,min_stock=$9,description=$10,is_service=$11,updated_at=NOW() WHERE id=$12 AND user_id=$13", [name,code||null,hsn_sac||null,unit||"PCS",category||null,parseFloat(gst_rate)||18,parseFloat(purchase_price)||0,parseFloat(sale_price)||0,parseFloat(min_stock)||0,description||null,is_service?1:0,req.params.id,req.user.id]);
    res.json({ success:true, message:"Updated", product: await db.get("SELECT * FROM products WHERE id=$1", [req.params.id]) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/products/:id", auth, async (req, res) => {
  try {
    await db.run("DELETE FROM products WHERE id=$1 AND user_id=$2", [req.params.id,req.user.id]);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── INVOICES ──────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/invoices", auth, async (req, res) => {
  try {
    const { type, status, search } = req.query;
    let q = "SELECT * FROM invoices WHERE user_id=$1";
    const params = [req.user.id]; let i=2;
    if (type)   { q+=` AND invoice_type=$${i}`; params.push(type); i++; }
    if (status) { q+=` AND status=$${i}`; params.push(status); i++; }
    if (search) { q+=` AND (party_name ILIKE $${i} OR invoice_no ILIKE $${i+1})`; params.push(`%${search}%`,`%${search}%`); }
    q+=" ORDER BY created_at DESC";
    const invoices = await db.all(q, params);
    res.json({ success:true, count:invoices.length, invoices, summary:{ total_amount:invoices.reduce((a,i)=>a+(parseFloat(i.total_amount)||0),0), total_paid:invoices.reduce((a,i)=>a+(parseFloat(i.paid_amount)||0),0), total_outstanding:invoices.reduce((a,i)=>a+(parseFloat(i.balance_due)||0),0) } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.get("/api/invoices/:id", auth, async (req, res) => {
  try {
    const inv = await db.get("SELECT * FROM invoices WHERE id=$1 AND user_id=$2", [req.params.id,req.user.id]);
    if (!inv) return res.status(404).json({ success:false, message:"Not found" });
    const items    = await db.all("SELECT * FROM invoice_items WHERE invoice_id=$1", [req.params.id]);
    const payments = await db.all("SELECT * FROM payments WHERE invoice_id=$1", [req.params.id]);
    res.json({ success:true, invoice:{ ...inv, items, payments } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/invoices", auth, async (req, res) => {
  try {
    const { invoice_type, party_id, party_name, party_gstin, party_address, party_state, invoice_date, due_date, place_of_supply, is_igst, notes, terms, items=[] } = req.body;
    if (!party_name) return res.status(400).json({ success:false, message:"Party name required" });
    if (!invoice_date) return res.status(400).json({ success:false, message:"Invoice date required" });
    if (items.length===0) return res.status(400).json({ success:false, message:"At least one item required" });
    const cntRow = await db.get("SELECT COUNT(*) as c FROM invoices WHERE user_id=$1 AND invoice_type=$2", [req.user.id,invoice_type||"SALES"]);
    const cnt = parseInt(cntRow.c)+1;
    const prefix = (invoice_type||"SALES")==="SALES"?"INV":(invoice_type==="PURCHASE"?"PUR":"CN");
    const yr = new Date().getFullYear().toString().slice(-2);
    const mo = String(new Date().getMonth()+1).padStart(2,"0");
    const invoice_no = `${prefix}/${yr}-${mo}/${String(cnt).padStart(4,"0")}`;
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
    await db.run("INSERT INTO invoices (id,user_id,invoice_no,invoice_type,party_id,party_name,party_gstin,party_address,party_state,invoice_date,due_date,place_of_supply,is_igst,subtotal,taxable_amount,igst_amount,cgst_amount,sgst_amount,total_tax,total_amount,paid_amount,balance_due,status,notes,terms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,0,$21,'unpaid',$22,$23)", [id,req.user.id,invoice_no,invoice_type||"SALES",party_id||null,party_name,party_gstin||null,party_address||null,party_state||null,invoice_date,due_date||null,place_of_supply||null,is_igst?1:0,subtotal,subtotal,totalIGST,totalCGST,totalSGST,totalTax,totalAmount,totalAmount,notes||null,terms||null]);
    for (const item of processedItems) {
      await db.run("INSERT INTO invoice_items (id,invoice_id,product_id,name,hsn_sac,unit,qty,rate,discount_pct,taxable_value,gst_rate,igst_amount,cgst_amount,sgst_amount,total_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [uuid(),id,item.product_id||null,item.name,item.hsn_sac||null,item.unit||"PCS",item.qty,item.rate,item.discount_pct||0,item.taxable_value,item.gst_rate||0,item.igst_amount,item.cgst_amount,item.sgst_amount,item.total_amount]);
    }
    const inv = await db.get("SELECT * FROM invoices WHERE id=$1", [id]);
    const invItems = await db.all("SELECT * FROM invoice_items WHERE invoice_id=$1", [id]);
    res.status(201).json({ success:true, message:"Invoice created", invoice:{ ...inv, items:invItems } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/invoices/:id/payment", auth, async (req, res) => {
  try {
    const { amount, method, reference_no, payment_date } = req.body;
    const inv = await db.get("SELECT * FROM invoices WHERE id=$1 AND user_id=$2", [req.params.id,req.user.id]);
    if (!inv) return res.status(404).json({ success:false, message:"Not found" });
    const paidAmt = parseFloat(inv.paid_amount)+parseFloat(amount);
    const balance = Math.max(0, parseFloat(inv.total_amount)-paidAmt);
    const status  = balance<=0 ? "paid" : "partial";
    await db.run("UPDATE invoices SET paid_amount=$1,balance_due=$2,status=$3,updated_at=NOW() WHERE id=$4", [paidAmt,balance,status,req.params.id]);
    await db.run("INSERT INTO payments (id,user_id,invoice_id,party_name,type,amount,method,reference_no,payment_date) VALUES ($1,$2,$3,$4,'RECEIVED',$5,$6,$7,$8)", [uuid(),req.user.id,req.params.id,inv.party_name,parseFloat(amount),method||"CASH",reference_no||null,payment_date]);
    res.json({ success:true, message:"Payment recorded", paid_amount:paidAmt, balance_due:balance });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/invoices/:id", auth, async (req, res) => {
  try {
    await db.run("DELETE FROM invoice_items WHERE invoice_id=$1", [req.params.id]);
    await db.run("DELETE FROM invoices WHERE id=$1 AND user_id=$2", [req.params.id,req.user.id]);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── CHALLANS ──────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/challans", auth, async (req, res) => {
  try {
    const rows = await db.all("SELECT ch.*,c.name as client_name,c.gstin FROM challans ch JOIN clients c ON ch.client_id=c.id WHERE ch.user_id=$1 ORDER BY ch.created_at DESC", [req.user.id]);
    res.json({ success:true, challans:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/challans", auth, async (req, res) => {
  try {
    const { client_id, challan_no, type, amount, period, payment_date, notes } = req.body;
    const id = uuid();
    await db.run("INSERT INTO challans (id,user_id,client_id,challan_no,type,amount,period,payment_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [id,req.user.id,client_id,challan_no,type,parseFloat(amount)||0,period||null,payment_date,notes||null]);
    res.status(201).json({ success:true, message:"Challan added" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/challans/:id", auth, async (req, res) => {
  try {
    await db.run("DELETE FROM challans WHERE id=$1 AND user_id=$2", [req.params.id,req.user.id]);
    res.json({ success:true, message:"Deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── STAFF ─────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/staff", auth, async (req, res) => {
  try {
    const rows = await db.all("SELECT id,name,email,role,firm_name,created_at FROM users WHERE parent_id=$1", [req.user.id]);
    res.json({ success:true, staff:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.post("/api/staff", auth, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name||!email||!password) return res.status(400).json({ success:false, message:"All fields required" });
    const exists = await db.get("SELECT id FROM users WHERE email=$1", [email.toLowerCase()]);
    if (exists) return res.status(409).json({ success:false, message:"Email already exists" });
    const hashed = await bcrypt.hash(password, 12);
    const id = uuid();
    await db.run("INSERT INTO users (id,name,email,password,firm_name,role,parent_id) VALUES ($1,$2,$3,$4,$5,'staff',$6)", [id,name,email.toLowerCase(),hashed,req.user.firm_name,req.user.id]);
    res.status(201).json({ success:true, message:"Staff added", staff:{ id,name,email,role:"staff" } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

app.delete("/api/staff/:id", auth, async (req, res) => {
  try {
    await db.run("DELETE FROM users WHERE id=$1 AND parent_id=$2", [req.params.id,req.user.id]);
    res.json({ success:true, message:"Staff removed" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── REPORTS ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/reports/sales-register", auth, async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    let q = "SELECT * FROM invoices WHERE user_id=$1 AND invoice_type='SALES'";
    const params = [req.user.id]; let i=2;
    if (from_date) { q+=` AND invoice_date>=$${i}`; params.push(from_date); i++; }
    if (to_date)   { q+=` AND invoice_date<=$${i}`; params.push(to_date); }
    q+=" ORDER BY invoice_date ASC";
    const invoices = await db.all(q, params);
    res.json({ success:true, invoices, summary:{ total_invoices:invoices.length, total_amount:invoices.reduce((a,i)=>a+(parseFloat(i.total_amount)||0),0) } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
// ── GSTIN VALIDATE ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
const STATES_MAP = {"01":"Jammu & Kashmir","02":"Himachal Pradesh","03":"Punjab","04":"Chandigarh","05":"Uttarakhand","06":"Haryana","07":"Delhi","08":"Rajasthan","09":"Uttar Pradesh","10":"Bihar","11":"Sikkim","18":"Assam","19":"West Bengal","20":"Jharkhand","21":"Odisha","22":"Chhattisgarh","23":"Madhya Pradesh","24":"Gujarat","27":"Maharashtra","29":"Karnataka","30":"Goa","32":"Kerala","33":"Tamil Nadu","36":"Telangana","37":"Andhra Pradesh"};
app.get("/api/gstin/validate/:gstin", auth, (req, res) => {
  const g = req.params.gstin.toUpperCase().trim();
  const valid = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(g);
  if (!valid) return res.json({ success:true, valid:false, message:"Invalid GSTIN format" });
  res.json({ success:true, valid:true, message:"Valid GSTIN format", details:{ gstin:g, state_code:g.substring(0,2), state:STATES_MAP[g.substring(0,2)]||"Unknown", pan:g.substring(2,12) } });
});

// ══════════════════════════════════════════════════════════════════════════
// ── IMPORT EXCEL ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
app.post("/api/import/clients", upload.single("file"), auth, async (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer,{ type:"buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    let imported=0, skipped=0;
    for (const row of rows) {
      const gstin=(row["GSTIN"]||row["gstin"]||"").toString().trim().toUpperCase();
      const name=(row["Name"]||row["name"]||row["Trade Name"]||"").toString().trim();
      if (!gstin||!name){ skipped++; continue; }
      const exists=await db.get("SELECT id FROM clients WHERE user_id=$1 AND gstin=$2", [req.user.id,gstin]);
      if (exists){ skipped++; continue; }
      await db.run("INSERT INTO clients (id,user_id,name,gstin,state,type,status) VALUES ($1,$2,$3,$4,$5,$6,'compliant')", [uuid(),req.user.id,name,gstin,(row["State"]||row["state"]||"").toString().trim(),(row["Type"]||row["type"]||"Trader").toString().trim()]);
      imported++;
    }
    res.json({ success:true, message:`${imported} clients imported, ${skipped} skipped` });
  } catch(e) { res.status(500).json({ success:false, message:"Import failed: "+e.message }); }
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

// ── Health ────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ success:true, message:"TaxPro GST Backend v4.0 - PostgreSQL", db:"PostgreSQL" }));
app.use((req, res) => res.status(404).json({ success:false, message:`Route ${req.method} ${req.url} not found` }));

app.listen(PORT, () => {
  console.log(`\n🚀 TaxPro GST running on http://localhost:${PORT}`);
  console.log(`📋 Environment: ${process.env.NODE_ENV||"development"}\n`);
});

module.exports = app;