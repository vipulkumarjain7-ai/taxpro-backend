require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const jwt     = require("jsonwebtoken");
const bcrypt  = require("bcryptjs");
const { v4: uuid } = require("uuid");
const morgan  = require("morgan");
const multer  = require("multer");
const XLSX    = require("xlsx");
const https   = require("https");
const { Pool }= require("pg");

const app  = express();
const PORT = process.env.PORT || 5000;
const JWT  = process.env.JWT_SECRET || "taxpro_secret_2024";

// Auto-detect SSL for Neon, Supabase, or any cloud PostgreSQL
const sslConfig = process.env.DATABASE_URL?.includes("neon.tech") ||
                  process.env.DATABASE_URL?.includes("supabase.co") ||
                  process.env.DATABASE_URL?.includes("sslmode=require") ||
                  process.env.NODE_ENV === "production"
                  ? { rejectUnauthorized: false } : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  // Connection pool settings for serverless (Neon)
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.connect((err, client, release) => {
  if (err) { console.error("DB Error:", err.message); process.exit(1); }
  release();
  console.log("✅ PostgreSQL connected");
});

const initDB = async () => {
  // ── Run column migrations first (safe to run multiple times) ──
  const migrations = [
    "ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS phone TEXT",
    "ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS email TEXT",
    "ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS address TEXT",
    "ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS city TEXT",
    "ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS pincode TEXT",
    "ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS pan TEXT",
    "ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS credit_limit REAL DEFAULT 0",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS parent_id TEXT",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS gstin TEXT",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS phone TEXT",
    "ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS logo_url TEXT",
    "ALTER TABLE IF EXISTS invoices ADD COLUMN IF NOT EXISTS cess_amount REAL DEFAULT 0",
    "ALTER TABLE IF EXISTS invoices ADD COLUMN IF NOT EXISTS einvoice_irn TEXT",
    "ALTER TABLE IF EXISTS invoice_items ADD COLUMN IF NOT EXISTS discount_pct REAL DEFAULT 0",
    // Fix is_service column type from INTEGER to BOOLEAN
    "ALTER TABLE IF EXISTS products ALTER COLUMN is_service TYPE BOOLEAN USING CASE WHEN is_service=0 THEN FALSE ELSE TRUE END",
    // Company isolation columns
    "ALTER TABLE IF EXISTS invoices ADD COLUMN IF NOT EXISTS company_id TEXT",
    "ALTER TABLE IF EXISTS parties ADD COLUMN IF NOT EXISTS company_id TEXT",
    "ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS company_id TEXT",
    "ALTER TABLE IF EXISTS bank_transactions ADD COLUMN IF NOT EXISTS company_id TEXT",
    "ALTER TABLE IF EXISTS bank_imports ADD COLUMN IF NOT EXISTS company_id TEXT",
    "ALTER TABLE IF EXISTS payments ADD COLUMN IF NOT EXISTS company_id TEXT",
    "ALTER TABLE IF EXISTS notices ADD COLUMN IF NOT EXISTS company_id TEXT",
    "ALTER TABLE IF EXISTS returns ADD COLUMN IF NOT EXISTS company_id TEXT",
    "ALTER TABLE IF EXISTS reconciliation ADD COLUMN IF NOT EXISTS company_id TEXT",
    "ALTER TABLE IF EXISTS challans ADD COLUMN IF NOT EXISTS company_id TEXT",
    "ALTER TABLE IF EXISTS stock_movements ADD COLUMN IF NOT EXISTS company_id TEXT",
    "CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id)",
    "CREATE INDEX IF NOT EXISTS idx_parties_company ON parties(company_id)",
    "CREATE INDEX IF NOT EXISTS idx_products_company ON products(company_id)",
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch(e) { /* ignore if table doesn't exist yet */ }
  }
  console.log("✅ Column migrations done");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, firm_name TEXT, frn TEXT, role TEXT DEFAULT 'ca',
      parent_id TEXT, gstin TEXT, phone TEXT, logo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
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
      description TEXT, is_service BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, invoice_no TEXT NOT NULL,
      invoice_type TEXT DEFAULT 'SALES', party_id TEXT, party_name TEXT NOT NULL,
      party_gstin TEXT, party_address TEXT, party_state TEXT,
      invoice_date TEXT NOT NULL, due_date TEXT, place_of_supply TEXT,
      is_igst BOOLEAN DEFAULT FALSE, subtotal REAL DEFAULT 0,
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
      sub_category TEXT, type TEXT DEFAULT 'UNKNOWN',
      is_reconciled BOOLEAN DEFAULT FALSE, notes TEXT, import_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bank_imports (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, bank_name TEXT,
      account_no TEXT, from_date TEXT, to_date TEXT,
      total_txns INTEGER DEFAULT 0, total_debit REAL DEFAULT 0,
      total_credit REAL DEFAULT 0, filename TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
      legal_name TEXT, gstin TEXT, pan TEXT, address TEXT, city TEXT,
      state TEXT, pincode TEXT, phone TEXT, email TEXT,
      financial_year TEXT DEFAULT 'Apr-Mar',
      fy_start TEXT DEFAULT '2024-04-01', fy_end TEXT DEFAULT '2025-03-31',
      currency TEXT DEFAULT 'INR', is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ledger_groups (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, company_id TEXT NOT NULL,
      name TEXT NOT NULL, parent_id TEXT, nature TEXT NOT NULL,
      affects_gross BOOLEAN DEFAULT FALSE, is_default BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ledgers (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, company_id TEXT NOT NULL,
      group_id TEXT NOT NULL, name TEXT NOT NULL, alias TEXT,
      opening_balance REAL DEFAULT 0, opening_type TEXT DEFAULT 'Dr',
      gstin TEXT, pan TEXT, address TEXT, phone TEXT, email TEXT,
      bank_account TEXT, bank_name TEXT, ifsc_code TEXT,
      credit_limit REAL DEFAULT 0, credit_days INTEGER DEFAULT 0,
      is_default BOOLEAN DEFAULT FALSE, notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS vouchers (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, company_id TEXT NOT NULL,
      voucher_no TEXT NOT NULL, voucher_type TEXT NOT NULL,
      date TEXT NOT NULL, ref_no TEXT, narration TEXT,
      party_ledger_id TEXT, party_name TEXT, total_amount REAL DEFAULT 0,
      is_posted BOOLEAN DEFAULT TRUE, is_cancelled BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS voucher_items (
      id TEXT PRIMARY KEY, voucher_id TEXT NOT NULL, ledger_id TEXT NOT NULL,
      ledger_name TEXT NOT NULL, dr_amount REAL DEFAULT 0,
      cr_amount REAL DEFAULT 0, narration TEXT, sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS godowns (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, company_id TEXT NOT NULL,
      name TEXT NOT NULL, address TEXT, is_default BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("✅ All tables initialised");
};
initDB().catch(e => { console.error("Init Error:", e.message); process.exit(1); });

app.use(cors({ origin:"*", methods:["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allowedHeaders:["Content-Type","Authorization"] }));
app.use(morgan("combined"));
app.use(express.json({ limit:"10mb" }));
app.use(express.urlencoded({ extended:true }));
const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:50*1024*1024 } });

const auth = (req, res, next) => {
  const h = req.headers.authorization;
  if (!h) return res.status(401).json({ success:false, message:"No token. Please login." });
  if (!h.startsWith("Bearer ")) return res.status(401).json({ success:false, message:"Invalid token format. Please login." });
  const token = h.split(" ")[1];
  if (!token || token === "null" || token === "undefined") return res.status(401).json({ success:false, message:"Empty token. Please login again." });
  try { req.user = jwt.verify(token, JWT); next(); }
  catch(e) {
    if (e.name === "TokenExpiredError") return res.status(401).json({ success:false, message:"Session expired. Please logout and login again." });
    return res.status(401).json({ success:false, message:"Invalid token. Please logout and login again." });
  }
};

const callGroq = (messages, system) => new Promise((resolve) => {
  if (!process.env.GROQ_API_KEY) return resolve("Add GROQ_API_KEY in Render environment variables.");
  const postData = JSON.stringify({ model:"llama-3.3-70b-versatile", messages:[{ role:"system", content:system }, ...messages], max_tokens:1500 });
  const req = https.request({ hostname:"api.groq.com", path:"/openai/v1/chat/completions", method:"POST", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${process.env.GROQ_API_KEY}`, "Content-Length":Buffer.byteLength(postData) } }, (res) => {
    let data=""; res.on("data",c=>{data+=c;}); res.on("end",()=>{
      try { resolve(JSON.parse(data).choices?.[0]?.message?.content||"Sorry."); } catch { resolve("Error."); }
    });
  });
  req.on("error",()=>resolve("Network error.")); req.setTimeout(30000,()=>{req.destroy();resolve("Timeout.");}); req.write(postData); req.end();
});

const genInvNo = async (userId, type) => {
  const prefix = type==="SALES"?"INV":type==="PURCHASE"?"PUR":"CN";
  const yr=new Date().getFullYear().toString().slice(-2), mo=String(new Date().getMonth()+1).padStart(2,"0");
  const r = await pool.query("SELECT COUNT(*) as c FROM invoices WHERE user_id=$1 AND invoice_type=$2",[userId,type]);
  return `${prefix}/${yr}-${mo}/${String(parseInt(r.rows[0].c)+1).padStart(4,"0")}`;
};

const genVoucherNo = async (companyId, type) => {
  const prefixes={SALES:"SI",PURCHASE:"PI",RECEIPT:"RC",PAYMENT:"PY",CONTRA:"CT",JOURNAL:"JV"};
  const prefix=prefixes[type]||"VR", yr=new Date().getFullYear().toString().slice(-2), mo=String(new Date().getMonth()+1).padStart(2,"0");
  const r = await pool.query("SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND voucher_type=$2",[companyId,type]);
  return `${prefix}/${yr}-${mo}/${String(parseInt(r.rows[0].c)+1).padStart(4,"0")}`;
};


const DEFAULT_GROUPS = [
  {name:"Capital Account",nature:"Liability",parent:null,ag:false},
  {name:"Reserves & Surplus",nature:"Liability",parent:"Capital Account",ag:false},
  {name:"Loans (Liability)",nature:"Liability",parent:null,ag:false},
  {name:"Secured Loans",nature:"Liability",parent:"Loans (Liability)",ag:false},
  {name:"Unsecured Loans",nature:"Liability",parent:"Loans (Liability)",ag:false},
  {name:"Current Liabilities",nature:"Liability",parent:null,ag:false},
  {name:"Sundry Creditors",nature:"Liability",parent:"Current Liabilities",ag:false},
  {name:"Duties & Taxes",nature:"Liability",parent:"Current Liabilities",ag:false},
  {name:"Provisions",nature:"Liability",parent:"Current Liabilities",ag:false},
  {name:"Fixed Assets",nature:"Asset",parent:null,ag:false},
  {name:"Investments",nature:"Asset",parent:null,ag:false},
  {name:"Current Assets",nature:"Asset",parent:null,ag:false},
  {name:"Sundry Debtors",nature:"Asset",parent:"Current Assets",ag:false},
  {name:"Cash-in-Hand",nature:"Asset",parent:"Current Assets",ag:false},
  {name:"Bank Accounts",nature:"Asset",parent:"Current Assets",ag:false},
  {name:"Stock-in-Hand",nature:"Asset",parent:"Current Assets",ag:false},
  {name:"Loans & Advances (Asset)",nature:"Asset",parent:"Current Assets",ag:false},
  {name:"Sales Accounts",nature:"Income",parent:null,ag:true},
  {name:"Direct Income",nature:"Income",parent:null,ag:true},
  {name:"Indirect Income",nature:"Income",parent:null,ag:false},
  {name:"Purchase Accounts",nature:"Expense",parent:null,ag:true},
  {name:"Direct Expenses",nature:"Expense",parent:null,ag:true},
  {name:"Indirect Expenses",nature:"Expense",parent:null,ag:false},
  {name:"Manufacturing Expenses",nature:"Expense",parent:null,ag:true},
];

const DEFAULT_LEDGERS = [
  {name:"Cash",group:"Cash-in-Hand",ob:0,ot:"Dr"},
  {name:"Capital",group:"Capital Account",ob:0,ot:"Cr"},
  {name:"Sales",group:"Sales Accounts",ob:0,ot:"Cr"},
  {name:"Purchase",group:"Purchase Accounts",ob:0,ot:"Dr"},
  {name:"CGST Payable",group:"Duties & Taxes",ob:0,ot:"Cr"},
  {name:"SGST Payable",group:"Duties & Taxes",ob:0,ot:"Cr"},
  {name:"IGST Payable",group:"Duties & Taxes",ob:0,ot:"Cr"},
  {name:"CGST Input Credit",group:"Current Assets",ob:0,ot:"Dr"},
  {name:"SGST Input Credit",group:"Current Assets",ob:0,ot:"Dr"},
  {name:"IGST Input Credit",group:"Current Assets",ob:0,ot:"Dr"},
  {name:"Salary & Wages",group:"Indirect Expenses",ob:0,ot:"Dr"},
  {name:"Rent",group:"Indirect Expenses",ob:0,ot:"Dr"},
  {name:"Electricity Charges",group:"Indirect Expenses",ob:0,ot:"Dr"},
  {name:"Discount Allowed",group:"Indirect Expenses",ob:0,ot:"Dr"},
  {name:"Discount Received",group:"Indirect Income",ob:0,ot:"Cr"},
  {name:"Freight & Cartage",group:"Direct Expenses",ob:0,ot:"Dr"},
  {name:"TDS Payable",group:"Duties & Taxes",ob:0,ot:"Cr"},
  {name:"Commission Income",group:"Indirect Income",ob:0,ot:"Cr"},
];

const createDefaultAccounting = async (companyId, userId) => {
  const groupMap = {};
  for (const g of DEFAULT_GROUPS) {
    const id = uuid();
    await pool.query("INSERT INTO ledger_groups (id,user_id,company_id,name,nature,affects_gross,is_default) VALUES ($1,$2,$3,$4,$5,$6,TRUE) ON CONFLICT DO NOTHING",
      [id,userId,companyId,g.name,g.nature,g.ag]);
    const r = await pool.query("SELECT id FROM ledger_groups WHERE company_id=$1 AND name=$2",[companyId,g.name]);
    if (r.rows[0]) groupMap[g.name] = r.rows[0].id;
  }
  for (const g of DEFAULT_GROUPS) {
    if (g.parent && groupMap[g.parent] && groupMap[g.name]) {
      await pool.query("UPDATE ledger_groups SET parent_id=$1 WHERE id=$2",[groupMap[g.parent],groupMap[g.name]]);
    }
  }
  for (const l of DEFAULT_LEDGERS) {
    const gid = groupMap[l.group];
    if (!gid) continue;
    await pool.query("INSERT INTO ledgers (id,user_id,company_id,group_id,name,opening_balance,opening_type,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE) ON CONFLICT DO NOTHING",
      [uuid(),userId,companyId,gid,l.name,l.ob,l.ot]);
  }
};

const getLedgerBalance = async (ledgerId, toDate) => {
  let q="SELECT COALESCE(SUM(dr_amount),0) as dr,COALESCE(SUM(cr_amount),0) as cr FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=$1 AND v.is_cancelled=FALSE";
  const p=[ledgerId];
  if(toDate){q+=` AND v.date<=$${p.length+1}`;p.push(toDate);}
  const r=await pool.query(q,p);
  return r.rows[0];
};

// ══ AUTH ══
app.post("/api/auth/register", async (req,res)=>{
  try{
    const{name,email,password,firm_name,frn}=req.body;
    if(!name||!email||!password||!firm_name) return res.status(400).json({success:false,message:"Name, email, password and firm name required"});
    if(password.length<6) return res.status(400).json({success:false,message:"Password min 6 characters"});
    const exists=await pool.query("SELECT id FROM users WHERE email=$1",[email.toLowerCase().trim()]);
    if(exists.rows[0]) return res.status(409).json({success:false,message:"Email already registered. Please login."});
    const hashed=await bcrypt.hash(password,12);
    const id=uuid();
    await pool.query("INSERT INTO users (id,name,email,password,firm_name,frn,role) VALUES ($1,$2,$3,$4,$5,$6,'ca')",[id,name.trim(),email.toLowerCase().trim(),hashed,firm_name.trim(),frn||null]);
    const token=jwt.sign({id,name:name.trim(),email:email.toLowerCase().trim(),firm_name:firm_name.trim(),role:"ca"},JWT,{expiresIn:"7d"});
    res.status(201).json({success:true,token,user:{id,name:name.trim(),email:email.toLowerCase().trim(),firm_name:firm_name.trim(),role:"ca"}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/auth/login", async (req,res)=>{
  try{
    const{email,password}=req.body;
    if(!email||!password) return res.status(400).json({success:false,message:"Email and password required"});
    const r=await pool.query("SELECT * FROM users WHERE email=$1",[email.toLowerCase().trim()]);
    const user=r.rows[0];
    if(!user) return res.status(401).json({success:false,message:"Invalid email or password"});
    const match=await bcrypt.compare(password,user.password);
    if(!match) return res.status(401).json({success:false,message:"Invalid email or password"});
    const token=jwt.sign({id:user.id,name:user.name,email:user.email,firm_name:user.firm_name,role:user.role},JWT,{expiresIn:"7d"});
    res.json({success:true,token,user:{id:user.id,name:user.name,email:user.email,firm_name:user.firm_name,frn:user.frn,role:user.role}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.get("/api/auth/me", auth, async(req,res)=>{
  try{
    const r=await pool.query("SELECT id,name,email,firm_name,frn,role FROM users WHERE id=$1",[req.user.id]);
    res.json({success:true,user:r.rows[0]});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ DASHBOARD ══
app.get("/api/dashboard", auth, async(req,res)=>{
  try{
    const uid=req.user.id, today=new Date().toISOString().split("T")[0];
    const in30=new Date(Date.now()+30*24*60*60*1000).toISOString().split("T")[0];
    const [tC,cC,pC,oC,oN,dN,upN,rC,lP]=await Promise.all([
      pool.query("SELECT COUNT(*) as c FROM clients WHERE user_id=$1",[uid]),
      pool.query("SELECT COUNT(*) as c FROM clients WHERE user_id=$1 AND status='compliant'",[uid]),
      pool.query("SELECT COUNT(*) as c FROM clients WHERE user_id=$1 AND status='pending'",[uid]),
      pool.query("SELECT COUNT(*) as c FROM clients WHERE user_id=$1 AND status='overdue'",[uid]),
      pool.query("SELECT COUNT(*) as c FROM notices WHERE user_id=$1 AND status NOT IN ('closed','replied')",[uid]),
      pool.query("SELECT COUNT(*) as c FROM notices WHERE user_id=$1 AND due_date BETWEEN $2 AND $3 AND status NOT IN ('closed','replied')",[uid,today,in30]),
      pool.query("SELECT n.*,c.name as client_name FROM notices n JOIN clients c ON n.client_id=c.id WHERE n.user_id=$1 AND n.due_date BETWEEN $2 AND $3 AND n.status NOT IN ('closed','replied') ORDER BY n.due_date ASC LIMIT 5",[uid,today,in30]),
      pool.query("SELECT * FROM clients WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5",[uid]),
      pool.query("SELECT period FROM returns WHERE user_id=$1 ORDER BY period DESC LIMIT 1",[uid]),
    ]);
    let rs=null;
    if(lP.rows[0]){
      const p=lP.rows[0].period;
      const c=async(f,s)=>{const r=await pool.query(`SELECT COUNT(*) as c FROM returns WHERE user_id=$1 AND period=$2 AND ${f}=$3`,[uid,p,s]);return parseInt(r.rows[0].c);};
      rs={period:p,gstr1:{filed:await c("gstr1_status","filed"),pending:await c("gstr1_status","pending"),not_filed:await c("gstr1_status","not-filed")},gstr3b:{filed:await c("gstr3b_status","filed"),pending:await c("gstr3b_status","pending"),not_filed:await c("gstr3b_status","not-filed")},gstr9:{filed:await c("gstr9_status","filed"),pending:await c("gstr9_status","pending"),not_filed:await c("gstr9_status","not-filed")}};
    }
    res.json({success:true,dashboard:{clients:{total:parseInt(tC.rows[0].c),compliant:parseInt(cC.rows[0].c),pending:parseInt(pC.rows[0].c),overdue:parseInt(oC.rows[0].c)},notices:{open:parseInt(oN.rows[0].c),due_in_30_days:parseInt(dN.rows[0].c)},upcoming_notices:upN.rows,recent_clients:rC.rows,returns_summary:rs}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ CLIENTS ══
app.get("/api/clients",auth,async(req,res)=>{
  try{const{search,status}=req.query;let q="SELECT c.*,(SELECT COUNT(*) FROM notices n WHERE n.client_id=c.id AND n.status NOT IN ('closed','replied')) as notice_count FROM clients c WHERE c.user_id=$1";const p=[req.user.id];if(search){q+=` AND (c.name ILIKE $${p.length+1} OR c.gstin ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}if(status){q+=` AND c.status=$${p.length+1}`;p.push(status);}q+=" ORDER BY c.name ASC";const r=await pool.query(q,p);res.json({success:true,clients:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/clients",auth,async(req,res)=>{
  try{const{name,gstin,state,type,turnover,notes,phone,email,address,city,pincode,pan}=req.body;if(!name)return res.status(400).json({success:false,message:"Name required"});const id=uuid();await pool.query("INSERT INTO clients (id,user_id,name,gstin,state,type,turnover,notes,phone,email,address,city,pincode,pan) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",[id,req.user.id,name,gstin?.toUpperCase()||null,state||null,type||"Trader",turnover||null,notes||null,phone||null,email||null,address||null,city||null,pincode||null,pan||null]);const r=await pool.query("SELECT * FROM clients WHERE id=$1",[id]);res.status(201).json({success:true,message:"Client added",client:r.rows[0]});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.put("/api/clients/:id",auth,async(req,res)=>{
  try{const{name,gstin,state,type,turnover,notes,status,phone,email,address,city,pincode,pan}=req.body;await pool.query("UPDATE clients SET name=$1,gstin=$2,state=$3,type=$4,turnover=$5,notes=$6,status=$7,phone=$8,email=$9,address=$10,city=$11,pincode=$12,pan=$13,updated_at=NOW() WHERE id=$14 AND user_id=$15",[name,gstin?.toUpperCase()||null,state||null,type||"Trader",turnover||null,notes||null,status||"compliant",phone||null,email||null,address||null,city||null,pincode||null,pan||null,req.params.id,req.user.id]);res.json({success:true,message:"Updated"});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/clients/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM clients WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ NOTICES ══
app.get("/api/notices",auth,async(req,res)=>{
  try{const{status,client_id}=req.query;let q="SELECT n.*,c.name as client_name,c.gstin FROM notices n JOIN clients c ON n.client_id=c.id WHERE n.user_id=$1";const p=[req.user.id];if(status&&status!=="all"){q+=` AND n.status=$${p.length+1}`;p.push(status);}if(client_id){q+=` AND n.client_id=$${p.length+1}`;p.push(client_id);}q+=" ORDER BY n.due_date ASC";const r=await pool.query(q,p);res.json({success:true,notices:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/notices",auth,async(req,res)=>{
  try{const{client_id,ref_no,type,issued_date,due_date,amount,priority,description}=req.body;if(!client_id||!ref_no||!type||!due_date)return res.status(400).json({success:false,message:"Required fields missing"});const today=new Date().toISOString().split("T")[0];const status=new Date(due_date)<new Date(today)?"overdue":"pending";const id=uuid();await pool.query("INSERT INTO notices (id,user_id,client_id,ref_no,type,issued_date,due_date,amount,status,priority,description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id,req.user.id,client_id,ref_no,type,issued_date||today,due_date,parseFloat(amount)||0,status,priority||"medium",description||null]);const r=await pool.query("SELECT * FROM notices WHERE id=$1",[id]);res.status(201).json({success:true,message:"Notice added",notice:r.rows[0]});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.patch("/api/notices/:id/status",auth,async(req,res)=>{
  try{await pool.query("UPDATE notices SET status=$1,updated_at=NOW() WHERE id=$2 AND user_id=$3",[req.body.status,req.params.id,req.user.id]);res.json({success:true,message:"Updated"});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/notices/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM notices WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ RETURNS ══
app.get("/api/returns",auth,async(req,res)=>{
  try{const{period,client_id}=req.query;let q="SELECT r.*,c.name as client_name,c.gstin FROM returns r JOIN clients c ON r.client_id=c.id WHERE r.user_id=$1";const p=[req.user.id];if(period){q+=` AND r.period=$${p.length+1}`;p.push(period);}if(client_id){q+=` AND r.client_id=$${p.length+1}`;p.push(client_id);}q+=" ORDER BY c.name ASC";const r=await pool.query(q,p);res.json({success:true,returns:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/returns",auth,async(req,res)=>{
  try{const{client_id,period,gstr1_status,gstr3b_status,gstr9_status}=req.body;if(!client_id||!period)return res.status(400).json({success:false,message:"client_id and period required"});const ex=await pool.query("SELECT id FROM returns WHERE user_id=$1 AND client_id=$2 AND period=$3",[req.user.id,client_id,period]);if(ex.rows[0])return res.status(409).json({success:false,message:"Record exists for this period"});const id=uuid();await pool.query("INSERT INTO returns (id,user_id,client_id,period,gstr1_status,gstr3b_status,gstr9_status) VALUES ($1,$2,$3,$4,$5,$6,$7)",[id,req.user.id,client_id,period,gstr1_status||"not-filed",gstr3b_status||"not-filed",gstr9_status||"not-filed"]);res.status(201).json({success:true,message:"Saved"});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.put("/api/returns/:id",auth,async(req,res)=>{
  try{const{gstr1_status,gstr3b_status,gstr9_status}=req.body;await pool.query("UPDATE returns SET gstr1_status=$1,gstr3b_status=$2,gstr9_status=$3,updated_at=NOW() WHERE id=$4 AND user_id=$5",[gstr1_status,gstr3b_status,gstr9_status,req.params.id,req.user.id]);res.json({success:true,message:"Updated"});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/returns/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM returns WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ RECONCILIATION ══
app.get("/api/reconciliation",auth,async(req,res)=>{
  try{const{client_id,period}=req.query;if(!client_id||!period)return res.status(400).json({success:false,message:"client_id and period required"});const r=await pool.query("SELECT * FROM reconciliation WHERE user_id=$1 AND client_id=$2 AND period=$3 ORDER BY vendor_name ASC",[req.user.id,client_id,period]);const rows=r.rows;const matched=rows.filter(r=>r.status==="matched").length,mismatch=rows.filter(r=>r.status==="mismatch").length,missing=rows.filter(r=>r.status==="missing").length,totalRisk=rows.reduce((a,r)=>a+parseFloat(r.difference||0),0);res.json({success:true,rows,summary:{matched,mismatch,missing,total_itc_risk:totalRisk}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/reconciliation",auth,async(req,res)=>{
  try{const{client_id,period,vendor_name,vendor_gstin,invoice_count,gstr2a_amount,gstr2b_amount,books_amount,remarks}=req.body;const g2a=parseFloat(gstr2a_amount)||0,g2b=parseFloat(gstr2b_amount)||0,bks=parseFloat(books_amount)||0,diff=g2b-bks;const status=g2b===0&&bks>0?"missing":Math.abs(diff)>0?"mismatch":"matched";const id=uuid();await pool.query("INSERT INTO reconciliation (id,user_id,client_id,period,vendor_name,vendor_gstin,invoice_count,gstr2a_amount,gstr2b_amount,books_amount,difference,status,remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",[id,req.user.id,client_id,period,vendor_name,vendor_gstin?.toUpperCase()||"",parseInt(invoice_count)||0,g2a,g2b,bks,diff,status,remarks||null]);res.status(201).json({success:true,message:"Added"});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/reconciliation/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM reconciliation WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ PRODUCTS ══
app.get("/api/products",auth,async(req,res)=>{
  try{const{search,company_id}=req.query;let q="SELECT * FROM products WHERE user_id=$1";const p=[req.user.id];if(company_id){q+=` AND (company_id=$${p.length+1} OR company_id IS NULL)`;p.push(company_id);}if(search){q+=` AND (name ILIKE $${p.length+1} OR code ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}q+=" ORDER BY name ASC";const r=await pool.query(q,p);res.json({success:true,products:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/products",auth,async(req,res)=>{
  try{const{name,code,hsn_sac,unit,category,gst_rate,purchase_price,sale_price,stock_qty,min_stock,description,is_service}=req.body;if(!name)return res.status(400).json({success:false,message:"Name required"});const id=uuid();await pool.query("INSERT INTO products (id,user_id,name,code,hsn_sac,unit,category,gst_rate,purchase_price,sale_price,stock_qty,min_stock,description,is_service) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",[id,req.user.id,name,code||null,hsn_sac||null,unit||"PCS",category||null,parseFloat(gst_rate)||18,parseFloat(purchase_price)||0,parseFloat(sale_price)||0,parseFloat(stock_qty)||0,parseFloat(min_stock)||0,description||null,is_service===true||is_service==='true'?1:0]);if(parseFloat(stock_qty)>0)await pool.query("INSERT INTO stock_movements (id,user_id,product_id,type,qty,rate,reference,notes) VALUES ($1,$2,$3,'OPENING',$4,$5,'Opening Stock','Opening stock')",[uuid(),req.user.id,id,parseFloat(stock_qty),parseFloat(purchase_price)||0]);const r=await pool.query("SELECT * FROM products WHERE id=$1",[id]);res.status(201).json({success:true,message:"Product added",product:r.rows[0]});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.put("/api/products/:id",auth,async(req,res)=>{
  try{const{name,code,hsn_sac,unit,category,gst_rate,purchase_price,sale_price,min_stock,description,is_service}=req.body;await pool.query("UPDATE products SET name=$1,code=$2,hsn_sac=$3,unit=$4,category=$5,gst_rate=$6,purchase_price=$7,sale_price=$8,min_stock=$9,description=$10,is_service=$11,updated_at=NOW() WHERE id=$12 AND user_id=$13",[name,code||null,hsn_sac||null,unit||"PCS",category||null,parseFloat(gst_rate)||18,parseFloat(purchase_price)||0,parseFloat(sale_price)||0,parseFloat(min_stock)||0,description||null,is_service===true||is_service==='true'?1:0,req.params.id,req.user.id]);res.json({success:true,message:"Updated"});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/products/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM products WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/products/:id/stock",auth,async(req,res)=>{
  try{const{type,qty,rate,notes}=req.body;const p=await pool.query("SELECT * FROM products WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);if(!p.rows[0])return res.status(404).json({success:false,message:"Not found"});const change=type==="IN"?parseFloat(qty):-parseFloat(qty);const newStock=parseFloat(p.rows[0].stock_qty)+change;if(newStock<0)return res.status(400).json({success:false,message:"Insufficient stock"});await pool.query("UPDATE products SET stock_qty=$1,updated_at=NOW() WHERE id=$2",[newStock,req.params.id]);await pool.query("INSERT INTO stock_movements (id,user_id,product_id,type,qty,rate,notes) VALUES ($1,$2,$3,$4,$5,$6,$7)",[uuid(),req.user.id,req.params.id,type,Math.abs(parseFloat(qty)),parseFloat(rate)||0,notes||null]);res.json({success:true,message:"Stock updated",new_stock:newStock});}catch(e){res.status(500).json({success:false,message:e.message});}
});


// ══ INVOICES ══
app.get("/api/invoices/stats/summary",auth,async(req,res)=>{
  try{const uid=req.user.id,today=new Date().toISOString().split("T")[0],month=today.substring(0,7);const[s,p,o,ov]=await Promise.all([pool.query("SELECT COALESCE(SUM(total_amount),0) as t FROM invoices WHERE user_id=$1 AND invoice_type='SALES' AND invoice_date LIKE $2",[uid,`${month}%`]),pool.query("SELECT COALESCE(SUM(total_amount),0) as t FROM invoices WHERE user_id=$1 AND invoice_type='PURCHASE' AND invoice_date LIKE $2",[uid,`${month}%`]),pool.query("SELECT COALESCE(SUM(balance_due),0) as t FROM invoices WHERE user_id=$1 AND status IN ('unpaid','partial')",[uid]),pool.query("SELECT COALESCE(SUM(balance_due),0) as t FROM invoices WHERE user_id=$1 AND status IN ('unpaid','partial') AND due_date < $2",[uid,today])]);res.json({success:true,stats:{monthly_sales:parseFloat(s.rows[0].t),monthly_purchases:parseFloat(p.rows[0].t),total_outstanding:parseFloat(o.rows[0].t),overdue_amount:parseFloat(ov.rows[0].t)}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/invoices",auth,async(req,res)=>{
  try{const{type,status,search}=req.query;let q="SELECT * FROM invoices WHERE user_id=$1";const p=[req.user.id];if(type){q+=` AND invoice_type=$${p.length+1}`;p.push(type);}if(status){q+=` AND status=$${p.length+1}`;p.push(status);}if(search){q+=` AND (party_name ILIKE $${p.length+1} OR invoice_no ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}q+=" ORDER BY created_at DESC";const r=await pool.query(q,p);const invs=r.rows;res.json({success:true,count:invs.length,invoices:invs,summary:{total_amount:invs.reduce((a,i)=>a+parseFloat(i.total_amount||0),0),total_outstanding:invs.reduce((a,i)=>a+parseFloat(i.balance_due||0),0)}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/invoices/:id",auth,async(req,res)=>{
  try{const inv=await pool.query("SELECT * FROM invoices WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);if(!inv.rows[0])return res.status(404).json({success:false,message:"Not found"});const items=await pool.query("SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY id",[req.params.id]);const pays=await pool.query("SELECT * FROM payments WHERE invoice_id=$1 ORDER BY payment_date DESC",[req.params.id]);res.json({success:true,invoice:{...inv.rows[0],items:items.rows,payments:pays.rows}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/invoices",auth,async(req,res)=>{
  try{
    const{invoice_type,party_id,party_name,party_gstin,party_address,party_state,invoice_date,due_date,place_of_supply,is_igst,notes,terms,items=[]}=req.body;
    if(!party_name)return res.status(400).json({success:false,message:"Party name required"});
    if(!invoice_date)return res.status(400).json({success:false,message:"Invoice date required"});
    if(items.length===0)return res.status(400).json({success:false,message:"At least one item required"});
    const invoice_no=await genInvNo(req.user.id,invoice_type||"SALES");
    let subtotal=0,totalIGST=0,totalCGST=0,totalSGST=0;
    const processed=items.map(item=>{
      const qty=parseFloat(item.qty)||0,rate=parseFloat(item.rate)||0,disc=parseFloat(item.discount_pct)||0,gstRate=parseFloat(item.gst_rate)||0;
      const gross=qty*rate,discAmt=gross*disc/100,taxable=gross-discAmt;
      const igst=is_igst?taxable*gstRate/100:0,cgst=!is_igst?taxable*(gstRate/2)/100:0,sgst=!is_igst?taxable*(gstRate/2)/100:0;
      subtotal+=gross;totalIGST+=igst;totalCGST+=cgst;totalSGST+=sgst;
      return{...item,taxable_value:taxable,igst_amount:igst,cgst_amount:cgst,sgst_amount:sgst,total_amount:taxable+igst+cgst+sgst};
    });
    const totalTax=totalIGST+totalCGST+totalSGST,totalAmount=subtotal+totalTax,id=uuid();
    await pool.query("INSERT INTO invoices (id,user_id,invoice_no,invoice_type,party_id,party_name,party_gstin,party_address,party_state,invoice_date,due_date,place_of_supply,is_igst,subtotal,taxable_amount,igst_amount,cgst_amount,sgst_amount,total_tax,total_amount,paid_amount,balance_due,status,notes,terms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)",
      [id,req.user.id,invoice_no,invoice_type||"SALES",party_id||null,party_name,party_gstin||null,party_address||null,party_state||null,invoice_date,due_date||null,place_of_supply||null,is_igst||false,subtotal,subtotal,totalIGST,totalCGST,totalSGST,totalTax,totalAmount,0,totalAmount,"unpaid",notes||null,terms||null]);
    for(const item of processed){
      await pool.query("INSERT INTO invoice_items (id,invoice_id,product_id,name,hsn_sac,unit,qty,rate,discount_pct,taxable_value,gst_rate,igst_amount,cgst_amount,sgst_amount,total_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        [uuid(),id,item.product_id||null,item.name,item.hsn_sac||null,item.unit||"PCS",item.qty,item.rate,item.discount_pct||0,item.taxable_value,item.gst_rate||0,item.igst_amount,item.cgst_amount,item.sgst_amount,item.total_amount]);
      if(item.product_id){
        const sc=(invoice_type==="SALES")?-parseFloat(item.qty):parseFloat(item.qty);
        const pr=await pool.query("SELECT stock_qty FROM products WHERE id=$1",[item.product_id]);
        if(pr.rows[0]){const ns=Math.max(0,parseFloat(pr.rows[0].stock_qty)+sc);await pool.query("UPDATE products SET stock_qty=$1,updated_at=NOW() WHERE id=$2",[ns,item.product_id]);await pool.query("INSERT INTO stock_movements (id,user_id,product_id,type,qty,rate,reference,invoice_id,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",[uuid(),req.user.id,item.product_id,invoice_type==="SALES"?"OUT":"IN",Math.abs(parseFloat(item.qty)),item.rate,invoice_no,id,`${invoice_type} Invoice`]);}
      }
    }
    const inv=await pool.query("SELECT * FROM invoices WHERE id=$1",[id]);
    const invItems=await pool.query("SELECT * FROM invoice_items WHERE invoice_id=$1",[id]);
    res.status(201).json({success:true,message:"Invoice created",invoice:{...inv.rows[0],items:invItems.rows}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/invoices/:id/payment",auth,async(req,res)=>{
  try{const{amount,method,reference_no,payment_date}=req.body;const inv=await pool.query("SELECT * FROM invoices WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);if(!inv.rows[0])return res.status(404).json({success:false,message:"Not found"});const paidAmt=parseFloat(inv.rows[0].paid_amount)+parseFloat(amount),balance=Math.max(0,parseFloat(inv.rows[0].total_amount)-paidAmt),status=balance<=0?"paid":"partial";await pool.query("UPDATE invoices SET paid_amount=$1,balance_due=$2,status=$3,updated_at=NOW() WHERE id=$4",[paidAmt,balance,status,req.params.id]);await pool.query("INSERT INTO payments (id,user_id,invoice_id,party_name,type,amount,method,reference_no,payment_date) VALUES ($1,$2,$3,$4,'RECEIVED',$5,$6,$7,$8)",[uuid(),req.user.id,req.params.id,inv.rows[0].party_name,parseFloat(amount),method||"CASH",reference_no||null,payment_date]);res.json({success:true,message:"Payment recorded",paid_amount:paidAmt,balance_due:balance});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/invoices/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM invoice_items WHERE invoice_id=$1",[req.params.id]);await pool.query("DELETE FROM invoices WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ PARTIES ══
app.get("/api/parties",auth,async(req,res)=>{
  try{const{search,company_id}=req.query;let q="SELECT c.*,COALESCE((SELECT SUM(balance_due) FROM invoices WHERE party_id=c.id AND status IN ('unpaid','partial')),0) as outstanding FROM clients c WHERE c.user_id=$1";const p=[req.user.id];if(company_id){q+=` AND (c.company_id=$${p.length+1} OR c.company_id IS NULL)`;p.push(company_id);}if(search){q+=` AND (c.name ILIKE $${p.length+1} OR c.gstin ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}q+=" ORDER BY c.name ASC";const r=await pool.query(q,p);res.json({success:true,parties:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/parties",auth,async(req,res)=>{
  try{const{name,gstin,state,type,phone,email,address,city,pincode,pan,credit_limit}=req.body;if(!name)return res.status(400).json({success:false,message:"Name required"});const id=uuid();await pool.query("INSERT INTO clients (id,user_id,name,gstin,state,type,phone,email,address,city,pincode,pan,credit_limit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",[id,req.user.id,name,gstin||null,state||null,type||"Customer",phone||null,email||null,address||null,city||null,pincode||null,pan||null,parseFloat(credit_limit)||0]);const r=await pool.query("SELECT * FROM clients WHERE id=$1",[id]);res.status(201).json({success:true,message:"Party added",party:r.rows[0]});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.put("/api/parties/:id",auth,async(req,res)=>{
  try{const{name,gstin,state,type,phone,email,address,city,pincode,pan,credit_limit}=req.body;await pool.query("UPDATE clients SET name=$1,gstin=$2,state=$3,type=$4,phone=$5,email=$6,address=$7,city=$8,pincode=$9,pan=$10,credit_limit=$11,updated_at=NOW() WHERE id=$12 AND user_id=$13",[name,gstin||null,state||null,type||"Customer",phone||null,email||null,address||null,city||null,pincode||null,pan||null,parseFloat(credit_limit)||0,req.params.id,req.user.id]);res.json({success:true,message:"Updated"});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/parties/:id/ledger",auth,async(req,res)=>{
  try{const party=await pool.query("SELECT * FROM clients WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);if(!party.rows[0])return res.status(404).json({success:false,message:"Not found"});const invoices=await pool.query("SELECT * FROM invoices WHERE party_id=$1 AND user_id=$2 ORDER BY invoice_date DESC",[req.params.id,req.user.id]);const payments=await pool.query("SELECT * FROM payments WHERE party_id=$1 AND user_id=$2 ORDER BY payment_date DESC",[req.params.id,req.user.id]);const invs=invoices.rows;const outstanding=invs.reduce((a,i)=>a+parseFloat(i.balance_due||0),0);res.json({success:true,party:party.rows[0],invoices:invs,payments:payments.rows,summary:{total_sales:invs.filter(i=>i.invoice_type==="SALES").reduce((a,i)=>a+parseFloat(i.total_amount||0),0),total_purchases:invs.filter(i=>i.invoice_type==="PURCHASE").reduce((a,i)=>a+parseFloat(i.total_amount||0),0),outstanding}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/parties/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM clients WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ REPORTS ══
app.get("/api/reports/sales-register",auth,async(req,res)=>{
  try{const{from_date,to_date}=req.query;let q="SELECT * FROM invoices WHERE user_id=$1 AND invoice_type='SALES'";const p=[req.user.id];if(from_date){q+=` AND invoice_date>=$${p.length+1}`;p.push(from_date);}if(to_date){q+=` AND invoice_date<=$${p.length+1}`;p.push(to_date);}q+=" ORDER BY invoice_date ASC";const r=await pool.query(q,p);const invs=r.rows;res.json({success:true,invoices:invs,summary:{total_invoices:invs.length,total_taxable:invs.reduce((a,i)=>a+parseFloat(i.taxable_amount||0),0),total_igst:invs.reduce((a,i)=>a+parseFloat(i.igst_amount||0),0),total_cgst:invs.reduce((a,i)=>a+parseFloat(i.cgst_amount||0),0),total_sgst:invs.reduce((a,i)=>a+parseFloat(i.sgst_amount||0),0),total_amount:invs.reduce((a,i)=>a+parseFloat(i.total_amount||0),0)}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/reports/purchase-register",auth,async(req,res)=>{
  try{const{from_date,to_date}=req.query;let q="SELECT * FROM invoices WHERE user_id=$1 AND invoice_type='PURCHASE'";const p=[req.user.id];if(from_date){q+=` AND invoice_date>=$${p.length+1}`;p.push(from_date);}if(to_date){q+=` AND invoice_date<=$${p.length+1}`;p.push(to_date);}q+=" ORDER BY invoice_date ASC";const r=await pool.query(q,p);const invs=r.rows;res.json({success:true,invoices:invs,summary:{total_invoices:invs.length,total_taxable:invs.reduce((a,i)=>a+parseFloat(i.taxable_amount||0),0),total_amount:invs.reduce((a,i)=>a+parseFloat(i.total_amount||0),0)}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/reports/gst-summary",auth,async(req,res)=>{
  try{const{from_date,to_date}=req.query;const uid=req.user.id;let where="";const p=[uid];if(from_date){where+=` AND invoice_date>=$${p.length+1}`;p.push(from_date);}if(to_date){where+=` AND invoice_date<=$${p.length+1}`;p.push(to_date);}const s=await pool.query(`SELECT COALESCE(SUM(taxable_amount),0) as taxable,COALESCE(SUM(igst_amount),0) as igst,COALESCE(SUM(cgst_amount),0) as cgst,COALESCE(SUM(sgst_amount),0) as sgst,COALESCE(SUM(total_amount),0) as total FROM invoices WHERE user_id=$1 AND invoice_type='SALES'${where}`,p);const pr=await pool.query(`SELECT COALESCE(SUM(taxable_amount),0) as taxable,COALESCE(SUM(igst_amount),0) as igst,COALESCE(SUM(cgst_amount),0) as cgst,COALESCE(SUM(sgst_amount),0) as sgst,COALESCE(SUM(total_amount),0) as total FROM invoices WHERE user_id=$1 AND invoice_type='PURCHASE'${where}`,p);const sales=s.rows[0],purchase=pr.rows[0];const outputTax=parseFloat(sales.igst||0)+parseFloat(sales.cgst||0)+parseFloat(sales.sgst||0),inputTax=parseFloat(purchase.igst||0)+parseFloat(purchase.cgst||0)+parseFloat(purchase.sgst||0);res.json({success:true,report:{sales:{taxable:parseFloat(sales.taxable),igst:parseFloat(sales.igst),cgst:parseFloat(sales.cgst),sgst:parseFloat(sales.sgst),total:parseFloat(sales.total)},purchase:{taxable:parseFloat(purchase.taxable),igst:parseFloat(purchase.igst),cgst:parseFloat(purchase.cgst),sgst:parseFloat(purchase.sgst),total:parseFloat(purchase.total)},output_tax:outputTax,input_tax:inputTax,net_gst_payable:outputTax-inputTax}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/reports/outstanding",auth,async(req,res)=>{
  try{const r=await pool.query("SELECT party_name,party_gstin,COUNT(*) as invoice_count,SUM(total_amount) as total_billed,SUM(paid_amount) as total_paid,SUM(balance_due) as outstanding,MIN(due_date) as oldest_due FROM invoices WHERE user_id=$1 AND status IN ('unpaid','partial') AND invoice_type='SALES' GROUP BY party_name,party_gstin ORDER BY outstanding DESC",[req.user.id]);res.json({success:true,parties:r.rows,total_outstanding:r.rows.reduce((a,r)=>a+parseFloat(r.outstanding||0),0)});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/reports/profit-loss",auth,async(req,res)=>{
  try{const{from_date,to_date}=req.query;const uid=req.user.id;let where="";const p=[uid];if(from_date){where+=` AND invoice_date>=$${p.length+1}`;p.push(from_date);}if(to_date){where+=` AND invoice_date<=$${p.length+1}`;p.push(to_date);}const s=await pool.query(`SELECT COALESCE(SUM(taxable_amount),0) as total FROM invoices WHERE user_id=$1 AND invoice_type='SALES'${where}`,p);const pr=await pool.query(`SELECT COALESCE(SUM(taxable_amount),0) as total FROM invoices WHERE user_id=$1 AND invoice_type='PURCHASE'${where}`,p);const sl=parseFloat(s.rows[0].total),pu=parseFloat(pr.rows[0].total),gross=sl-pu;res.json({success:true,pl:{income:{sales:sl,total:sl},expenses:{purchases:pu,total:pu},gross_profit:gross,net_profit:gross}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/reports/day-book",auth,async(req,res)=>{
  try{const date=req.query.date||new Date().toISOString().split("T")[0];const invoices=await pool.query("SELECT * FROM invoices WHERE user_id=$1 AND invoice_date=$2 ORDER BY created_at ASC",[req.user.id,date]);const payments=await pool.query("SELECT * FROM payments WHERE user_id=$1 AND payment_date=$2 ORDER BY created_at ASC",[req.user.id,date]);const invs=invoices.rows,pays=payments.rows;res.json({success:true,date,invoices:invs,payments:pays,summary:{total_sales:invs.filter(i=>i.invoice_type==="SALES").reduce((a,i)=>a+parseFloat(i.total_amount||0),0),total_purchases:invs.filter(i=>i.invoice_type==="PURCHASE").reduce((a,i)=>a+parseFloat(i.total_amount||0),0),total_received:pays.filter(p=>p.type==="RECEIVED").reduce((a,p)=>a+parseFloat(p.amount||0),0),total_paid:pays.filter(p=>p.type==="PAID").reduce((a,p)=>a+parseFloat(p.amount||0),0)}});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ BANK STATEMENT ══
const guessCategory=d=>{const t=(d||"").toLowerCase();if(t.includes("salary")||t.includes("payroll"))return"Salary";if(t.includes("rent"))return"Rent";if(t.includes("gst")||t.includes("tds"))return"Tax Payment";if(t.includes("electricity")||t.includes("utility"))return"Utilities";if(t.includes("neft")||t.includes("rtgs")||t.includes("imps"))return"Fund Transfer";if(t.includes("atm")||t.includes("cash"))return"Cash";if(t.includes("emi")||t.includes("loan"))return"Loan Payment";if(t.includes("interest"))return"Interest";if(t.includes("charges")||t.includes("fee"))return"Bank Charges";if(t.includes("insurance")||t.includes("premium"))return"Insurance";if(t.includes("purchase")||t.includes("vendor"))return"Purchase";if(t.includes("sale")||t.includes("receipt"))return"Sales Receipt";if(t.includes("amazon")||t.includes("flipkart"))return"Online Purchase";if(t.includes("petrol")||t.includes("fuel"))return"Fuel";if(t.includes("medical")||t.includes("hospital"))return"Medical";return"Uncategorized";};
const guessType=(d,isDebit)=>{const t=(d||"").toLowerCase();if(t.includes("gst")||t.includes("tds")||t.includes("tax"))return"TAX";if(t.includes("neft")||t.includes("rtgs")||t.includes("imps")||t.includes("transfer"))return"TRANSFER";if(t.includes("emi")||t.includes("loan")||t.includes("charges")||t.includes("fee"))return"BANK";if(!isDebit)return"INCOME";if(t.includes("salary")||t.includes("rent")||t.includes("vendor"))return"EXPENSE";if(t.includes("purchase")||t.includes("supplier"))return"PURCHASE";return isDebit?"EXPENSE":"INCOME";};
const parseTransactions=text=>{const lines=text.split("\n").map(l=>l.trim()).filter(l=>l.length>5);const txns=[];const dReg=/(\d{2}[\/\-]\d{2}[\/\-]\d{4}|\d{2}[\/\-]\d{2}[\/\-]\d{2})/;for(const line of lines){const dm=line.match(dReg);if(!dm)continue;const ds=dm[1];const ars=[];let m;const ar=/(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;while((m=ar.exec(line))!==null){const v=parseFloat(m[1].replace(/,/g,""));if(v>0)ars.push(v);}if(ars.length<2)continue;let desc=line.replace(ds,"").replace(/\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g,"").replace(/\s+/g," ").trim();if(!desc||desc.length<3)continue;const isDebit=line.toLowerCase().includes("dr")||line.toLowerCase().includes("debit");const debit=isDebit?ars[ars.length-3]||ars[0]||0:0;const credit=!isDebit?ars[ars.length-2]||ars[0]||0:0;const normDate=ds.replace(/(\d{2})[\/\-](\d{2})[\/\-](\d{2,4})/,(_,d,mo,y)=>`${y.length===2?"20"+y:y}-${mo}-${d}`);txns.push({txn_date:normDate,description:desc.substring(0,200),debit,credit,balance:ars[ars.length-1]||0,category:guessCategory(desc),type:guessType(desc,isDebit)});}return txns;};

app.post("/api/bank/upload",auth,upload.single("file"),async(req,res)=>{
  try{if(!req.file)return res.status(400).json({success:false,message:"PDF required"});let text="";try{const pp=require("pdf-parse");const data=await pp(req.file.buffer);text=data.text;}catch(e){return res.status(400).json({success:false,message:"Cannot read PDF. Use digital (not scanned) PDF."});}if(!text||text.length<50)return res.status(400).json({success:false,message:"No text found in PDF."});const transactions=parseTransactions(text);if(transactions.length===0)return res.status(400).json({success:false,message:"No transactions found."});const td=transactions.reduce((a,t)=>a+(t.debit||0),0),tc=transactions.reduce((a,t)=>a+(t.credit||0),0);res.json({success:true,message:`Found ${transactions.length} transactions`,preview:{bank_name:req.body.bank_name||"Unknown Bank",account_no:req.body.account_no||"",total_txns:transactions.length,total_debit:td,total_credit:tc,transactions}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/bank/import",auth,async(req,res)=>{
  try{const{bank_name,account_no,transactions}=req.body;if(!transactions||transactions.length===0)return res.status(400).json({success:false,message:"No transactions"});const importId=uuid();const td=transactions.reduce((a,t)=>a+(t.debit||0),0),tc=transactions.reduce((a,t)=>a+(t.credit||0),0);await pool.query("INSERT INTO bank_imports (id,user_id,bank_name,account_no,total_txns,total_debit,total_credit,filename) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",[importId,req.user.id,bank_name||"Unknown",account_no||"",transactions.length,td,tc,`statement_${Date.now()}.pdf`]);for(const t of transactions){await pool.query("INSERT INTO bank_transactions (id,user_id,bank_name,account_no,txn_date,description,debit,credit,balance,category,type,import_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[uuid(),req.user.id,bank_name||"Unknown",account_no||"",t.txn_date,t.description,t.debit||0,t.credit||0,t.balance||0,t.category||"Uncategorized",t.type||"UNKNOWN",importId]);}res.json({success:true,message:`${transactions.length} transactions imported!`,import_id:importId});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/bank/transactions",auth,async(req,res)=>{
  try{const{type,from_date,to_date}=req.query;let q="SELECT * FROM bank_transactions WHERE user_id=$1";const p=[req.user.id];if(type&&type!=="all"){q+=` AND type=$${p.length+1}`;p.push(type);}if(from_date){q+=` AND txn_date>=$${p.length+1}`;p.push(from_date);}if(to_date){q+=` AND txn_date<=$${p.length+1}`;p.push(to_date);}q+=" ORDER BY txn_date DESC, created_at DESC";const r=await pool.query(q,p);const rows=r.rows;res.json({success:true,count:rows.length,transactions:rows,summary:{total_debit:rows.reduce((a,t)=>a+parseFloat(t.debit||0),0),total_credit:rows.reduce((a,t)=>a+parseFloat(t.credit||0),0)}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/bank/imports",auth,async(req,res)=>{
  try{const r=await pool.query("SELECT * FROM bank_imports WHERE user_id=$1 ORDER BY created_at DESC",[req.user.id]);res.json({success:true,imports:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.patch("/api/bank/transactions/:id",auth,async(req,res)=>{
  try{const{category,type,notes}=req.body;await pool.query("UPDATE bank_transactions SET category=$1,type=$2,notes=$3 WHERE id=$4 AND user_id=$5",[category,type,notes||null,req.params.id,req.user.id]);res.json({success:true,message:"Updated"});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ AI ══
app.post("/api/ai/chat",auth,async(req,res)=>{
  try{const reply=await callGroq(req.body.messages||[],"You are an expert Indian GST consultant and accounting professional. Help with GST, ITC, vouchers, ledgers, balance sheet, P&L, trial balance, and all accounting topics. Be concise. Use Rs. for currency.");res.json({success:true,reply});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/ai/generate-reply",auth,async(req,res)=>{
  try{const{client_name,gstin,notice_type,ref_no,amount,description}=req.body;const prompt=`GST Notice Reply:\nClient: ${client_name}\nGSTIN: ${gstin}\nNotice: ${notice_type}\nRef: ${ref_no}\nAmount: Rs.${amount}\nDetails: ${description||"Not provided"}\n\nWrite formal reply citing CGST Act sections.`;const reply=await callGroq([{role:"user",content:prompt}],"You are a GST lawyer. Write formal, professional notice replies.");res.json({success:true,reply});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ CHALLANS ══
app.get("/api/challans",auth,async(req,res)=>{try{const r=await pool.query("SELECT ch.*,c.name as client_name,c.gstin FROM challans ch JOIN clients c ON ch.client_id=c.id WHERE ch.user_id=$1 ORDER BY ch.created_at DESC",[req.user.id]);res.json({success:true,challans:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.post("/api/challans",auth,async(req,res)=>{try{const{client_id,challan_no,type,amount,period,payment_date,notes}=req.body;const id=uuid();await pool.query("INSERT INTO challans (id,user_id,client_id,challan_no,type,amount,period,payment_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,req.user.id,client_id,challan_no,type,parseFloat(amount)||0,period||null,payment_date,notes||null]);res.status(201).json({success:true,message:"Challan added"});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.delete("/api/challans/:id",auth,async(req,res)=>{try{await pool.query("DELETE FROM challans WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}});

// ══ IMPORT EXCEL ══
app.post("/api/import/clients",auth,upload.single("file"),async(req,res)=>{
  try{const wb=XLSX.read(req.file.buffer,{type:"buffer"});const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);let imported=0,skipped=0;for(const row of rows){const gstin=(row["GSTIN"]||row["gstin"]||"").toString().trim().toUpperCase();const name=(row["Name"]||row["name"]||row["Trade Name"]||"").toString().trim();if(!gstin||!name){skipped++;continue;}const ex=await pool.query("SELECT id FROM clients WHERE user_id=$1 AND gstin=$2",[req.user.id,gstin]);if(ex.rows[0]){skipped++;continue;}await pool.query("INSERT INTO clients (id,user_id,name,gstin,state,type,status) VALUES ($1,$2,$3,$4,$5,$6,'compliant')",[uuid(),req.user.id,name,gstin,(row["State"]||row["state"]||"").toString().trim(),(row["Type"]||row["type"]||"Trader").toString().trim()]);imported++;}res.json({success:true,message:`${imported} imported, ${skipped} skipped`});}catch(e){res.status(500).json({success:false,message:"Import failed: "+e.message});}
});

// ══ GSTR-2A ══
app.post("/api/gstr2a/preview",auth,upload.single("file"),async(req,res)=>{
  try{const wb=XLSX.read(req.file.buffer,{type:"buffer"});const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});const grouped={};for(const row of rows){const gstin=(row["GSTIN of Supplier"]||row["GSTIN"]||row["gstin"]||row["ctin"]||"").toString().trim().toUpperCase();if(!gstin||gstin.length<15)continue;const name=(row["Trade/Legal name of the Supplier"]||row["Trade Name"]||row["trdnm"]||"").toString().trim();const itc=(parseFloat(row["Integrated Tax Amount"]||row["iamt"]||0)||0)+(parseFloat(row["Central Tax Amount"]||row["camt"]||0)||0)+(parseFloat(row["State/UT Tax Amount"]||row["samt"]||0)||0);if(!grouped[gstin])grouped[gstin]={gstin,name,invoices:0,igst:parseFloat(row["Integrated Tax Amount"]||0)||0,cgst:parseFloat(row["Central Tax Amount"]||0)||0,sgst:parseFloat(row["State/UT Tax Amount"]||0)||0,itc:0};grouped[gstin].invoices++;grouped[gstin].itc+=itc;}const suppliers=Object.values(grouped);res.json({success:true,preview:{total_invoices:rows.length,total_suppliers:suppliers.length,total_itc:suppliers.reduce((a,s)=>a+s.itc,0),suppliers}});}catch(e){res.status(500).json({success:false,message:"Preview failed: "+e.message});}
});
app.post("/api/gstr2a/import",auth,upload.single("file"),async(req,res)=>{
  try{const{client_id,period}=req.body;const wb=XLSX.read(req.file.buffer,{type:"buffer"});const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});const grouped={};for(const row of rows){const gstin=(row["GSTIN of Supplier"]||row["GSTIN"]||row["gstin"]||row["ctin"]||"").toString().trim().toUpperCase();if(!gstin||gstin.length<15)continue;const name=(row["Trade/Legal name of the Supplier"]||row["Trade Name"]||row["trdnm"]||"").toString().trim();const itc=(parseFloat(row["Integrated Tax Amount"]||row["iamt"]||0)||0)+(parseFloat(row["Central Tax Amount"]||row["camt"]||0)||0)+(parseFloat(row["State/UT Tax Amount"]||row["samt"]||0)||0);if(!grouped[gstin])grouped[gstin]={gstin,name,count:0,itc:0};grouped[gstin].count++;grouped[gstin].itc+=itc;}let saved=0;for(const s of Object.values(grouped)){await pool.query("INSERT INTO reconciliation (id,user_id,client_id,period,vendor_name,vendor_gstin,invoice_count,gstr2a_amount,gstr2b_amount,books_amount,difference,status,remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,'mismatch','Imported from GSTR-2A') ON CONFLICT DO NOTHING",[uuid(),req.user.id,client_id,period,s.name,s.gstin,s.count,s.itc,s.itc,s.itc]);saved++;}res.json({success:true,message:`${saved} suppliers imported!`,summary:{total_invoices:rows.length,saved,total_itc:Object.values(grouped).reduce((a,s)=>a+s.itc,0)}});}catch(e){res.status(500).json({success:false,message:"Import failed: "+e.message});}
});

// ══ GSTIN ══
const STATES_MAP={"01":"Jammu & Kashmir","02":"Himachal Pradesh","03":"Punjab","04":"Chandigarh","05":"Uttarakhand","06":"Haryana","07":"Delhi","08":"Rajasthan","09":"Uttar Pradesh","10":"Bihar","18":"Assam","19":"West Bengal","20":"Jharkhand","21":"Odisha","22":"Chhattisgarh","23":"Madhya Pradesh","24":"Gujarat","27":"Maharashtra","29":"Karnataka","30":"Goa","32":"Kerala","33":"Tamil Nadu","36":"Telangana","37":"Andhra Pradesh"};
app.get("/api/gstin/validate/:gstin",auth,(req,res)=>{const g=req.params.gstin.toUpperCase().trim();const valid=/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(g);if(!valid)return res.json({success:true,valid:false,message:"Invalid GSTIN format"});res.json({success:true,valid:true,message:"Valid format",details:{gstin:g,state_code:g.substring(0,2),state:STATES_MAP[g.substring(0,2)]||"Unknown",pan:g.substring(2,12)}});});

// ══ STAFF ══
app.get("/api/staff",auth,async(req,res)=>{try{const r=await pool.query("SELECT id,name,email,role,firm_name,created_at FROM users WHERE parent_id=$1 ORDER BY created_at DESC",[req.user.id]);res.json({success:true,staff:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.post("/api/staff",auth,async(req,res)=>{try{const{name,email,password}=req.body;if(!name||!email||!password)return res.status(400).json({success:false,message:"All fields required"});const ex=await pool.query("SELECT id FROM users WHERE email=$1",[email.toLowerCase()]);if(ex.rows[0])return res.status(409).json({success:false,message:"Email exists"});const hashed=await bcrypt.hash(password,12);const id=uuid();await pool.query("INSERT INTO users (id,name,email,password,firm_name,role,parent_id) VALUES ($1,$2,$3,$4,$5,'staff',$6)",[id,name,email.toLowerCase(),hashed,req.user.firm_name,req.user.id]);res.status(201).json({success:true,message:"Staff added",staff:{id,name,email,role:"staff"}});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.delete("/api/staff/:id",auth,async(req,res)=>{try{await pool.query("DELETE FROM users WHERE id=$1 AND parent_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Staff removed"});}catch(e){res.status(500).json({success:false,message:e.message});}});


// ══ ACCOUNTING: COMPANIES ══
app.get("/api/accounting/companies",auth,async(req,res)=>{try{const r=await pool.query("SELECT * FROM companies WHERE user_id=$1 ORDER BY name ASC",[req.user.id]);res.json({success:true,companies:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.post("/api/accounting/companies",auth,async(req,res)=>{
  try{
    const{name,legal_name,gstin,pan,address,city,state,pincode,phone,email,fy_start,fy_end,financial_year}=req.body;
    if(!name)return res.status(400).json({success:false,message:"Company name required"});
    const id=uuid();
    await pool.query("INSERT INTO companies (id,user_id,name,legal_name,gstin,pan,address,city,state,pincode,phone,email,fy_start,fy_end,financial_year) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
      [id,req.user.id,name,legal_name||null,gstin||null,pan||null,address||null,city||null,state||null,pincode||null,phone||null,email||null,fy_start||"2024-04-01",fy_end||"2025-03-31",financial_year||"Apr-Mar"]);
    await createDefaultAccounting(id,req.user.id);
    const r=await pool.query("SELECT * FROM companies WHERE id=$1",[id]);
    res.status(201).json({success:true,message:"Company created with Chart of Accounts!",company:r.rows[0]});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.put("/api/accounting/companies/:id",auth,async(req,res)=>{
  try{const{name,legal_name,gstin,pan,address,city,state,pincode,phone,email,fy_start,fy_end}=req.body;await pool.query("UPDATE companies SET name=$1,legal_name=$2,gstin=$3,pan=$4,address=$5,city=$6,state=$7,pincode=$8,phone=$9,email=$10,fy_start=$11,fy_end=$12 WHERE id=$13 AND user_id=$14",[name,legal_name||null,gstin||null,pan||null,address||null,city||null,state||null,pincode||null,phone||null,email||null,fy_start||"2024-04-01",fy_end||"2025-03-31",req.params.id,req.user.id]);res.json({success:true,message:"Updated"});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/accounting/companies/:id",auth,async(req,res)=>{try{await pool.query("DELETE FROM companies WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}});

// ══ ACCOUNTING: LEDGER GROUPS ══
app.get("/api/accounting/companies/:cid/groups",auth,async(req,res)=>{try{const r=await pool.query("SELECT * FROM ledger_groups WHERE company_id=$1 AND user_id=$2 ORDER BY nature ASC,name ASC",[req.params.cid,req.user.id]);res.json({success:true,groups:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.post("/api/accounting/companies/:cid/groups",auth,async(req,res)=>{try{const{name,parent_id,nature,affects_gross}=req.body;if(!name||!nature)return res.status(400).json({success:false,message:"Name and nature required"});const id=uuid();await pool.query("INSERT INTO ledger_groups (id,user_id,company_id,name,parent_id,nature,affects_gross) VALUES ($1,$2,$3,$4,$5,$6,$7)",[id,req.user.id,req.params.cid,name,parent_id||null,nature,affects_gross||false]);const r=await pool.query("SELECT * FROM ledger_groups WHERE id=$1",[id]);res.status(201).json({success:true,message:"Group created",group:r.rows[0]});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.put("/api/accounting/companies/:cid/groups/:id",auth,async(req,res)=>{try{const{name,parent_id,nature,affects_gross}=req.body;await pool.query("UPDATE ledger_groups SET name=$1,parent_id=$2,nature=$3,affects_gross=$4 WHERE id=$5 AND user_id=$6",[name,parent_id||null,nature,affects_gross||false,req.params.id,req.user.id]);res.json({success:true,message:"Updated"});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.delete("/api/accounting/companies/:cid/groups/:id",auth,async(req,res)=>{try{const h=await pool.query("SELECT COUNT(*) as c FROM ledgers WHERE group_id=$1",[req.params.id]);if(parseInt(h.rows[0].c)>0)return res.status(400).json({success:false,message:"Cannot delete group with ledgers"});await pool.query("DELETE FROM ledger_groups WHERE id=$1 AND user_id=$2 AND is_default=FALSE",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}});

// ══ ACCOUNTING: LEDGERS ══
app.get("/api/accounting/companies/:cid/ledgers",auth,async(req,res)=>{
  try{
    const{group_id,nature,search}=req.query;
    let q="SELECT l.*,g.name as group_name,g.nature FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.company_id=$1 AND l.user_id=$2";
    const p=[req.params.cid,req.user.id];
    if(group_id){q+=` AND l.group_id=$${p.length+1}`;p.push(group_id);}
    if(nature){q+=` AND g.nature=$${p.length+1}`;p.push(nature);}
    if(search){q+=` AND l.name ILIKE $${p.length+1}`;p.push(`%${search}%`);}
    q+=" ORDER BY g.nature ASC,l.name ASC";
    const r=await pool.query(q,p);
    const withBalance=await Promise.all(r.rows.map(async l=>{
      const txn=await pool.query("SELECT COALESCE(SUM(dr_amount),0) as dr,COALESCE(SUM(cr_amount),0) as cr FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=$1 AND v.is_cancelled=FALSE",[l.id]);
      const opDr=l.opening_type==="Dr"?parseFloat(l.opening_balance):0,opCr=l.opening_type==="Cr"?parseFloat(l.opening_balance):0;
      const tDr=opDr+parseFloat(txn.rows[0].dr||0),tCr=opCr+parseFloat(txn.rows[0].cr||0);
      const bal=Math.abs(tDr-tCr),bt=tDr>=tCr?"Dr":"Cr";
      return{...l,total_dr:tDr,total_cr:tCr,balance:bal,balance_type:bt};
    }));
    res.json({success:true,ledgers:withBalance});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/accounting/companies/:cid/ledgers",auth,async(req,res)=>{
  try{
    const{name,group_id,opening_balance,opening_type,alias,gstin,pan,address,phone,email,bank_account,bank_name,ifsc_code,credit_limit,credit_days,notes}=req.body;
    if(!name||!group_id)return res.status(400).json({success:false,message:"Name and group required"});
    const ex=await pool.query("SELECT id FROM ledgers WHERE company_id=$1 AND name=$2",[req.params.cid,name]);
    if(ex.rows[0])return res.status(409).json({success:false,message:"Ledger with this name already exists"});
    const id=uuid();
    await pool.query("INSERT INTO ledgers (id,user_id,company_id,group_id,name,alias,opening_balance,opening_type,gstin,pan,address,phone,email,bank_account,bank_name,ifsc_code,credit_limit,credit_days,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
      [id,req.user.id,req.params.cid,group_id,name.trim(),alias||null,parseFloat(opening_balance)||0,opening_type||"Dr",gstin||null,pan||null,address||null,phone||null,email||null,bank_account||null,bank_name||null,ifsc_code||null,parseFloat(credit_limit)||0,parseInt(credit_days)||0,notes||null]);
    const r=await pool.query("SELECT * FROM ledgers WHERE id=$1",[id]);
    res.status(201).json({success:true,message:"Ledger created",ledger:r.rows[0]});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.put("/api/accounting/companies/:cid/ledgers/:id",auth,async(req,res)=>{
  try{const{name,group_id,opening_balance,opening_type,alias,gstin,pan,address,phone,email,bank_account,bank_name,ifsc_code,credit_limit,credit_days,notes}=req.body;await pool.query("UPDATE ledgers SET name=$1,group_id=$2,alias=$3,opening_balance=$4,opening_type=$5,gstin=$6,pan=$7,address=$8,phone=$9,email=$10,bank_account=$11,bank_name=$12,ifsc_code=$13,credit_limit=$14,credit_days=$15,notes=$16,updated_at=NOW() WHERE id=$17 AND user_id=$18",[name,group_id,alias||null,parseFloat(opening_balance)||0,opening_type||"Dr",gstin||null,pan||null,address||null,phone||null,email||null,bank_account||null,bank_name||null,ifsc_code||null,parseFloat(credit_limit)||0,parseInt(credit_days)||0,notes||null,req.params.id,req.user.id]);res.json({success:true,message:"Ledger updated"});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/accounting/companies/:cid/ledgers/:id",auth,async(req,res)=>{try{const h=await pool.query("SELECT COUNT(*) as c FROM voucher_items WHERE ledger_id=$1",[req.params.id]);if(parseInt(h.rows[0].c)>0)return res.status(400).json({success:false,message:"Cannot delete ledger with transactions"});await pool.query("DELETE FROM ledgers WHERE id=$1 AND user_id=$2 AND is_default=FALSE",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.get("/api/accounting/companies/:cid/ledgers/:id/statement",auth,async(req,res)=>{
  try{
    const{from_date,to_date}=req.query;
    const l=await pool.query("SELECT l.*,g.name as group_name,g.nature FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.id=$1",[req.params.id]);
    if(!l.rows[0])return res.status(404).json({success:false,message:"Ledger not found"});
    const ledger=l.rows[0];
    let q="SELECT vi.*,v.date,v.voucher_no,v.voucher_type,v.narration as v_narration FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=$1 AND v.is_cancelled=FALSE";
    const p=[req.params.id];
    if(from_date){q+=` AND v.date>=$${p.length+1}`;p.push(from_date);}
    if(to_date){q+=` AND v.date<=$${p.length+1}`;p.push(to_date);}
    q+=" ORDER BY v.date ASC,v.created_at ASC";
    const txns=await pool.query(q,p);
    let rb=ledger.opening_type==="Dr"?parseFloat(ledger.opening_balance):-parseFloat(ledger.opening_balance);
    const withBal=txns.rows.map(t=>{rb+=parseFloat(t.dr_amount||0)-parseFloat(t.cr_amount||0);return{...t,running_balance:Math.abs(rb),balance_type:rb>=0?"Dr":"Cr"};});
    const td=txns.rows.reduce((a,t)=>a+parseFloat(t.dr_amount||0),0),tc=txns.rows.reduce((a,t)=>a+parseFloat(t.cr_amount||0),0);
    res.json({success:true,ledger,transactions:withBal,summary:{opening_balance:ledger.opening_balance,opening_type:ledger.opening_type,total_dr:td,total_cr:tc,closing_balance:Math.abs(rb),closing_type:rb>=0?"Dr":"Cr"}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ ACCOUNTING: VOUCHERS ══
app.get("/api/accounting/companies/:cid/vouchers",auth,async(req,res)=>{
  try{const{type,from_date,to_date,search}=req.query;let q="SELECT * FROM vouchers WHERE company_id=$1 AND user_id=$2 AND is_cancelled=FALSE";const p=[req.params.cid,req.user.id];if(type){q+=` AND voucher_type=$${p.length+1}`;p.push(type);}if(from_date){q+=` AND date>=$${p.length+1}`;p.push(from_date);}if(to_date){q+=` AND date<=$${p.length+1}`;p.push(to_date);}if(search){q+=` AND (party_name ILIKE $${p.length+1} OR voucher_no ILIKE $${p.length+2} OR narration ILIKE $${p.length+3})`;p.push(`%${search}%`,`%${search}%`,`%${search}%`);}q+=" ORDER BY date DESC,created_at DESC";const r=await pool.query(q,p);res.json({success:true,count:r.rows.length,vouchers:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/accounting/companies/:cid/vouchers/:id",auth,async(req,res)=>{
  try{const v=await pool.query("SELECT * FROM vouchers WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);if(!v.rows[0])return res.status(404).json({success:false,message:"Voucher not found"});const items=await pool.query("SELECT vi.*,l.name as ledger_name,g.name as group_name,g.nature FROM voucher_items vi JOIN ledgers l ON vi.ledger_id=l.id JOIN ledger_groups g ON l.group_id=g.id WHERE vi.voucher_id=$1 ORDER BY vi.sort_order ASC",[req.params.id]);res.json({success:true,voucher:{...v.rows[0],items:items.rows}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/accounting/companies/:cid/vouchers",auth,async(req,res)=>{
  try{
    const{voucher_type,date,ref_no,narration,party_ledger_id,party_name,items=[]}=req.body;
    if(!voucher_type||!date)return res.status(400).json({success:false,message:"Voucher type and date required"});
    if(items.length<2)return res.status(400).json({success:false,message:"Minimum 2 ledger entries required (double-entry bookkeeping)"});
    const totalDr=items.reduce((a,i)=>a+parseFloat(i.dr_amount||0),0);
    const totalCr=items.reduce((a,i)=>a+parseFloat(i.cr_amount||0),0);
    if(Math.abs(totalDr-totalCr)>0.01)return res.status(400).json({success:false,message:`Voucher not balanced! Dr: Rs.${totalDr.toFixed(2)}, Cr: Rs.${totalCr.toFixed(2)}, Diff: Rs.${Math.abs(totalDr-totalCr).toFixed(2)}`});
    const id=uuid();
    const voucher_no=await genVoucherNo(req.params.cid,voucher_type);
    await pool.query("INSERT INTO vouchers (id,user_id,company_id,voucher_no,voucher_type,date,ref_no,narration,party_ledger_id,party_name,total_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [id,req.user.id,req.params.cid,voucher_no,voucher_type,date,ref_no||null,narration||null,party_ledger_id||null,party_name||null,totalDr]);
    for(let idx=0;idx<items.length;idx++){
      const item=items[idx];
      const ledger=await pool.query("SELECT id,name FROM ledgers WHERE id=$1",[item.ledger_id]);
      if(!ledger.rows[0])throw new Error(`Ledger not found: ${item.ledger_id}`);
      await pool.query("INSERT INTO voucher_items (id,voucher_id,ledger_id,ledger_name,dr_amount,cr_amount,narration,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [uuid(),id,item.ledger_id,ledger.rows[0].name,parseFloat(item.dr_amount)||0,parseFloat(item.cr_amount)||0,item.narration||null,idx]);
    }
    const voucher=await pool.query("SELECT * FROM vouchers WHERE id=$1",[id]);
    const vItems=await pool.query("SELECT * FROM voucher_items WHERE voucher_id=$1 ORDER BY sort_order ASC",[id]);
    res.status(201).json({success:true,message:`Voucher ${voucher_no} created successfully`,voucher:{...voucher.rows[0],items:vItems.rows}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.patch("/api/accounting/companies/:cid/vouchers/:id/cancel",auth,async(req,res)=>{try{await pool.query("UPDATE vouchers SET is_cancelled=TRUE,updated_at=NOW() WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Voucher cancelled"});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.delete("/api/accounting/companies/:cid/vouchers/:id",auth,async(req,res)=>{try{await pool.query("DELETE FROM voucher_items WHERE voucher_id=$1",[req.params.id]);await pool.query("DELETE FROM vouchers WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true,message:"Deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}});

// ══ ACCOUNTING: REPORTS ══
app.get("/api/accounting/companies/:cid/reports/trial-balance",auth,async(req,res)=>{
  try{
    const{from_date,to_date}=req.query;
    const ledgers=await pool.query("SELECT l.*,g.name as group_name,g.nature FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.company_id=$1 AND l.user_id=$2",[req.params.cid,req.user.id]);
    let totalDr=0,totalCr=0;
    const rows=await Promise.all(ledgers.rows.map(async l=>{
      let q="SELECT COALESCE(SUM(dr_amount),0) as dr,COALESCE(SUM(cr_amount),0) as cr FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=$1 AND v.is_cancelled=FALSE";
      const p=[l.id];if(from_date){q+=` AND v.date>=$${p.length+1}`;p.push(from_date);}if(to_date){q+=` AND v.date<=$${p.length+1}`;p.push(to_date);}
      const txn=await pool.query(q,p);
      const opDr=l.opening_type==="Dr"?parseFloat(l.opening_balance):0,opCr=l.opening_type==="Cr"?parseFloat(l.opening_balance):0;
      const nDr=opDr+parseFloat(txn.rows[0].dr||0),nCr=opCr+parseFloat(txn.rows[0].cr||0);
      const bal=Math.abs(nDr-nCr),bt=nDr>=nCr?"Dr":"Cr";
      if(bal>0){if(bt==="Dr")totalDr+=bal;else totalCr+=bal;}
      return{id:l.id,name:l.name,group:l.group_name,nature:l.nature,dr_amount:nDr>=nCr?bal:0,cr_amount:nCr>nDr?bal:0,balance:bal,balance_type:bt};
    }));
    res.json({success:true,rows:rows.filter(r=>r.balance>0),totals:{dr:totalDr,cr:totalCr,balanced:Math.abs(totalDr-totalCr)<0.01}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/accounting/companies/:cid/reports/profit-loss",auth,async(req,res)=>{
  try{
    const{from_date,to_date}=req.query;
    const ledgers=await pool.query("SELECT l.*,g.nature,g.affects_gross FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.company_id=$1 AND l.user_id=$2",[req.params.cid,req.user.id]);
    let totalIncome=0,totalExpense=0;
    const sales=[],purchase=[],directExp=[],indirectInc=[],indirectExp=[];
    for(const l of ledgers.rows){
      let q="SELECT COALESCE(SUM(dr_amount),0) as dr,COALESCE(SUM(cr_amount),0) as cr FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=$1 AND v.is_cancelled=FALSE";
      const p=[l.id];if(from_date){q+=` AND v.date>=$${p.length+1}`;p.push(from_date);}if(to_date){q+=` AND v.date<=$${p.length+1}`;p.push(to_date);}
      const txn=await pool.query(q,p);
      const nDr=parseFloat(txn.rows[0].dr||0),nCr=parseFloat(txn.rows[0].cr||0);
      if(l.nature==="Income"){const amt=nCr-nDr;if(amt===0)continue;if(l.affects_gross){sales.push({name:l.name,amount:amt});}else{indirectInc.push({name:l.name,amount:amt});}totalIncome+=amt;}
      else if(l.nature==="Expense"){const amt=nDr-nCr;if(amt===0)continue;if(l.affects_gross){purchase.push({name:l.name,amount:amt});directExp.push({name:l.name,amount:amt});}else{indirectExp.push({name:l.name,amount:amt});}totalExpense+=amt;}
    }
    const grossProfit=sales.reduce((a,s)=>a+s.amount,0)-purchase.reduce((a,s)=>a+s.amount,0);
    const netProfit=totalIncome-totalExpense;
    res.json({success:true,report:{sales,purchase,direct_expenses:directExp,indirect_income:indirectInc,indirect_expenses:indirectExp,gross_profit:grossProfit,net_profit:netProfit,total_income:totalIncome,total_expense:totalExpense}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/accounting/companies/:cid/reports/balance-sheet",auth,async(req,res)=>{
  try{
    const{as_on_date}=req.query;
    const ledgers=await pool.query("SELECT l.*,g.name as group_name,g.nature FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.company_id=$1 AND l.user_id=$2",[req.params.cid,req.user.id]);
    const assets=[],liabilities=[];let totalAssets=0,totalLiabilities=0;
    for(const l of ledgers.rows){
      let q="SELECT COALESCE(SUM(dr_amount),0) as dr,COALESCE(SUM(cr_amount),0) as cr FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=$1 AND v.is_cancelled=FALSE";
      const p=[l.id];if(as_on_date){q+=` AND v.date<=$${p.length+1}`;p.push(as_on_date);}
      const txn=await pool.query(q,p);
      const opDr=l.opening_type==="Dr"?parseFloat(l.opening_balance):0,opCr=l.opening_type==="Cr"?parseFloat(l.opening_balance):0;
      const nDr=opDr+parseFloat(txn.rows[0].dr||0),nCr=opCr+parseFloat(txn.rows[0].cr||0);
      const bal=Math.abs(nDr-nCr);if(bal===0)continue;
      const bt=nDr>=nCr?"Dr":"Cr";
      const entry={name:l.name,group:l.group_name,balance:bal,balance_type:bt};
      if(l.nature==="Asset"){assets.push(entry);totalAssets+=bal;}
      else if(l.nature==="Liability"){liabilities.push(entry);totalLiabilities+=bal;}
    }
    res.json({success:true,as_on_date:as_on_date||new Date().toISOString().split("T")[0],assets,liabilities,total_assets:totalAssets,total_liabilities:totalLiabilities,difference:Math.abs(totalAssets-totalLiabilities)});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/accounting/companies/:cid/reports/day-book",auth,async(req,res)=>{
  try{
    const date=req.query.date||new Date().toISOString().split("T")[0];
    const vouchers=await pool.query("SELECT * FROM vouchers WHERE company_id=$1 AND user_id=$2 AND date=$3 AND is_cancelled=FALSE ORDER BY created_at ASC",[req.params.cid,req.user.id,date]);
    const withItems=await Promise.all(vouchers.rows.map(async v=>{const items=await pool.query("SELECT * FROM voucher_items WHERE voucher_id=$1 ORDER BY sort_order ASC",[v.id]);return{...v,items:items.rows};}));
    const td=withItems.reduce((a,v)=>a+v.items.reduce((b,i)=>b+parseFloat(i.dr_amount||0),0),0);
    const tc=withItems.reduce((a,v)=>a+v.items.reduce((b,i)=>b+parseFloat(i.cr_amount||0),0),0);
    res.json({success:true,date,vouchers:withItems,summary:{total_vouchers:vouchers.rows.length,total_dr:td,total_cr:tc}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/accounting/companies/:cid/reports/cash-book",auth,async(req,res)=>{
  try{
    const{from_date,to_date}=req.query;
    const cl=await pool.query("SELECT l.* FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.company_id=$1 AND l.user_id=$2 AND l.name='Cash' LIMIT 1",[req.params.cid,req.user.id]);
    if(!cl.rows[0])return res.status(404).json({success:false,message:"Cash ledger not found"});
    let q="SELECT vi.*,v.date,v.voucher_no,v.voucher_type,v.narration as v_narration,v.party_name FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=$1 AND v.is_cancelled=FALSE";
    const p=[cl.rows[0].id];if(from_date){q+=` AND v.date>=$${p.length+1}`;p.push(from_date);}if(to_date){q+=` AND v.date<=$${p.length+1}`;p.push(to_date);}q+=" ORDER BY v.date ASC";
    const txns=await pool.query(q,p);
    const td=txns.rows.reduce((a,t)=>a+parseFloat(t.dr_amount||0),0),tc=txns.rows.reduce((a,t)=>a+parseFloat(t.cr_amount||0),0);
    const op=parseFloat(cl.rows[0].opening_balance),opDr=cl.rows[0].opening_type==="Dr"?op:0,closing=opDr+td-tc;
    res.json({success:true,ledger:cl.rows[0],transactions:txns.rows,summary:{opening:op,opening_type:cl.rows[0].opening_type,total_receipts:td,total_payments:tc,closing:Math.abs(closing),closing_type:closing>=0?"Dr":"Cr"}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ GODOWNS ══
app.get("/api/accounting/companies/:cid/godowns",auth,async(req,res)=>{try{const r=await pool.query("SELECT * FROM godowns WHERE company_id=$1 AND user_id=$2 ORDER BY name ASC",[req.params.cid,req.user.id]);res.json({success:true,godowns:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.post("/api/accounting/companies/:cid/godowns",auth,async(req,res)=>{try{const{name,address}=req.body;if(!name)return res.status(400).json({success:false,message:"Name required"});const id=uuid();await pool.query("INSERT INTO godowns (id,user_id,company_id,name,address) VALUES ($1,$2,$3,$4,$5)",[id,req.user.id,req.params.cid,name,address||null]);res.status(201).json({success:true,message:"Godown created"});}catch(e){res.status(500).json({success:false,message:e.message});}});

// ══ HEALTH ══
app.get("/health",(req,res)=>res.json({success:true,message:"TaxPro Complete v4.0 - PostgreSQL",db:"PostgreSQL",version:"4.0.0"}));

// ══ GSTR-1 AUTO-POPULATED ══
app.get("/api/gstr1/:period",auth,async(req,res)=>{
  try{
    const{period}=req.params;const uid=req.user.id;
    // period format: "Apr-2024" or "2024-04"
    const[yr,mo]=period.includes("-")?period.split("-"):[null,null];
    let q="SELECT * FROM invoices WHERE user_id=$1 AND invoice_type='SALES' AND status!='cancelled'";
    const p=[uid];
    if(yr&&mo){q+=` AND invoice_date LIKE $${p.length+1}`;p.push(`${yr}-${mo.padStart(2,"0")}%`);}
    const r=await pool.query(q,p);const invs=r.rows;
    const b2b=invs.filter(i=>i.party_gstin&&i.party_gstin.length===15);
    const b2c=invs.filter(i=>!i.party_gstin||i.party_gstin.length!==15);
    const hsnMap={};
    for(const inv of invs){
      const items=await pool.query("SELECT * FROM invoice_items WHERE invoice_id=$1",[inv.id]);
      for(const item of items.rows){
        const hsn=item.hsn_sac||"0000";
        if(!hsnMap[hsn])hsnMap[hsn]={hsn_sc:hsn,uqc:"NOS",total_qty:0,total_val:0,taxable_val:0,igst:0,cgst:0,sgst:0,cess:0};
        hsnMap[hsn].total_qty+=parseFloat(item.qty||0);
        hsnMap[hsn].total_val+=parseFloat(item.total_amount||0);
        hsnMap[hsn].taxable_val+=parseFloat(item.taxable_value||0);
        hsnMap[hsn].igst+=parseFloat(item.igst_amount||0);
        hsnMap[hsn].cgst+=parseFloat(item.cgst_amount||0);
        hsnMap[hsn].sgst+=parseFloat(item.sgst_amount||0);
      }
    }
    res.json({success:true,period,b2b,b2c,hsn_summary:Object.values(hsnMap),summary:{total_invoices:invs.length,b2b_count:b2b.length,b2c_count:b2c.length,total_taxable:invs.reduce((a,i)=>a+parseFloat(i.taxable_amount||0),0),total_igst:invs.reduce((a,i)=>a+parseFloat(i.igst_amount||0),0),total_cgst:invs.reduce((a,i)=>a+parseFloat(i.cgst_amount||0),0),total_sgst:invs.reduce((a,i)=>a+parseFloat(i.sgst_amount||0),0),total_tax:invs.reduce((a,i)=>a+parseFloat(i.total_tax||0),0),total_amount:invs.reduce((a,i)=>a+parseFloat(i.total_amount||0),0)}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ GSTR-3B AUTO-POPULATED ══
app.get("/api/gstr3b/:period",auth,async(req,res)=>{
  try{
    const uid=req.user.id;const{period}=req.params;
    const[yr,mo]=period.split("-");
    const likeStr=`${yr}-${mo.padStart(2,"0")}%`;
    const sales=await pool.query("SELECT COALESCE(SUM(taxable_amount),0) as t,COALESCE(SUM(igst_amount),0) as igst,COALESCE(SUM(cgst_amount),0) as cgst,COALESCE(SUM(sgst_amount),0) as sgst FROM invoices WHERE user_id=$1 AND invoice_type='SALES' AND invoice_date LIKE $2",[uid,likeStr]);
    const purchase=await pool.query("SELECT COALESCE(SUM(taxable_amount),0) as t,COALESCE(SUM(igst_amount),0) as igst,COALESCE(SUM(cgst_amount),0) as cgst,COALESCE(SUM(sgst_amount),0) as sgst FROM invoices WHERE user_id=$1 AND invoice_type='PURCHASE' AND invoice_date LIKE $2",[uid,likeStr]);
    const s=sales.rows[0],pu=purchase.rows[0];
    const outputIGST=parseFloat(s.igst||0),outputCGST=parseFloat(s.cgst||0),outputSGST=parseFloat(s.sgst||0);
    const inputIGST=parseFloat(pu.igst||0),inputCGST=parseFloat(pu.cgst||0),inputSGST=parseFloat(pu.sgst||0);
    const netIGST=outputIGST-inputIGST,netCGST=outputCGST-inputCGST,netSGST=outputSGST-inputSGST;
    res.json({success:true,period,
      table31:{outward_taxable_supplies:parseFloat(s.t||0),igst:outputIGST,cgst:outputCGST,sgst:outputSGST,cess:0},
      table4:{itc_igst:inputIGST,itc_cgst:inputCGST,itc_sgst:inputSGST,itc_cess:0,total_itc:inputIGST+inputCGST+inputSGST},
      table6:{igst_payable:Math.max(0,netIGST),cgst_payable:Math.max(0,netCGST),sgst_payable:Math.max(0,netSGST),total_payable:Math.max(0,netIGST)+Math.max(0,netCGST)+Math.max(0,netSGST)}
    });
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ E-INVOICE ══
app.get("/api/einvoice",auth,async(req,res)=>{
  try{const r=await pool.query("SELECT * FROM invoices WHERE user_id=$1 AND invoice_type='SALES' ORDER BY created_at DESC LIMIT 50",[req.user.id]);res.json({success:true,invoices:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/einvoice/generate",auth,async(req,res)=>{
  try{
    const{invoice_id}=req.body;
    const inv=await pool.query("SELECT * FROM invoices WHERE id=$1 AND user_id=$2",[invoice_id,req.user.id]);
    if(!inv.rows[0])return res.status(404).json({success:false,message:"Invoice not found"});
    // Mock IRN generation (in production, call NIC API)
    const irn=`IRN${Date.now()}${Math.random().toString(36).substring(2,10).toUpperCase()}`;
    const ack_no=`ACK${Date.now()}`;
    const ack_date=new Date().toISOString().split("T")[0];
    await pool.query("UPDATE invoices SET einvoice_irn=$1,updated_at=NOW() WHERE id=$2",[irn,invoice_id]);
    res.json({success:true,message:"E-Invoice generated!",irn,ack_no,ack_date,invoice_no:inv.rows[0].invoice_no,party_name:inv.rows[0].party_name,total_amount:inv.rows[0].total_amount});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ E-WAY BILL ══
app.post("/api/ewaybill/generate",auth,async(req,res)=>{
  try{
    const{invoice_id,transporter_name,transporter_id,vehicle_no,vehicle_type,distance,supply_type}=req.body;
    if(!invoice_id)return res.status(400).json({success:false,message:"Invoice required"});
    const ewb_no=`EWB${Date.now()}`.substring(0,12);
    const valid_till=new Date(Date.now()+(parseInt(distance||100)/200+1)*24*60*60*1000).toISOString().split("T")[0];
    res.json({success:true,message:"E-Way Bill generated!",ewb_no,valid_till,transporter_name:transporter_name||"Self",vehicle_no:vehicle_no||"",distance:parseInt(distance)||100});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ USER PROFILE UPDATE ══
app.put("/api/auth/profile",auth,async(req,res)=>{
  try{const{name,firm_name,frn,phone,gstin}=req.body;await pool.query("UPDATE users SET name=$1,firm_name=$2,frn=$3,phone=$4,gstin=$5 WHERE id=$6",[name,firm_name,frn||null,phone||null,gstin||null,req.user.id]);res.json({success:true,message:"Profile updated"});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ ENHANCED GSTIN VALIDATE + LOOKUP ══
const STATES_MAP_FULL={
  "01":"Jammu & Kashmir","02":"Himachal Pradesh","03":"Punjab","04":"Chandigarh",
  "05":"Uttarakhand","06":"Haryana","07":"Delhi","08":"Rajasthan","09":"Uttar Pradesh",
  "10":"Bihar","11":"Sikkim","12":"Arunachal Pradesh","13":"Nagaland","14":"Manipur",
  "15":"Mizoram","16":"Tripura","17":"Meghalaya","18":"Assam","19":"West Bengal",
  "20":"Jharkhand","21":"Odisha","22":"Chhattisgarh","23":"Madhya Pradesh","24":"Gujarat",
  "25":"Daman & Diu","26":"Dadra & Nagar Haveli","27":"Maharashtra","28":"Andhra Pradesh (Old)",
  "29":"Karnataka","30":"Goa","31":"Lakshadweep","32":"Kerala","33":"Tamil Nadu",
  "34":"Puducherry","35":"Andaman & Nicobar","36":"Telangana","37":"Andhra Pradesh",
  "38":"Ladakh","97":"Other Territory","99":"Centre Jurisdiction"
};

function validateGSTINFormat(gstin){
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin);
}

function validateGSTINChecksum(gstin){
  try{
    const chars="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let sum=0;
    for(let i=0;i<14;i++){
      const idx=chars.indexOf(gstin[i]);
      if(idx===-1)return false;
      const val=i%2===0?idx:(idx*2);
      sum+=Math.floor(val/36)+(val%36);
    }
    const expected=chars[(36-(sum%36))%36];
    return expected===gstin[14];
  }catch(e){return false;}
}

app.get("/api/gstin/lookup/:gstin",auth,async(req,res)=>{
  try{
    const gstin=req.params.gstin.toUpperCase().trim();
    // Step 1: Format validation
    if(!validateGSTINFormat(gstin)){
      return res.json({success:false,valid:false,message:"Invalid GSTIN format. Must be 15 characters: 2 digits + 5 letters + 4 digits + 1 letter + 1 alphanumeric + Z + 1 alphanumeric"});
    }
    // Step 2: Checksum validation
    if(!validateGSTINChecksum(gstin)){
      return res.json({success:false,valid:false,message:"Invalid GSTIN — checksum failed. Please check the last character."});
    }
    // Step 3: Extract info from GSTIN
    const stateCode=gstin.substring(0,2);
    const pan=gstin.substring(2,12);
    const state=STATES_MAP_FULL[stateCode]||"Unknown State";
    const entityType=gstin[12];
    const entityMap={"1":"Proprietorship","2":"Partnership","3":"HUF","4":"Company","5":"Trust","6":"Government","7":"LLP","9":"PEO"};
    const entity=entityMap[entityType]||"Business";

    // Step 4: Try to fetch from GST public API
    let businessName="",address="",pincode="",city="";
    try{
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),5000);
      const apiRes=await fetch(`https://api.gst.gov.in/commonapi/v1.1/search?action=TP&gstin=${gstin}`,{
        signal:controller.signal,
        headers:{"Accept":"application/json","Content-Type":"application/json"}
      });
      clearTimeout(timeout);
      if(apiRes.ok){
        const apiData=await apiRes.json();
        if(apiData?.taxpayerInfo){
          businessName=apiData.taxpayerInfo.lgnm||apiData.taxpayerInfo.tradeNam||"";
          const adr=apiData.taxpayerInfo.pradr?.addr;
          if(adr){
            address=[adr.bno,adr.st,adr.loc].filter(Boolean).join(", ");
            city=adr.dst||adr.loc||"";
            pincode=adr.pncd||"";
          }
        }
      }
    }catch(e){/* API unavailable, return format-validated data */}

    res.json({
      success:true,
      valid:true,
      gstin,
      state_code:stateCode,
      state,
      pan,
      entity_type:entity,
      business_name:businessName,
      address,
      city,
      pincode,
      message:businessName?`✅ Valid GSTIN — ${businessName}`:`✅ Valid GSTIN — ${state} (${entity})`
    });
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ HSN CODES TABLE (added in initDB via migration) ══
// Run this once to create the table
pool.query(`
  CREATE TABLE IF NOT EXISTS hsn_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    code TEXT NOT NULL,
    description TEXT DEFAULT '',
    gst_rate REAL DEFAULT 0,
    uom TEXT DEFAULT 'NOS',
    chapter TEXT DEFAULT '',
    is_service BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(()=>{});

pool.query(`CREATE INDEX IF NOT EXISTS idx_hsn_code ON hsn_codes(code)`).catch(()=>{});
pool.query(`CREATE INDEX IF NOT EXISTS idx_hsn_user ON hsn_codes(user_id)`).catch(()=>{});

// ══ HSN: SEARCH (autocomplete) ══
app.get("/api/hsn/search",auth,async(req,res)=>{
  try{
    const{q="",limit=10}=req.query;
    if(!q||q.length<2)return res.json({success:true,codes:[]});
    const r=await pool.query(
      `SELECT DISTINCT ON (code) code,description,gst_rate,uom,is_service
       FROM hsn_codes
       WHERE user_id=$1 AND (code ILIKE $2 OR description ILIKE $3)
       ORDER BY code ASC LIMIT $4`,
      [req.user.id,`${q}%`,`%${q}%`,parseInt(limit)||10]
    );
    res.json({success:true,codes:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ HSN: GET ALL (paginated) ══
app.get("/api/hsn/codes",auth,async(req,res)=>{
  try{
    const{page=1,limit=50,search=""}=req.query;
    const offset=(parseInt(page)-1)*parseInt(limit);
    let q="SELECT * FROM hsn_codes WHERE user_id=$1";
    const p=[req.user.id];
    if(search){q+=` AND (code ILIKE $${p.length+1} OR description ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}
    q+=` ORDER BY code ASC LIMIT $${p.length+1} OFFSET $${p.length+2}`;
    p.push(parseInt(limit),offset);
    const r=await pool.query(q,p);
    const count=await pool.query(`SELECT COUNT(*) as c FROM hsn_codes WHERE user_id=$1${search?` AND (code ILIKE '%${search}%' OR description ILIKE '%${search}%')`:""}`, [req.user.id]);
    res.json({success:true,codes:r.rows,total:parseInt(count.rows[0].c),page:parseInt(page),limit:parseInt(limit)});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ HSN: UPLOAD EXCEL/CSV ══
app.post("/api/hsn/upload",auth,upload.single("file"),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({success:false,message:"File required"});
    const wb=XLSX.read(req.file.buffer,{type:"buffer"});
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});
    if(!rows.length)return res.status(400).json({success:false,message:"No data found in file"});

    // Auto-detect column names (handles various Excel formats)
    const sample=rows[0];
    const keys=Object.keys(sample).map(k=>k.toLowerCase().trim());
    const findKey=(options)=>Object.keys(sample).find(k=>options.includes(k.toLowerCase().trim()))||null;

    const codeKey  =findKey(["hsn code","hsn","code","hsn/sac","sac code","hsncode","hsnsac"]);
    const descKey  =findKey(["description","desc","item description","goods description","commodity","name","product","item","hsn description"]);
    const gstKey   =findKey(["gst rate","gst","rate","tax rate","gst%","rate%","cgst+sgst","igst","tax","gstrate"]);
    const uomKey   =findKey(["uom","unit","unit of measure","uqc","unit of measurement"]);

    if(!codeKey)return res.status(400).json({success:false,message:`HSN Code column not found. Found columns: ${Object.keys(sample).join(", ")}`});

    let imported=0,skipped=0,updated=0;
    const uid=req.user.id;

    for(const row of rows){
      const code=String(row[codeKey]||"").trim().replace(/[^0-9]/g,"");
      if(!code||code.length<2){skipped++;continue;}
      const desc=descKey?String(row[descKey]||"").trim():"";
      const gstRaw=gstKey?String(row[gstKey]||"0").replace(/[^0-9.]/g,""):"0";
      const gst=parseFloat(gstRaw)||0;
      const uom=uomKey?String(row[uomKey]||"NOS").trim().toUpperCase():"NOS";
      const chapter=code.substring(0,2);
      const isSvc=gstKey&&String(row[gstKey]||"").toLowerCase().includes("service")?true:false;

      const existing=await pool.query("SELECT id FROM hsn_codes WHERE user_id=$1 AND code=$2",[uid,code]);
      if(existing.rows[0]){
        await pool.query("UPDATE hsn_codes SET description=$1,gst_rate=$2,uom=$3,chapter=$4 WHERE id=$5",[desc||existing.rows[0].description,gst,uom,chapter,existing.rows[0].id]);
        updated++;
      }else{
        await pool.query("INSERT INTO hsn_codes (id,user_id,code,description,gst_rate,uom,chapter,is_service) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",[uuid(),uid,code,desc,gst,uom,chapter,isSvc]);
        imported++;
      }
    }

    res.json({success:true,message:`✅ Done! ${imported} new HSN codes imported, ${updated} updated, ${skipped} skipped`,imported,updated,skipped,total:rows.length});
  }catch(e){res.status(500).json({success:false,message:"Upload failed: "+e.message});}
});

// ══ HSN: DELETE ALL ══
app.delete("/api/hsn/codes",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM hsn_codes WHERE user_id=$1",[req.user.id]);res.json({success:true,message:"All HSN codes deleted"});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ HSN: GET SINGLE ══
app.get("/api/hsn/code/:code",auth,async(req,res)=>{
  try{const r=await pool.query("SELECT * FROM hsn_codes WHERE user_id=$1 AND code=$2 LIMIT 1",[req.user.id,req.params.code]);res.json({success:true,code:r.rows[0]||null});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ DATA BACKUP ══
app.get("/api/backup/export", auth, async(req,res)=>{
  try{
    const uid = req.user.id;
    const user = await pool.query("SELECT id,name,email,firm_name,frn,role FROM users WHERE id=$1",[uid]);

    // Fetch all data in parallel
    const [
      clients, invoices, invoice_items, payments,
      products, stock_movements,
      notices, returns, reconciliation, challans,
      bank_txns, bank_imports,
      companies, groups, ledgers, vouchers, voucher_items,
      hsn_codes
    ] = await Promise.all([
      pool.query("SELECT * FROM clients WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM invoices WHERE user_id=$1",[uid]),
      pool.query("SELECT ii.* FROM invoice_items ii JOIN invoices i ON ii.invoice_id=i.id WHERE i.user_id=$1",[uid]),
      pool.query("SELECT * FROM payments WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM products WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM stock_movements WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM notices WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM returns WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM reconciliation WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM challans WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM bank_transactions WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM bank_imports WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM companies WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM ledger_groups WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM ledgers WHERE user_id=$1",[uid]),
      pool.query("SELECT * FROM vouchers WHERE user_id=$1",[uid]),
      pool.query("SELECT vi.* FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE v.user_id=$1",[uid]),
      pool.query("SELECT * FROM hsn_codes WHERE user_id=$1",[uid]),
    ]);

    const backup = {
      backup_version: "2.0",
      app: "TaxPro GST v4.0",
      exported_at: new Date().toISOString(),
      exported_by: user.rows[0]?.email,
      firm_name: user.rows[0]?.firm_name,
      data: {
        clients: clients.rows,
        invoices: invoices.rows,
        invoice_items: invoice_items.rows,
        payments: payments.rows,
        products: products.rows,
        stock_movements: stock_movements.rows,
        notices: notices.rows,
        returns: returns.rows,
        reconciliation: reconciliation.rows,
        challans: challans.rows,
        bank_transactions: bank_txns.rows,
        bank_imports: bank_imports.rows,
        accounting: {
          companies: companies.rows,
          ledger_groups: groups.rows,
          ledgers: ledgers.rows,
          vouchers: vouchers.rows,
          voucher_items: voucher_items.rows,
        },
        hsn_codes: hsn_codes.rows,
      },
      stats: {
        clients: clients.rows.length,
        invoices: invoices.rows.length,
        products: products.rows.length,
        vouchers: vouchers.rows.length,
        bank_transactions: bank_txns.rows.length,
        hsn_codes: hsn_codes.rows.length,
        total_records: clients.rows.length + invoices.rows.length + products.rows.length + vouchers.rows.length,
      }
    };

    const json = JSON.stringify(backup, null, 2);
    const filename = `taxpro_backup_${user.rows[0]?.firm_name?.replace(/[^a-zA-Z0-9]/g,"_")}_${new Date().toISOString().split("T")[0]}.json`;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(json);
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// Backup stats (how much data)
app.get("/api/backup/stats", auth, async(req,res)=>{
  try{
    const uid=req.user.id;
    const tables=["clients","invoices","products","notices","returns","reconciliation","bank_transactions","vouchers","hsn_codes","payments","challans"];
    const stats={};
    for(const t of tables){
      try{
        const r=await pool.query(`SELECT COUNT(*) as c FROM ${t} WHERE user_id=$1`,[uid]);
        stats[t]=parseInt(r.rows[0].c);
      }catch(e){stats[t]=0;}
    }
    const total=Object.values(stats).reduce((a,v)=>a+v,0);
    const lastInvoice=await pool.query("SELECT created_at FROM invoices WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",[uid]);
    res.json({success:true,stats,total_records:total,last_invoice:lastInvoice.rows[0]?.created_at||null});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// Restore from backup (selective)
app.post("/api/backup/restore-check", auth, async(req,res)=>{
  try{
    const{backup}=req.body;
    if(!backup?.data)return res.status(400).json({success:false,message:"Invalid backup file"});
    if(backup.backup_version!=="2.0")return res.status(400).json({success:false,message:"Incompatible backup version"});
    res.json({success:true,message:"Backup file is valid",stats:backup.stats,exported_at:backup.exported_at,firm:backup.firm_name});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});


// ══ FULL DATA RESTORE ══
app.post("/api/backup/restore", auth, async(req,res)=>{
  try{
    const{backup}=req.body;
    if(!backup?.data)return res.status(400).json({success:false,message:"Invalid backup"});
    const uid=req.user.id;
    const d=backup.data;
    let restored={clients:0,invoices:0,invoice_items:0,products:0,notices:0,returns:0,reconciliation:0,payments:0,bank_transactions:0,hsn_codes:0,companies:0,ledger_groups:0,ledgers:0,vouchers:0,voucher_items:0};

    // Restore clients
    for(const r of d.clients||[]){
      try{await pool.query(`INSERT INTO clients (id,user_id,name,gstin,state,type,turnover,notes,status,phone,email,address,city,pincode,pan,credit_limit,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,gstin=EXCLUDED.gstin`,
        [r.id,uid,r.name,r.gstin||null,r.state||null,r.type||"Trader",r.turnover||null,r.notes||null,r.status||"compliant",r.phone||null,r.email||null,r.address||null,r.city||null,r.pincode||null,r.pan||null,r.credit_limit||0,r.created_at||new Date()]);restored.clients++;}catch(e){}
    }
    // Restore products
    for(const r of d.products||[]){
      try{await pool.query(`INSERT INTO products (id,user_id,name,code,hsn_sac,unit,category,gst_rate,purchase_price,sale_price,stock_qty,min_stock,description,is_service,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
        [r.id,uid,r.name,r.code||null,r.hsn_sac||null,r.unit||"PCS",r.category||null,r.gst_rate||18,r.purchase_price||0,r.sale_price||0,r.stock_qty||0,r.min_stock||0,r.description||null,r.is_service||false,r.created_at||new Date()]);restored.products++;}catch(e){}
    }
    // Restore invoices
    for(const r of d.invoices||[]){
      try{await pool.query(`INSERT INTO invoices (id,user_id,invoice_no,invoice_type,party_id,party_name,party_gstin,party_address,party_state,invoice_date,due_date,place_of_supply,is_igst,subtotal,taxable_amount,igst_amount,cgst_amount,sgst_amount,total_tax,total_amount,paid_amount,balance_due,status,notes,terms,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) ON CONFLICT (id) DO NOTHING`,
        [r.id,uid,r.invoice_no,r.invoice_type||"SALES",r.party_id||null,r.party_name,r.party_gstin||null,r.party_address||null,r.party_state||null,r.invoice_date,r.due_date||null,r.place_of_supply||null,r.is_igst||false,r.subtotal||0,r.taxable_amount||0,r.igst_amount||0,r.cgst_amount||0,r.sgst_amount||0,r.total_tax||0,r.total_amount||0,r.paid_amount||0,r.balance_due||0,r.status||"unpaid",r.notes||null,r.terms||null,r.created_at||new Date()]);restored.invoices++;}catch(e){}
    }
    // Restore invoice items
    for(const r of d.invoice_items||[]){
      try{await pool.query(`INSERT INTO invoice_items (id,invoice_id,product_id,name,hsn_sac,unit,qty,rate,discount_pct,taxable_value,gst_rate,igst_amount,cgst_amount,sgst_amount,total_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
        [r.id,r.invoice_id,r.product_id||null,r.name,r.hsn_sac||null,r.unit||"PCS",r.qty||0,r.rate||0,r.discount_pct||0,r.taxable_value||0,r.gst_rate||0,r.igst_amount||0,r.cgst_amount||0,r.sgst_amount||0,r.total_amount||0]);restored.invoice_items++;}catch(e){}
    }
    // Restore payments
    for(const r of d.payments||[]){
      try{await pool.query(`INSERT INTO payments (id,user_id,invoice_id,party_name,type,amount,method,reference_no,payment_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [r.id,uid,r.invoice_id,r.party_name,r.type||"RECEIVED",r.amount||0,r.method||"CASH",r.reference_no||null,r.payment_date]);restored.payments++;}catch(e){}
    }
    // Restore notices
    for(const r of d.notices||[]){
      try{await pool.query(`INSERT INTO notices (id,user_id,client_id,ref_no,type,issued_date,due_date,amount,status,priority,description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [r.id,uid,r.client_id,r.ref_no,r.type,r.issued_date,r.due_date,r.amount||0,r.status||"pending",r.priority||"medium",r.description||null]);restored.notices++;}catch(e){}
    }
    // Restore returns
    for(const r of d.returns||[]){
      try{await pool.query(`INSERT INTO returns (id,user_id,client_id,period,gstr1_status,gstr3b_status,gstr9_status) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [r.id,uid,r.client_id,r.period,r.gstr1_status||"not-filed",r.gstr3b_status||"not-filed",r.gstr9_status||"not-filed"]);restored.returns++;}catch(e){}
    }
    // Restore bank transactions
    for(const r of d.bank_transactions||[]){
      try{await pool.query(`INSERT INTO bank_transactions (id,user_id,bank_name,account_no,txn_date,description,debit,credit,balance,category,type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [r.id,uid,r.bank_name||"",r.account_no||"",r.txn_date,r.description,r.debit||0,r.credit||0,r.balance||0,r.category||"Uncategorized",r.type||"UNKNOWN"]);restored.bank_transactions++;}catch(e){}
    }
    // Restore HSN codes
    for(const r of d.hsn_codes||[]){
      try{await pool.query(`INSERT INTO hsn_codes (id,user_id,code,description,gst_rate,uom,chapter,is_service) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [r.id,uid,r.code,r.description||"",r.gst_rate||0,r.uom||"NOS",r.chapter||"",r.is_service||false]);restored.hsn_codes++;}catch(e){}
    }
    // Restore accounting companies
    for(const r of (d.accounting?.companies)||[]){
      try{await pool.query(`INSERT INTO companies (id,user_id,name,legal_name,gstin,pan,address,city,state,pincode,phone,email,fy_start,fy_end) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO NOTHING`,
        [r.id,uid,r.name,r.legal_name||null,r.gstin||null,r.pan||null,r.address||null,r.city||null,r.state||null,r.pincode||null,r.phone||null,r.email||null,r.fy_start||"2024-04-01",r.fy_end||"2025-03-31"]);restored.companies++;}catch(e){}
    }
    // Restore ledger groups
    for(const r of (d.accounting?.ledger_groups)||[]){
      try{await pool.query(`INSERT INTO ledger_groups (id,user_id,company_id,name,nature,affects_gross,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [r.id,uid,r.company_id,r.name,r.nature||"Asset",r.affects_gross||false,r.is_default||false]);restored.ledger_groups++;}catch(e){}
    }
    // Restore ledgers
    for(const r of (d.accounting?.ledgers)||[]){
      try{await pool.query(`INSERT INTO ledgers (id,user_id,company_id,group_id,name,opening_balance,opening_type,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [r.id,uid,r.company_id,r.group_id,r.name,r.opening_balance||0,r.opening_type||"Dr",r.is_default||false]);restored.ledgers++;}catch(e){}
    }
    // Restore vouchers
    for(const r of (d.accounting?.vouchers)||[]){
      try{await pool.query(`INSERT INTO vouchers (id,user_id,company_id,voucher_no,voucher_type,date,narration,party_name,total_amount,is_cancelled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [r.id,uid,r.company_id,r.voucher_no,r.voucher_type,r.date,r.narration||null,r.party_name||null,r.total_amount||0,r.is_cancelled||false]);restored.vouchers++;}catch(e){}
    }
    // Restore voucher items
    for(const r of (d.accounting?.voucher_items)||[]){
      try{await pool.query(`INSERT INTO voucher_items (id,voucher_id,ledger_id,ledger_name,dr_amount,cr_amount,narration,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [r.id,r.voucher_id,r.ledger_id,r.ledger_name||"",r.dr_amount||0,r.cr_amount||0,r.narration||null,r.sort_order||0]);restored.voucher_items++;}catch(e){}
    }

    const total=Object.values(restored).reduce((a,v)=>a+v,0);
    res.json({success:true,message:`✅ Restore complete! ${total} records restored.`,restored});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.use((req,res)=>res.status(404).json({success:false,message:`Route ${req.method} ${req.url} not found`}));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({success:false,message:process.env.NODE_ENV==="production"?"Server error":err.message});});
app.listen(PORT,()=>{
  console.log(`\n🚀 TaxPro Complete v4.0 on port ${PORT}`);
  console.log(`🗄️  Database: PostgreSQL`);
  console.log(`\n📌 Routes: Auth | Clients | Notices | Returns | Reconciliation`);
  console.log(`   Products | Invoices | Parties | Bank | Reports | GSTR-2A`);
  console.log(`   AI | Challans | Staff | GSTIN`);
  console.log(`   Accounting: Companies | Groups | Ledgers | Vouchers`);
  console.log(`   Reports: Trial Balance | P&L | Balance Sheet | Day Book | Cash Book\n`);
});
module.exports=app;