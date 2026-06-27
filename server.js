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

// CORS: defaults to "*" so existing deployments keep working out of the box.
// To lock down to your real frontend domain(s), set ALLOWED_ORIGINS env var
// (comma-separated, e.g. "https://taxpro-frontend-six.vercel.app,https://yourdomain.com")
const _allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map(s=>s.trim()) : null;
app.use(cors({
  origin: _allowedOrigins ? (origin,cb)=>{ if(!origin||_allowedOrigins.includes(origin))cb(null,true); else cb(new Error("Not allowed by CORS")); } : "*",
  methods:["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allowedHeaders:["Content-Type","Authorization"]
}));
app.use(securityHeaders);
app.use(morgan("combined"));
app.use(express.json({ limit:"10mb" }));
app.use(express.urlencoded({ extended:true }));
const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:50*1024*1024 } });

const auth = async (req, res, next) => {
  const h = req.headers.authorization;
  // File-download links opened via window.open() can't set custom headers, so they
  // pass the token as ?token=... instead — accepted ONLY when no Authorization header is present.
  let token = null;
  if (h) {
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success:false, message:"Invalid token format. Please login." });
    token = h.split(" ")[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }
  if (!token) return res.status(401).json({ success:false, message:"No token. Please login." });
  if (token === "null" || token === "undefined") return res.status(401).json({ success:false, message:"Empty token. Please login again." });
  let payload;
  try { payload = jwt.verify(token, JWT); }
  catch(e) {
    if (e.name === "TokenExpiredError") return res.status(401).json({ success:false, message:"Session expired. Please logout and login again." });
    return res.status(401).json({ success:false, message:"Invalid token. Please logout and login again." });
  }
  req.user = payload;
  // Session revocation check — only applies to tokens issued after this feature (have jti).
  // Fails OPEN on any DB hiccup so this never breaks normal logins.
  if (payload.jti) {
    try {
      const s = await pool.query("SELECT is_active FROM user_sessions WHERE id=$1", [payload.jti]);
      if (s.rows[0] && s.rows[0].is_active === false) {
        return res.status(401).json({ success:false, message:"This session was logged out remotely. Please login again." });
      }
    } catch (e) { /* table missing or transient DB error — don't block the user */ }
  }
  next();
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
app.post("/api/auth/register", rateLimiter({windowMs:60*60*1000,max:8,keyFn:req=>"reg:"+req.ip}), async (req,res)=>{
  try{
    const{name,email,password,firm_name,frn,phone}=req.body;
    if(!name||!email||!password||!firm_name) return res.status(400).json({success:false,message:"Name, email, password and firm name required"});
    if(password.length<8) return res.status(400).json({success:false,message:"Password must be at least 8 characters"});
    if(!/\d/.test(password)) return res.status(400).json({success:false,message:"Password must contain at least one number"});
    const exists=await pool.query("SELECT id FROM users WHERE email=$1",[email.toLowerCase().trim()]);
    if(exists.rows[0]) return res.status(409).json({success:false,message:"Email already registered. Please login."});
    const hashed=await bcrypt.hash(password,12);
    const id=uuid();
    await pool.query("INSERT INTO users (id,name,email,password,firm_name,frn,phone,role) VALUES ($1,$2,$3,$4,$5,$6,$7,'ca')",[id,name.trim(),email.toLowerCase().trim(),hashed,firm_name.trim(),frn||null,phone||null]);
    const userObj={id,name:name.trim(),email:email.toLowerCase().trim(),firm_name:firm_name.trim(),role:"ca"};
    const token=await issueSession(userObj,req);
    logAudit(id,"register","New account registered",req);
    res.status(201).json({success:true,token,user:userObj});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/auth/login", rateLimiter({windowMs:15*60*1000,max:10,keyFn:req=>"login:"+req.ip+":"+(req.body?.email||"")}), async (req,res)=>{
  try{
    const{email,password}=req.body;
    if(!email||!password) return res.status(400).json({success:false,message:"Email and password required"});
    const r=await pool.query("SELECT * FROM users WHERE email=$1",[email.toLowerCase().trim()]);
    const user=r.rows[0];
    if(!user){ logAudit(null,"login_failed","Unknown email: "+email,req); return res.status(401).json({success:false,message:"Invalid email or password"}); }

    if(user.is_suspended) return res.status(403).json({success:false,message:"This account has been suspended. Contact support."});
    if(user.locked_until && new Date(user.locked_until)>new Date()){
      const mins=Math.ceil((new Date(user.locked_until)-new Date())/60000);
      return res.status(423).json({success:false,message:`Too many failed attempts. Try again in ${mins} minute(s).`});
    }

    const match=await bcrypt.compare(password,user.password);
    if(!match){
      const attempts=(user.failed_login_attempts||0)+1;
      const lock=attempts>=5;
      await pool.query("UPDATE users SET failed_login_attempts=$1,locked_until=$2 WHERE id=$3",
        [attempts, lock?new Date(Date.now()+15*60*1000):null, user.id]);
      logAudit(user.id,"login_failed","Wrong password"+(lock?" — account locked 15 min":""),req);
      return res.status(401).json({success:false,message:lock?"Too many failed attempts. Account locked for 15 minutes.":"Invalid email or password"});
    }

    // ── 2FA: if enabled, send OTP to registered email + phone and require verification ──
    if(user.two_factor_enabled){
      // Check if email is configured — if not, skip 2FA gracefully (can't block login forever)
      const smtpConfigured=!!(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS);
      if(!smtpConfigured){
        // SMTP not set up — log this as a warning but allow login through
        logAudit(user.id,"login_2fa_skipped","SMTP not configured — 2FA bypassed",req);
        // Fall through to normal login below (do not return here)
      } else {
        const code=generateOTP();
        const otpId=uuid();
        await pool.query("INSERT INTO otp_codes (id,user_id,code,channel,purpose,expires_at) VALUES ($1,$2,$3,'both','login',NOW()+interval '10 minutes')",
          [otpId,user.id,code]);
        const tempToken=jwt.sign({uid:user.id,otp:otpId,purpose:"login_otp"},JWT,{expiresIn:"10m"});
        let emailSent=false,smsSent=false;
        try{ await sendEmail({to:user.email,subject:"TaxPro GST — Your Login OTP",html:`<p>Your login OTP is <b style="font-size:20px">${code}</b>. Valid for 10 minutes. Do not share this with anyone.</p>`}); emailSent=true; }catch(e){}
        if(user.phone){ try{ await sendSMS({to:user.phone,message:`Your TaxPro GST login OTP is ${code}. Valid 10 min. Do not share.`}); smsSent=true; }catch(e){} }
        if(emailSent||smsSent){
          logAudit(user.id,"login_otp_sent",`email:${emailSent} sms:${smsSent}`,req);
          return res.json({success:true,require_otp:true,otp_token:tempToken,sent_to:{email:emailSent?user.email.replace(/(.{2}).+(@.+)/,"$1***$2"):null,phone:smsSent?user.phone.replace(/.(?=.{2})/g,"*"):null}});
        }
        // OTP send failed — fall through to direct login (don't block user)
        logAudit(user.id,"login_otp_send_failed","OTP send failed — allowing direct login",req);
      }
    }

    const userObj={id:user.id,name:user.name,email:user.email,firm_name:user.firm_name,role:user.role};
    const token=await issueSession(userObj,req);
    logAudit(user.id,"login_success",null,req);
    res.json({success:true,token,user:{...userObj,frn:user.frn}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Verify login OTP (completes 2FA login) ──
app.post("/api/auth/verify-login-otp", rateLimiter({windowMs:15*60*1000,max:15,keyFn:req=>"otpverify:"+req.ip}), async (req,res)=>{
  try{
    const{otp_token,code}=req.body;
    if(!otp_token||!code)return res.status(400).json({success:false,message:"OTP token and code required"});
    let payload;
    try{ payload=jwt.verify(otp_token,JWT); }catch(e){ return res.status(401).json({success:false,message:"OTP session expired. Please login again."}); }
    if(payload.purpose!=="login_otp")return res.status(400).json({success:false,message:"Invalid OTP session"});
    const otpRow=await pool.query("SELECT * FROM otp_codes WHERE id=$1 AND user_id=$2",[payload.otp,payload.uid]);
    const otp=otpRow.rows[0];
    if(!otp)return res.status(400).json({success:false,message:"OTP not found"});
    if(otp.verified_at)return res.status(400).json({success:false,message:"OTP already used"});
    if(new Date(otp.expires_at)<new Date())return res.status(400).json({success:false,message:"OTP expired. Please login again."});
    if(otp.attempts>=5)return res.status(429).json({success:false,message:"Too many wrong attempts. Please login again."});
    if(otp.code!==String(code).trim()){
      await pool.query("UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1",[otp.id]);
      return res.status(401).json({success:false,message:"Incorrect OTP"});
    }
    await pool.query("UPDATE otp_codes SET verified_at=NOW() WHERE id=$1",[otp.id]);
    const userRow=await pool.query("SELECT * FROM users WHERE id=$1",[payload.uid]);
    const user=userRow.rows[0];
    if(!user)return res.status(404).json({success:false,message:"User not found"});
    const userObj={id:user.id,name:user.name,email:user.email,firm_name:user.firm_name,role:user.role};
    const token=await issueSession(userObj,req);
    logAudit(user.id,"login_otp_verified",null,req);
    res.json({success:true,token,user:{...userObj,frn:user.frn}});
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
  try{const{search,status,company_id}=req.query;let q="SELECT c.*,(SELECT COUNT(*) FROM notices n WHERE n.client_id=c.id AND n.status NOT IN ('closed','replied')) as notice_count FROM clients c WHERE c.user_id=$1";const p=[req.user.id];if(company_id){q+=` AND c.company_id=$${p.length+1}`;p.push(company_id);}if(search){q+=` AND (c.name ILIKE $${p.length+1} OR c.gstin ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}if(status){q+=` AND c.status=$${p.length+1}`;p.push(status);}q+=" ORDER BY c.name ASC";const r=await pool.query(q,p);res.json({success:true,clients:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/clients",auth,async(req,res)=>{
  try{const{name,gstin,state,type,turnover,notes,phone,email,address,city,pincode,pan}=req.body;if(!name)return res.status(400).json({success:false,message:"Name required"});const id=uuid();await pool.query("INSERT INTO clients (id,user_id,name,gstin,state,type,turnover,notes,phone,email,address,city,pincode,pan,company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",[id,req.user.id,name,gstin?.toUpperCase()||null,state||null,type||"Trader",turnover||null,notes||null,phone||null,email||null,address||null,city||null,pincode||null,pan||null,company_id||null]);const r=await pool.query("SELECT * FROM clients WHERE id=$1",[id]);res.status(201).json({success:true,message:"Client added",client:r.rows[0]});}catch(e){res.status(500).json({success:false,message:e.message});}
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
  try{const{search,company_id}=req.query;let q="SELECT * FROM products WHERE user_id=$1";const p=[req.user.id];if(company_id){q+=` AND company_id=$${p.length+1}`;p.push(company_id);}if(search){q+=` AND (name ILIKE $${p.length+1} OR code ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}q+=" ORDER BY name ASC";const r=await pool.query(q,p);res.json({success:true,products:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/products",auth,async(req,res)=>{
  try{const{name,code,hsn_sac,unit,category,gst_rate,purchase_price,sale_price,stock_qty,min_stock,description,is_service,company_id}=req.body;if(!name)return res.status(400).json({success:false,message:"Name required"});const id=uuid();await pool.query("INSERT INTO products (id,user_id,name,code,hsn_sac,unit,category,gst_rate,purchase_price,sale_price,stock_qty,min_stock,description,is_service,company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",[id,req.user.id,name,code||null,hsn_sac||null,unit||"PCS",category||null,parseFloat(gst_rate)||18,parseFloat(purchase_price)||0,parseFloat(sale_price)||0,parseFloat(stock_qty)||0,parseFloat(min_stock)||0,description||null,is_service===true||is_service==='true'?1:0,company_id||null]);if(parseFloat(stock_qty)>0)await pool.query("INSERT INTO stock_movements (id,user_id,product_id,type,qty,rate,reference,notes) VALUES ($1,$2,$3,'OPENING',$4,$5,'Opening Stock','Opening stock')",[uuid(),req.user.id,id,parseFloat(stock_qty),parseFloat(purchase_price)||0]);const r=await pool.query("SELECT * FROM products WHERE id=$1",[id]);res.status(201).json({success:true,message:"Product added",product:r.rows[0]});}catch(e){res.status(500).json({success:false,message:e.message});}
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
  try{const{type,status,search,company_id}=req.query;let q="SELECT * FROM invoices WHERE user_id=$1";const p=[req.user.id];if(company_id){q+=` AND company_id=$${p.length+1}`;p.push(company_id);}else{/* no filter - show all */}if(type){q+=` AND invoice_type=$${p.length+1}`;p.push(type);}if(status){q+=` AND status=$${p.length+1}`;p.push(status);}if(search){q+=` AND (party_name ILIKE $${p.length+1} OR invoice_no ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}q+=" ORDER BY created_at DESC";const r=await pool.query(q,p);const invs=r.rows;res.json({success:true,count:invs.length,invoices:invs,summary:{total_amount:invs.reduce((a,i)=>a+parseFloat(i.total_amount||0),0),total_outstanding:invs.reduce((a,i)=>a+parseFloat(i.balance_due||0),0)}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/invoices/:id",auth,async(req,res)=>{
  try{const inv=await pool.query("SELECT * FROM invoices WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);if(!inv.rows[0])return res.status(404).json({success:false,message:"Not found"});const items=await pool.query("SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY id",[req.params.id]);const pays=await pool.query("SELECT * FROM payments WHERE invoice_id=$1 ORDER BY payment_date DESC",[req.params.id]);res.json({success:true,invoice:{...inv.rows[0],items:items.rows,payments:pays.rows}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/invoices",auth,async(req,res)=>{
  try{
    const{invoice_type,party_id,party_name,party_gstin,party_address,party_state,invoice_date,due_date,place_of_supply,is_igst,notes,terms,items=[],company_id}=req.body;
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
    await pool.query("INSERT INTO invoices (id,user_id,invoice_no,invoice_type,party_id,party_name,party_gstin,party_address,party_state,invoice_date,due_date,place_of_supply,is_igst,subtotal,taxable_amount,igst_amount,cgst_amount,sgst_amount,total_tax,total_amount,paid_amount,balance_due,status,notes,terms,company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)",
      [id,req.user.id,invoice_no,invoice_type||"SALES",party_id||null,party_name,party_gstin||null,party_address||null,party_state||null,invoice_date,due_date||null,place_of_supply||null,is_igst||false,subtotal,subtotal,totalIGST,totalCGST,totalSGST,totalTax,totalAmount,0,totalAmount,"unpaid",notes||null,terms||null,company_id||null]);
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
  try{const{search,company_id}=req.query;let q="SELECT c.*,COALESCE((SELECT SUM(balance_due) FROM invoices WHERE party_id=c.id AND status IN ('unpaid','partial')),0) as outstanding FROM clients c WHERE c.user_id=$1";const p=[req.user.id];if(company_id){q+=` AND c.company_id=$${p.length+1}`;p.push(company_id);}if(search){q+=` AND (c.name ILIKE $${p.length+1} OR c.gstin ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}q+=" ORDER BY c.name ASC";const r=await pool.query(q,p);res.json({success:true,parties:r.rows});}catch(e){res.status(500).json({success:false,message:e.message});}
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
  try{const{from_date,to_date,company_id}=req.query;let q="SELECT * FROM invoices WHERE user_id=$1 AND invoice_type='SALES'";const p=[req.user.id];if(company_id){q+=` AND (company_id=$${p.length+1} OR company_id IS NULL)`;p.push(company_id);}if(from_date){q+=` AND invoice_date>=$${p.length+1}`;p.push(from_date);}if(to_date){q+=` AND invoice_date<=$${p.length+1}`;p.push(to_date);}q+=" ORDER BY invoice_date ASC";const r=await pool.query(q,p);const invs=r.rows;res.json({success:true,invoices:invs,summary:{total_invoices:invs.length,total_taxable:invs.reduce((a,i)=>a+parseFloat(i.taxable_amount||0),0),total_igst:invs.reduce((a,i)=>a+parseFloat(i.igst_amount||0),0),total_cgst:invs.reduce((a,i)=>a+parseFloat(i.cgst_amount||0),0),total_sgst:invs.reduce((a,i)=>a+parseFloat(i.sgst_amount||0),0),total_amount:invs.reduce((a,i)=>a+parseFloat(i.total_amount||0),0)}});}catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/reports/purchase-register",auth,async(req,res)=>{
  try{const{from_date,to_date,company_id}=req.query;let q="SELECT * FROM invoices WHERE user_id=$1 AND invoice_type='PURCHASE'";const p=[req.user.id];if(company_id){q+=` AND (company_id=$${p.length+1} OR company_id IS NULL)`;p.push(company_id);}if(from_date){q+=` AND invoice_date>=$${p.length+1}`;p.push(from_date);}if(to_date){q+=` AND invoice_date<=$${p.length+1}`;p.push(to_date);}q+=" ORDER BY invoice_date ASC";const r=await pool.query(q,p);const invs=r.rows;res.json({success:true,invoices:invs,summary:{total_invoices:invs.length,total_taxable:invs.reduce((a,i)=>a+parseFloat(i.taxable_amount||0),0),total_amount:invs.reduce((a,i)=>a+parseFloat(i.total_amount||0),0)}});}catch(e){res.status(500).json({success:false,message:e.message});}
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


// ══ BANK STATEMENT PARSER v2 (HDFC + All Banks) ══
function parseDate(raw){
  if(!raw)return null;
  raw=String(raw).trim();
  // DD/MM/YY or DD/MM/YYYY
  let m=raw.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if(m){
    const[,d,mo,y]=m;
    const yr=y.length===2?(parseInt(y)>50?`19${y}`:`20${y}`):y;
    return`${yr}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  // DD Mon YYYY
  m=raw.match(/^(\d{1,2})\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-,]*(\d{2,4})$/i);
  if(m){
    const months={jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
    const[,d,mo,y]=m;
    const yr=y.length===2?`20${y}`:y;
    return`${yr}-${months[mo.toLowerCase().substring(0,3)]}-${d.padStart(2,'0')}`;
  }
  return null;
}

function parseAmt(s){
  if(!s||s===''||s==='-'||s==='NIL')return 0;
  const n=parseFloat(String(s).replace(/,/g,'').replace(/[^\d.]/g,''));
  return isNaN(n)?0:n;
}

function isDateStr(s){
  return /^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(s.trim())||
         /^\d{1,2}\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(s.trim());
}

function isRefNo(s){
  // Reference numbers: long digit strings 10+ chars, or alphanumeric 15+ chars
  return /^\d{10,}$/.test(s.trim())||/^[A-Z0-9]{12,}$/.test(s.trim());
}

function categorize(desc){
  const d=desc.toUpperCase();
  if(/(SALARY|SAL\/|PAYROLL|PAY-ROLL)/.test(d))return{c:"Salary",t:"INCOME"};
  if(/(RENT|LEASE|HOUSE RENT)/.test(d))return{c:"Rent",t:"EXPENSE"};
  if(/(ELECTRICITY|ELEC|POWER|BESCOM|MSEDCL|TSSPDCL|WESCO)/.test(d))return{c:"Utilities",t:"EXPENSE"};
  if(/(INTERNET|BROADBAND|AIRTEL|JIOFIBER|BSNL)/.test(d))return{c:"Utilities",t:"EXPENSE"};
  if(/(GST|TAX PMT|INCOME TAX|TDS|SERVICE TAX)/.test(d))return{c:"Tax Payment",t:"TAX"};
  if(/(EMI|LOAN|MORTGAGE|HOME LOAN|CAR LOAN)/.test(d))return{c:"Loan Payment",t:"EXPENSE"};
  if(/(INSURANCE|LIC|LIFE INS|HDFC LIFE)/.test(d))return{c:"Insurance",t:"EXPENSE"};
  if(/(ATM|CASH WD|CASH W\/D|ATM WDL)/.test(d))return{c:"Cash Withdrawal",t:"EXPENSE"};
  if(/(NEFT|RTGS|IMPS|FT-|FUND TRANSFER)/.test(d))return{c:"Fund Transfer",t:"TRANSFER"};
  if(/(UPI|PHONEPE|GPAY|PAYTM|BHIM)/.test(d)){
    if(/(PAYMENT FROM|RECEIVED|CR|DEPOSIT)/.test(d))return{c:"UPI Receipt",t:"INCOME"};
    return{c:"UPI Payment",t:"EXPENSE"};
  }
  if(/(PURCHASE|POS|MERCHANT|AMAZON|FLIPKART|SWIGGY|ZOMATO)/.test(d))return{c:"Online Purchase",t:"EXPENSE"};
  if(/(DIVIDEND|DIV |INTEREST|INT CR|MATURITY)/.test(d))return{c:"Interest/Dividend",t:"INCOME"};
  if(/(REFUND|REVERSAL|REF-)/.test(d))return{c:"Refund",t:"INCOME"};
  if(/(CHEQUE|CHQ|CMS)/.test(d))return{c:"Cheque",t:"TRANSFER"};
  if(/(CASH DEP|CASH DEPOSIT|DEP-CASH)/.test(d))return{c:"Cash Deposit",t:"INCOME"};
  return{c:"Uncategorized",t:"UNKNOWN"};
}

// ══ BANK STATEMENT PARSER v3 — Balance Comparison Method ══
function toISO(raw){
  if(!raw)return null;
  const s=String(raw).trim();
  // DD/MM/YY
  let m=s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if(m){const[,d,mo,y]=m;const yr=y.length===2?(parseInt(y)>=0&&parseInt(y)<=30?`20${y}`:`19${y}`):y;const r=`${yr}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;return new Date(r).toString()==='Invalid Date'?null:r;}
  // YYYY/MM/DD
  m=s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if(m){const[,y,mo,d]=m;return`${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;}
  // DD Mon YYYY
  m=s.match(/^(\d{1,2})\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-,]*(\d{2,4})$/i);
  if(m){const mn={jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};const[,d,mo,y]=m;const yr=y.length===2?`20${y}`:y;return`${yr}-${mn[mo.toLowerCase().substring(0,3)]}-${d.padStart(2,'0')}`;}
  return null;
}

function extractAmounts(text){
  // ONLY match amounts with decimal points (bank statement amounts always have .00 or .XX)
  // This avoids picking up reference numbers, dates etc.
  const pattern=/\b(\d{1,3}(?:,\d{2,3})*\.\d{2})\b/g;
  const results=[];
  let m;
  while((m=pattern.exec(text))!==null){
    const val=parseFloat(m[1].replace(/,/g,''));
    if(val>0&&val<99999999)results.push({val,pos:m.index,str:m[1]});
  }
  return results;
}

function isRef(s){return /^\d{10,}$/.test(s.trim());}

function getCategory(desc,isCr){
  const u=desc.toUpperCase();
  if(/(SALARY|SAL\/|PAYROLL)/.test(u))return{c:"Salary",t:"INCOME"};
  if(/(UPI|PHONEPE|GPAY|PAYTM|BHIM)/.test(u))return isCr?{c:"UPI Receipt",t:"INCOME"}:{c:"UPI Payment",t:"EXPENSE"};
  if(/(NEFT|RTGS|IMPS|FT-)/.test(u))return{c:"Fund Transfer",t:"TRANSFER"};
  if(/(ATM|CASH WD|ATM WDL)/.test(u))return{c:"Cash",t:"EXPENSE"};
  if(/(GST|TDS|INCOME TAX|TAX PMT)/.test(u))return{c:"Tax Payment",t:"TAX"};
  if(/(EMI|LOAN|MORTGAGE)/.test(u))return{c:"Loan Payment",t:"EXPENSE"};
  if(/(INTEREST|INT CR|DIVIDEND)/.test(u))return{c:"Interest",t:"INCOME"};
  if(/(REFUND|REVERSAL|CASHBACK)/.test(u))return{c:"Refund",t:"INCOME"};
  if(/(INSURANCE|LIC)/.test(u))return{c:"Insurance",t:"EXPENSE"};
  if(/(RENT|LEASE)/.test(u))return{c:"Rent",t:"EXPENSE"};
  return isCr?{c:"Receipt",t:"INCOME"}:{c:"Payment",t:"EXPENSE"};
}

function parseTransactions(rawText){
  const lines=rawText.split('\n').map(l=>l.trim()).filter(l=>l.length>2);
  const DATE_RE=/^\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\s/;
  const transactions=[];

  // ── STEP 1: Group lines by transaction date ──
  const groups=[];
  let cur=null;
  for(const line of lines){
    const dm=line.match(DATE_RE);
    const d=dm?toISO(dm[1].trim()):null;
    if(d){
      if(cur)groups.push(cur);
      cur={date:d,lines:[line]};
    }else if(cur){
      // Skip lines that are just reference continuation
      if(line.length>3)cur.lines.push(line);
    }
  }
  if(cur)groups.push(cur);

  if(groups.length===0)return[];

  // ── STEP 2: Parse each group using BALANCE COMPARISON ──
  let prevBalance=null;

  for(const grp of groups){
    const full=grp.lines.join(' ');

    // Extract all amounts from the full transaction text
    const allAmts=extractAmounts(full);
    // Filter out ref numbers and date-like numbers
    const dateNums=new Set();
    const dateMatches=[...full.matchAll(/\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/g)];
    dateMatches.forEach(m=>{
      dateNums.add(parseFloat(m[1]));dateNums.add(parseFloat(m[2]));dateNums.add(parseFloat(m[3]));
    });

    // Filter: remove tiny numbers (≤31 could be dates), remove very precise matches to date parts
    const txnAmts=allAmts.filter(a=>{
      if(a.val<0.01)return false;
      // Skip if it looks like a date component (no decimal, ≤31 or ≤12 or ≤99)
      if(!a.str.includes('.')&&a.val<=9999&&a.val==Math.floor(a.val)){
        // Could be year like 2026 - skip
        if(a.val>=2020&&a.val<=2099)return false;
      }
      return true;
    });

    if(txnAmts.length===0)continue;

    // Closing balance is the LAST decimal amount on the line
    // Transaction amounts are everything before the last (or last two: withdrawal + deposit)
    const closingBal=txnAmts[txnAmts.length-1].val;

    // Build narration: remove all amounts, refs, dates from text
    let narration=full;
    // Remove date patterns
    narration=narration.replace(/\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/g,'');
    // Remove ref numbers (10+ digits)
    narration=narration.replace(/\b\d{10,}\b/g,'');
    // Remove amounts (comma-formatted)
    narration=narration.replace(/\b\d{1,3}(?:,\d{2,3})*\.\d{2}\b/g,'');
    // Clean up
    narration=narration.replace(/\s+/g,' ').trim();
    // Remove leading/trailing special chars
    narration=narration.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9.]+$/g,'').trim();
    if(!narration||narration.length<2)narration='Bank Transaction';

    // ── KEY: Use balance comparison to determine debit/credit ──
    let debit=0,credit=0,txnAmt=0;

    if(prevBalance!==null){
      const diff=Math.round((closingBal-prevBalance)*100)/100;
      if(diff>0){
        // Balance increased → Credit (Deposit)
        credit=Math.round(diff*100)/100;
        txnAmt=credit;
      }else if(diff<0){
        // Balance decreased → Debit (Withdrawal)
        debit=Math.round(Math.abs(diff)*100)/100;
        txnAmt=debit;
      }
    }

    // Fallback: if balance comparison fails, use amount from statement
    if(txnAmt===0){
      const upper=full.toUpperCase();
      // Enhanced keyword detection including UPI patterns
      const isCr=/(PAYMENT FROM|CREDIT|DEPOSIT|RECEIVED|NEFT CR|UPI CR|IMPS CR|BY |CASH DEP|INT CR|CASHBACK|REFUND|SALARY|DIVIDEND|@\w+BANK|@SBI|@HDFC|@ICICI|@AXIS|@YES|@KOTAK|@PNB|@OKSBI|@YESB|@UTIB|@BKID)/.test(upper);
      const isDr=/(WITHDRAWAL|DEBIT|PAID|ATM|NEFT DR|UPI DR|IMPS DR|EMI|LOAN|PURCHASE|WDL|TRANSFER DR|CHARGES|FEE|ANNUAL FEE)/.test(upper);

      if(txnAmts.length>=3){
        const a1=txnAmts[txnAmts.length-3].val;
        const a2=txnAmts[txnAmts.length-2].val;
        if(isCr&&!isDr){credit=Math.min(a1,a2)||a1;txnAmt=credit;}
        else if(isDr&&!isCr){debit=Math.min(a1,a2)||a1;txnAmt=debit;}
        else{debit=Math.min(a1,a2)||a1;txnAmt=debit;}
      }else if(txnAmts.length===2){
        txnAmt=txnAmts[0].val;
        if(isCr&&!isDr)credit=txnAmt;else debit=txnAmt;
      }else if(txnAmts.length===1){
        txnAmt=txnAmts[0].val;
        if(isCr&&!isDr)credit=txnAmt;else debit=txnAmt;
      }
    }

    if(debit===0&&credit===0){
      prevBalance=closingBal;
      continue;
    }

    // Determine category
    const isCr=credit>0;
    const{c:category,t:type}=getCategory(narration,isCr);

    // Check for suspense (can't determine counterparty)
    const hasSuspense=narration==='Bank Transaction'||(!/(UPI|NEFT|RTGS|IMPS|ATM|EMI|INT|SAL|RENT|TAX|LOAN)/.test(narration.toUpperCase()));

    transactions.push({
      txn_date:grp.date,
      description:narration.substring(0,500),
      narration:narration.substring(0,500),
      debit:Math.round((debit||0)*100)/100,
      credit:Math.round((credit||0)*100)/100,
      balance:Math.round(closingBal*100)/100,
      category,type,
      is_suspense:false,
    });

    prevBalance=closingBal;
  }

  // Sort by date
  transactions.sort((a,b)=>new Date(a.txn_date)-new Date(b.txn_date));
  return transactions;
}


app.post("/api/bank/upload",auth,upload.single("file"),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({success:false,message:"PDF required"});
    let text="";
    try{const pp=require("pdf-parse");const data=await pp(req.file.buffer);text=data.text;}
    catch(e){return res.status(400).json({success:false,message:"Cannot read PDF. Use a digital (not scanned) PDF."});}
    if(!text||text.length<50)return res.status(400).json({success:false,message:"No text found in PDF. Use a selectable-text PDF."});

    let transactions=parseTransactions(text);

    // AI fallback when regex parser fails
    if(transactions.length===0&&process.env.GROQ_API_KEY){
      try{
        const sample=text.substring(0,3000);
        const reply=await groqChat({
          model:"llama-3.1-8b-instant",
          messages:[{role:"user",content:`Extract bank transactions from this bank statement text. Return ONLY a JSON array like:
[{"date":"YYYY-MM-DD","description":"narration text","debit":0,"credit":0,"balance":0}]
Rules: 1) date must be YYYY-MM-DD format 2) debit=withdrawal/payment 3) credit=deposit/receipt 4) omit header/footer rows 5) balance is closing balance after txn.
Bank Statement Text:
${sample}`}],
          temperature:0.1,max_tokens:2000
        });
        const jsonMatch=reply.match(/\[[\s\S]*\]/);
        if(jsonMatch){
          const aiTxns=JSON.parse(jsonMatch[0]);
          if(Array.isArray(aiTxns)&&aiTxns.length>0){
            transactions=aiTxns.map(t=>({
              txn_date:t.date,description:t.description||"Bank Transaction",
              narration:t.description||"Bank Transaction",
              debit:parseFloat(t.debit)||0,credit:parseFloat(t.credit)||0,
              balance:parseFloat(t.balance)||0,
              category:parseFloat(t.credit)>0?"Receipt":"Payment",
              type:parseFloat(t.credit)>0?"INCOME":"EXPENSE"
            }));
          }
        }
      }catch(aiErr){console.error("AI parse failed:",aiErr.message);}
    }

    if(transactions.length===0){
      // Return extracted text for debugging
      return res.status(400).json({
        success:false,
        message:"No transactions found. The PDF may be scanned/image-based or use an unsupported format.",
        debug_text:text.substring(0,500)
      });
    }

    const td=transactions.reduce((a,t)=>a+(t.debit||0),0);
    const tc=transactions.reduce((a,t)=>a+(t.credit||0),0);
    const suspenseCount=transactions.filter(t=>t.category==="Suspense").length;

    // Auto-detect bank name from PDF text
    let detectedBank=req.body.bank_name||"";
    if(!detectedBank){
      if(/HDFC BANK/i.test(text))detectedBank="HDFC Bank";
      else if(/STATE BANK|SBI/i.test(text))detectedBank="SBI";
      else if(/ICICI BANK/i.test(text))detectedBank="ICICI Bank";
      else if(/AXIS BANK/i.test(text))detectedBank="Axis Bank";
      else if(/KOTAK/i.test(text))detectedBank="Kotak Bank";
      else if(/PUNJAB NATIONAL|PNB/i.test(text))detectedBank="PNB";
      else if(/BANK OF BARODA/i.test(text))detectedBank="Bank of Baroda";
      else detectedBank="Unknown Bank";
    }
    res.json({success:true,
      message:`Found ${transactions.length} transactions`,
      preview:{
        bank_name:detectedBank,
        account_no:req.body.account_no||"",
        total_txns:transactions.length,
        total_debit:td,total_credit:tc,
        transactions
      }
    });
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/bank/import",auth,async(req,res)=>{
  try{
    const{bank_name,account_no,transactions,company_id,create_vouchers}=req.body;
    if(!transactions||transactions.length===0)return res.status(400).json({success:false,message:"No transactions"});
    const uid=req.user.id;
    const importId=uuid();
    const td=transactions.reduce((a,t)=>a+(t.debit||0),0);
    const tc=transactions.reduce((a,t)=>a+(t.credit||0),0);

    await pool.query("INSERT INTO bank_imports (id,user_id,bank_name,account_no,total_txns,total_debit,total_credit,filename,company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [importId,uid,bank_name||"Unknown",account_no||"",transactions.length,td,tc,`statement_${Date.now()}.pdf`,company_id||null]);

    let voucherCount=0;
    let suspenseLedgerId=null;
    let bankLedgerId=null;

    // If company provided and create_vouchers=true, auto-create vouchers
    if(company_id && create_vouchers!==false){
      // Find or create Bank ledger
      const bankLedger=await pool.query(
        "SELECT id FROM ledgers WHERE company_id=$1 AND user_id=$2 AND name ILIKE $3 LIMIT 1",
        [company_id,uid,`%${bank_name||'Bank'}%`]
      );
      if(bankLedger.rows[0]){bankLedgerId=bankLedger.rows[0].id;}
      else{
        // Find Bank Accounts group
        const bankGrp=await pool.query("SELECT id FROM ledger_groups WHERE company_id=$1 AND user_id=$2 AND name='Bank Accounts' LIMIT 1",[company_id,uid]);
        if(bankGrp.rows[0]){
          bankLedgerId=uuid();
          await pool.query("INSERT INTO ledgers (id,user_id,company_id,group_id,name,opening_balance,opening_type) VALUES ($1,$2,$3,$4,$5,0,'Dr')",
            [bankLedgerId,uid,company_id,bankGrp.rows[0].id,bank_name||"Bank Account"]);
        }
      }

      // Find or create Suspense ledger
      const suspLedger=await pool.query(
        "SELECT id FROM ledgers WHERE company_id=$1 AND user_id=$2 AND name='Suspense Account' LIMIT 1",
        [company_id,uid]
      );
      if(suspLedger.rows[0]){suspenseLedgerId=suspLedger.rows[0].id;}
      else{
        const suspGrp=await pool.query("SELECT id FROM ledger_groups WHERE company_id=$1 AND user_id=$2 AND (name='Current Liabilities' OR name='Suspense') LIMIT 1",[company_id,uid]);
        if(suspGrp.rows[0]){
          suspenseLedgerId=uuid();
          await pool.query("INSERT INTO ledgers (id,user_id,company_id,group_id,name,opening_balance,opening_type) VALUES ($1,$2,$3,$4,$5,0,'Cr')",
            [suspenseLedgerId,uid,company_id,suspGrp.rows[0].id,"Suspense Account"]);
        }
      }
    }

    // Insert transactions + create vouchers
    for(const t of transactions){
      const txnId=uuid();
      await pool.query(
        "INSERT INTO bank_transactions (id,user_id,bank_name,account_no,txn_date,description,debit,credit,balance,category,type,import_id,company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [txnId,uid,bank_name||"Unknown",account_no||"",t.txn_date,t.description||"Bank Transaction",t.debit||0,t.credit||0,t.balance||0,t.category||"Uncategorized",t.type||"UNKNOWN",importId,company_id||null]);

      // Auto-create voucher if company selected
      if(company_id && bankLedgerId && suspenseLedgerId && (t.debit>0||t.credit>0)){
        try{
          const vtype=t.credit>0?"RECEIPT":"PAYMENT";
          const amount=t.credit>0?t.credit:t.debit;
          const vNo=`BNK-${Date.now()}-${Math.floor(Math.random()*1000)}`;
          const narration=t.description||t.narration||"Bank Statement Import";
          const vId=uuid();

          await pool.query(
            "INSERT INTO vouchers (id,user_id,company_id,voucher_no,voucher_type,date,narration,total_amount,ref_no) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [vId,uid,company_id,vNo,vtype,t.txn_date,narration,amount,txnId]);

          if(t.credit>0){
            // RECEIPT: Debit Bank A/c, Credit Suspense (unknown source)
            await pool.query("INSERT INTO voucher_items (id,voucher_id,ledger_id,ledger_name,dr_amount,cr_amount,narration,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
              [uuid(),vId,bankLedgerId,bank_name||"Bank Account",amount,0,narration,1]);
            await pool.query("INSERT INTO voucher_items (id,voucher_id,ledger_id,ledger_name,dr_amount,cr_amount,narration,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
              [uuid(),vId,suspenseLedgerId,"Suspense Account",0,amount,narration,2]);
          }else{
            // PAYMENT: Credit Bank A/c, Debit Suspense (unknown destination)
            await pool.query("INSERT INTO voucher_items (id,voucher_id,ledger_id,ledger_name,dr_amount,cr_amount,narration,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
              [uuid(),vId,suspenseLedgerId,"Suspense Account",amount,0,narration,1]);
            await pool.query("INSERT INTO voucher_items (id,voucher_id,ledger_id,ledger_name,dr_amount,cr_amount,narration,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
              [uuid(),vId,bankLedgerId,bank_name||"Bank Account",0,amount,narration,2]);
          }
          voucherCount++;
        }catch(ve){console.error("Voucher create error:",ve.message);}
      }
    }

    res.json({
      success:true,
      message:`${transactions.length} transactions imported! ${voucherCount>0?`${voucherCount} vouchers auto-created in accounting.`:""}`,
      import_id:importId,
      vouchers_created:voucherCount
    });
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/bank/transactions",auth,async(req,res)=>{
  try{
    const{type,from_date,to_date,company_id}=req.query;
    let q="SELECT * FROM bank_transactions WHERE user_id=$1";
    const p=[req.user.id];
    if(type&&type!=="all"){q+=` AND type=$${p.length+1}`;p.push(type);}
    if(from_date){q+=` AND txn_date>=$${p.length+1}`;p.push(from_date);}
    if(to_date){q+=` AND txn_date<=$${p.length+1}`;p.push(to_date);}
    if(company_id){q+=` AND (company_id=$${p.length+1} OR company_id IS NULL)`;p.push(company_id);}
    q+=" ORDER BY txn_date ASC, created_at ASC";
    const r=await pool.query(q,p);
    res.json({success:true,transactions:r.rows,count:r.rows.length});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// Delete single transaction
app.delete("/api/bank/transactions/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM bank_transactions WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// Delete all transactions for an import
app.delete("/api/bank/imports/:id",auth,async(req,res)=>{
  try{
    await pool.query("DELETE FROM bank_transactions WHERE import_id=$1 AND user_id=$2",[req.params.id,req.user.id]);
    await pool.query("DELETE FROM bank_imports WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);
    res.json({success:true,message:"Import deleted with all transactions"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// Delete ALL bank transactions (company-specific)
app.delete("/api/bank/transactions-all",auth,async(req,res)=>{
  try{
    const{company_id}=req.query;
    if(company_id){
      await pool.query("DELETE FROM bank_transactions WHERE user_id=$1 AND company_id=$2",[req.user.id,company_id]);
    }else{
      await pool.query("DELETE FROM bank_transactions WHERE user_id=$1",[req.user.id]);
      await pool.query("DELETE FROM bank_imports WHERE user_id=$1",[req.user.id]);
    }
    res.json({success:true,message:"All bank transactions cleared"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
})
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
  // GLOBAL library — every logged-in user can search it, but only an admin can edit it (see /hsn/upload below).
  try{
    const{q="",limit=10}=req.query;
    if(!q||q.length<2)return res.json({success:true,codes:[]});
    const r=await pool.query(
      `SELECT DISTINCT ON (code) code,description,gst_rate,uom,is_service
       FROM hsn_codes
       WHERE (code ILIKE $1 OR description ILIKE $2)
       ORDER BY code ASC LIMIT $3`,
      [`${q}%`,`%${q}%`,parseInt(limit)||10]
    );
    res.json({success:true,codes:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ HSN: GET ALL (paginated) ══
app.get("/api/hsn/codes",auth,async(req,res)=>{
  try{
    const{page=1,limit=50,search=""}=req.query;
    const offset=(parseInt(page)-1)*parseInt(limit);
    let q="SELECT * FROM hsn_codes WHERE 1=1";
    const p=[];
    if(search){q+=` AND (code ILIKE $${p.length+1} OR description ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}
    q+=` ORDER BY code ASC LIMIT $${p.length+1} OFFSET $${p.length+2}`;
    p.push(parseInt(limit),offset);
    const r=await pool.query(q,p);
    const countParams=search?[`%${search}%`,`%${search}%`]:[];
    const countQ=search?`SELECT COUNT(*) as c FROM hsn_codes WHERE code ILIKE $1 OR description ILIKE $2`:`SELECT COUNT(*) as c FROM hsn_codes`;
    const count=await pool.query(countQ,countParams);
    res.json({success:true,codes:r.rows,total:parseInt(count.rows[0].c),page:parseInt(page),limit:parseInt(limit)});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ HSN: UPLOAD EXCEL/CSV ══
// Admin-only: this is the ONE global HSN library every client searches against. Clients cannot edit it.
app.post("/api/hsn/upload",auth,requireAdmin,upload.single("file"),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({success:false,message:"File required"});
    const wb=XLSX.read(req.file.buffer,{type:"buffer"});
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});
    if(!rows.length)return res.status(400).json({success:false,message:"No data found in file"});

    // Auto-detect column names (handles various Excel formats)
    const sample=rows[0];
    const findKey=(options)=>Object.keys(sample).find(k=>options.includes(k.toLowerCase().trim()))||null;

    const codeKey  =findKey(["hsn code","hsn","code","hsn/sac","sac code","hsncode","hsnsac"]);
    const descKey  =findKey(["description","desc","item description","goods description","commodity","name","product","item","hsn description"]);
    const gstKey   =findKey(["gst rate","gst","rate","tax rate","gst%","rate%","cgst+sgst","igst","tax","gstrate"]);
    const uomKey   =findKey(["uom","unit","unit of measure","uqc","unit of measurement"]);

    if(!codeKey)return res.status(400).json({success:false,message:`HSN Code column not found. Found columns: ${Object.keys(sample).join(", ")}`});

    let imported=0,skipped=0,updated=0;
    const uid=req.user.id; // recorded as "uploaded_by" only — visibility is global, not filtered by this

    for(const row of rows){
      const code=String(row[codeKey]||"").trim().replace(/[^0-9]/g,"");
      if(!code||code.length<2){skipped++;continue;}
      const desc=descKey?String(row[descKey]||"").trim():"";
      const gstRaw=gstKey?String(row[gstKey]||"0").replace(/[^0-9.]/g,""):"0";
      const gst=parseFloat(gstRaw)||0;
      const uom=uomKey?String(row[uomKey]||"NOS").trim().toUpperCase():"NOS";
      const chapter=code.substring(0,2);
      const isSvc=gstKey&&String(row[gstKey]||"").toLowerCase().includes("service")?true:false;

      // Global upsert — matched by code only (not by who uploaded it), since this is one shared library.
      const existing=await pool.query("SELECT id FROM hsn_codes WHERE code=$1",[code]);
      if(existing.rows[0]){
        await pool.query("UPDATE hsn_codes SET description=$1,gst_rate=$2,uom=$3,chapter=$4,user_id=$5 WHERE id=$6",[desc||existing.rows[0].description,gst,uom,chapter,uid,existing.rows[0].id]);
        updated++;
      }else{
        await pool.query("INSERT INTO hsn_codes (id,user_id,code,description,gst_rate,uom,chapter,is_service) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",[uuid(),uid,code,desc,gst,uom,chapter,isSvc]);
        imported++;
      }
    }

    res.json({success:true,message:`✅ Done! ${imported} new HSN codes imported, ${updated} updated, ${skipped} skipped — now live for every client`,imported,updated,skipped,total:rows.length});
  }catch(e){res.status(500).json({success:false,message:"Upload failed: "+e.message});}
});

// ══ HSN: DELETE ALL ══
app.delete("/api/hsn/codes",auth,requireAdmin,async(req,res)=>{
  try{await pool.query("DELETE FROM hsn_codes");res.json({success:true,message:"All HSN codes deleted (global library cleared for everyone)"});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ HSN: GET SINGLE ══
app.get("/api/hsn/code/:code",auth,async(req,res)=>{
  try{const r=await pool.query("SELECT * FROM hsn_codes WHERE code=$1 LIMIT 1",[req.params.code]);res.json({success:true,code:r.rows[0]||null});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══ DATA BACKUP ══
app.get("/api/backup/export", auth, async(req,res)=>{
  try{
    const uid = req.user.id;
    const{company_id}=req.query;
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
    const{company_id}=req.query;
    const cFilter=company_id?` AND (company_id='${company_id}' OR company_id IS NULL)`:"";
    const tables=["clients","invoices","products","notices","returns","reconciliation","bank_transactions","vouchers","hsn_codes","payments","challans"];
    const stats={};
    for(const t of tables){
      try{
        const r=await pool.query(`SELECT COUNT(*) as c FROM ${t} WHERE user_id=$1${cFilter}`,[uid]);
        stats[t]=parseInt(r.rows[0].c);
      }catch(e){stats[t]=0;}
    }
    const total=Object.values(stats).reduce((a,v)=>a+v,0);
    res.json({success:true,stats,total_records:total,company_id:company_id||null});
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


// ══ BANK RECONCILIATION (Tally-style) ══
// Create table on startup
pool.query(`CREATE TABLE IF NOT EXISTS bank_reconciliation (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  company_id TEXT,
  txn_id TEXT,          -- bank_transaction id
  voucher_id TEXT,      -- matched voucher id
  txn_date DATE,
  value_date DATE,
  description TEXT,
  debit REAL DEFAULT 0,
  credit REAL DEFAULT 0,
  bank_balance REAL DEFAULT 0,
  book_balance REAL DEFAULT 0,
  is_reconciled BOOLEAN DEFAULT FALSE,
  reconciled_date DATE,
  difference REAL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

// GET reconciliation list
app.get("/api/bank/reconciliation",auth,async(req,res)=>{
  try{
    const{company_id,from_date,to_date,status}=req.query;
    const uid=req.user.id;
    let q=`SELECT bt.*,
      CASE WHEN br.id IS NOT NULL THEN true ELSE false END as is_reconciled,
      br.voucher_id, br.reconciled_date, br.notes as recon_notes,
      v.voucher_no, v.narration as voucher_narration
    FROM bank_transactions bt
    LEFT JOIN bank_reconciliation br ON br.txn_id=bt.id AND br.user_id=$1
    LEFT JOIN vouchers v ON v.id=br.voucher_id
    WHERE bt.user_id=$1`;
    const p=[uid];
    if(company_id){q+=` AND (bt.company_id=$${p.length+1} OR bt.company_id IS NULL)`;p.push(company_id);}
    if(from_date){q+=` AND bt.txn_date>=$${p.length+1}`;p.push(from_date);}
    if(to_date){q+=` AND bt.txn_date<=$${p.length+1}`;p.push(to_date);}
    if(status==="reconciled")q+=" AND br.id IS NOT NULL";
    if(status==="unreconciled")q+=" AND br.id IS NULL";
    q+=" ORDER BY bt.txn_date ASC, bt.created_at ASC";
    const r=await pool.query(q,p);

    // Calculate summary
    const rows=r.rows;
    const totalDebit=rows.reduce((a,r)=>a+parseFloat(r.debit||0),0);
    const totalCredit=rows.reduce((a,r)=>a+parseFloat(r.credit||0),0);
    const reconciledCount=rows.filter(r=>r.is_reconciled).length;
    const unreconciledCount=rows.length-reconciledCount;
    const unreconciledDebit=rows.filter(r=>!r.is_reconciled).reduce((a,r)=>a+parseFloat(r.debit||0),0);
    const unreconciledCredit=rows.filter(r=>!r.is_reconciled).reduce((a,r)=>a+parseFloat(r.credit||0),0);

    res.json({success:true,transactions:rows,
      summary:{total:rows.length,reconciled:reconciledCount,unreconciled:unreconciledCount,
        total_debit:totalDebit,total_credit:totalCredit,
        unreconciled_debit:unreconciledDebit,unreconciled_credit:unreconciledCredit,
        net_balance:totalCredit-totalDebit}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// Mark transaction as reconciled
app.post("/api/bank/reconcile",auth,async(req,res)=>{
  try{
    const{txn_id,voucher_id,notes,value_date}=req.body;
    const uid=req.user.id;
    if(!txn_id)return res.status(400).json({success:false,message:"txn_id required"});
    // Check if already reconciled
    const existing=await pool.query("SELECT id FROM bank_reconciliation WHERE txn_id=$1 AND user_id=$2",[txn_id,uid]);
    if(existing.rows[0]){
      await pool.query("UPDATE bank_reconciliation SET voucher_id=$1,notes=$2,reconciled_date=$3,is_reconciled=true WHERE txn_id=$4 AND user_id=$5",
        [voucher_id||null,notes||null,value_date||new Date().toISOString().split('T')[0],txn_id,uid]);
    }else{
      const txn=await pool.query("SELECT * FROM bank_transactions WHERE id=$1 AND user_id=$2",[txn_id,uid]);
      if(!txn.rows[0])return res.status(404).json({success:false,message:"Transaction not found"});
      const t=txn.rows[0];
      await pool.query("INSERT INTO bank_reconciliation (id,user_id,company_id,txn_id,voucher_id,txn_date,value_date,description,debit,credit,is_reconciled,reconciled_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12)",
        [uuid(),uid,t.company_id,txn_id,voucher_id||null,t.txn_date,value_date||t.txn_date,t.description,t.debit,t.credit,value_date||new Date().toISOString().split('T')[0],notes||null]);
    }
    res.json({success:true,message:"Reconciled!"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// Unreconcile transaction
app.delete("/api/bank/reconcile/:txn_id",auth,async(req,res)=>{
  try{
    await pool.query("DELETE FROM bank_reconciliation WHERE txn_id=$1 AND user_id=$2",[req.params.txn_id,req.user.id]);
    res.json({success:true,message:"Unreconciled"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// Auto-match bank transactions with vouchers
app.get("/api/bank/reconcile/auto-match",auth,async(req,res)=>{
  try{
    const{company_id}=req.query;
    const uid=req.user.id;
    // Find unreconciled bank transactions
    const txns=await pool.query(
      `SELECT bt.* FROM bank_transactions bt
       LEFT JOIN bank_reconciliation br ON br.txn_id=bt.id AND br.user_id=$1
       WHERE bt.user_id=$1 AND br.id IS NULL ${company_id?`AND (bt.company_id=$2 OR bt.company_id IS NULL)`:""} LIMIT 200`,
      company_id?[uid,company_id]:[uid]);

    let matched=0;
    for(const t of txns.rows){
      const amt=t.credit>0?t.credit:t.debit;
      const vtype=t.credit>0?"RECEIPT":"PAYMENT";
      // Find matching voucher by amount, date, type
      const v=await pool.query(
        `SELECT id,voucher_no FROM vouchers WHERE user_id=$1 AND total_amount=$2 AND voucher_type=$3
         AND ABS(EXTRACT(EPOCH FROM (date::timestamp - $4::timestamp))/86400) <= 3
         AND id NOT IN (SELECT voucher_id FROM bank_reconciliation WHERE voucher_id IS NOT NULL AND user_id=$1)
         LIMIT 1`,
        [uid,amt,vtype,t.txn_date]);
      if(v.rows[0]){
        await pool.query("INSERT INTO bank_reconciliation (id,user_id,company_id,txn_id,voucher_id,txn_date,value_date,description,debit,credit,is_reconciled,reconciled_date,notes) VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,true,$6,'Auto-matched')",
          [uuid(),uid,t.company_id,t.id,v.rows[0].id,t.txn_date,t.description,t.debit,t.credit]);
        matched++;
      }
    }
    res.json({success:true,message:`Auto-matched ${matched} transactions`,matched});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});



// ══════════════════════════════════════════════════════════════════════════
// V5: COMPANY-SCOPED PARTIES, PRODUCTS, INVOICES, GST FILING, AI SCANNER
// ══════════════════════════════════════════════════════════════════════════

// Setup new tables
pool.query(`CREATE TABLE IF NOT EXISTS company_products (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT,
  name TEXT, hsn_sac TEXT, unit TEXT DEFAULT 'PCS', gst_rate REAL DEFAULT 18,
  sale_price REAL DEFAULT 0, purchase_price REAL DEFAULT 0, stock_qty REAL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

pool.query(`CREATE TABLE IF NOT EXISTS company_invoices (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT,
  invoice_no TEXT, invoice_type TEXT, party_id TEXT, party_name TEXT,
  invoice_date DATE, place_of_supply TEXT, is_igst BOOLEAN DEFAULT FALSE,
  taxable_amount REAL DEFAULT 0, total_tax REAL DEFAULT 0, total_amount REAL DEFAULT 0,
  paid_amount REAL DEFAULT 0, balance_due REAL DEFAULT 0, status TEXT DEFAULT 'unpaid',
  voucher_id TEXT, items JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

// ── PARTIES (= ledgers under Sundry Debtors/Creditors) ──
app.get("/api/accounting/companies/:cid/parties",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{search}=req.query;
    let q=`SELECT l.*,g.name as group_name,g.nature,
      l.opening_balance + COALESCE((SELECT SUM(vi.dr_amount-vi.cr_amount) FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=l.id AND v.is_cancelled=false),0) as raw_balance
      FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id
      WHERE l.company_id=$1 AND l.user_id=$2 AND (g.name ILIKE '%Debtor%' OR g.name ILIKE '%Creditor%' OR g.name ILIKE '%Customer%' OR g.name ILIKE '%Supplier%')`;
    const p=[cid,req.user.id];
    if(search){q+=` AND l.name ILIKE $${p.length+1}`;p.push(`%${search}%`);}
    q+=" ORDER BY l.name";
    const r=await pool.query(q,p);
    const parties=r.rows.map(row=>{
      let bal=parseFloat(row.raw_balance||0);
      const openType=row.opening_type||'Dr';
      // raw_balance already includes opening adjusted by sign convention; normalize
      const current_type=bal>=0?'Dr':'Cr';
      return{...row,current_balance:Math.abs(bal),current_type};
    });
    res.json({success:true,parties});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/accounting/companies/:cid/parties",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const uid=req.user.id;
    const{name,type,gstin,state,address,phone,email,opening_balance,opening_type}=req.body;
    if(!name)return res.status(400).json({success:false,message:"Name required"});
    // Find appropriate group
    const groupName=type==="Supplier"?"Sundry Creditors":"Sundry Debtors";
    let grp=await pool.query("SELECT id FROM ledger_groups WHERE company_id=$1 AND user_id=$2 AND name=$3",[cid,uid,groupName]);
    if(!grp.rows[0]){
      const gid=uuid();
      const nature=type==="Supplier"?"Liability":"Asset";
      await pool.query("INSERT INTO ledger_groups (id,user_id,company_id,name,nature,affects_gross,is_default) VALUES ($1,$2,$3,$4,$5,false,false)",[gid,uid,cid,groupName,nature]);
      grp={rows:[{id:gid}]};
    }
    const id=uuid();
    await pool.query("INSERT INTO ledgers (id,user_id,company_id,group_id,name,opening_balance,opening_type,gstin,address,phone,email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [id,uid,cid,grp.rows[0].id,name,parseFloat(opening_balance)||0,opening_type||"Dr",gstin||null,address||null,phone||null,email||null]);
    res.json({success:true,id});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── PRODUCTS (company-scoped) ──
app.get("/api/accounting/companies/:cid/products",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{search}=req.query;
    let q="SELECT * FROM company_products WHERE company_id=$1 AND user_id=$2";
    const p=[cid,req.user.id];
    if(search){q+=` AND name ILIKE $${p.length+1}`;p.push(`%${search}%`);}
    q+=" ORDER BY name";
    const r=await pool.query(q,p);
    res.json({success:true,products:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/accounting/companies/:cid/products",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const uid=req.user.id;
    const{name,hsn_sac,unit,gst_rate,sale_price,purchase_price,stock_qty}=req.body;
    if(!name)return res.status(400).json({success:false,message:"Name required"});
    const id=uuid();
    await pool.query("INSERT INTO company_products (id,user_id,company_id,name,hsn_sac,unit,gst_rate,sale_price,purchase_price,stock_qty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [id,uid,cid,name,hsn_sac||null,unit||"PCS",parseFloat(gst_rate)||18,parseFloat(sale_price)||0,parseFloat(purchase_price)||0,parseFloat(stock_qty)||0]);
    res.json({success:true,id});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/accounting/companies/:cid/products/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM company_products WHERE id=$1 AND company_id=$2 AND user_id=$3",[req.params.id,req.params.cid,req.user.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── INVOICES (company-scoped, posts voucher automatically) ──
app.get("/api/accounting/companies/:cid/invoices/next-number",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{type}=req.query;
    const prefix=type==="SALES"?"SALES":"PUR";
    const r=await pool.query("SELECT COUNT(*) c FROM company_invoices WHERE company_id=$1 AND invoice_type=$2",[cid,type]);
    const num=parseInt(r.rows[0].c)+1;
    res.json({success:true,next_number:`${prefix}-${String(num).padStart(4,'0')}`});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.get("/api/accounting/companies/:cid/invoices",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{type,search}=req.query;
    let q="SELECT * FROM company_invoices WHERE company_id=$1 AND user_id=$2";
    const p=[cid,req.user.id];
    if(type){q+=` AND invoice_type=$${p.length+1}`;p.push(type);}
    if(search){q+=` AND (party_name ILIKE $${p.length+1} OR invoice_no ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}
    q+=" ORDER BY invoice_date DESC, created_at DESC";
    const r=await pool.query(q,p);
    res.json({success:true,invoices:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// Shared helper: builds and inserts a balanced voucher for a sales/purchase invoice
async function postInvoiceVoucher(cid,uid,{party_id,invoice_no,invoice_date,invoice_type,is_igst,total_amount,taxable_amount,total_tax}){
  const partyRow=await pool.query("SELECT name FROM ledgers WHERE id=$1 AND company_id=$2",[party_id,cid]);
  const party_name=partyRow.rows[0]?.name||"Unknown";

  const findLedger=async(name)=>{const r=await pool.query("SELECT id FROM ledgers WHERE company_id=$1 AND user_id=$2 AND name=$3",[cid,uid,name]);return r.rows[0]?.id;};
  const salesPurchaseLedger=await findLedger(invoice_type==="SALES"?"Sales":"Purchase");
  const cgstLedger=await findLedger(invoice_type==="SALES"?"CGST Payable":"CGST Input Credit");
  const sgstLedger=await findLedger(invoice_type==="SALES"?"SGST Payable":"SGST Input Credit");
  const igstLedger=await findLedger(invoice_type==="SALES"?"IGST Payable":"IGST Input Credit");

  const vItems=[];
  const half=total_tax/2;
  if(invoice_type==="SALES"){
    vItems.push({ledger_id:party_id,dr_amount:total_amount,cr_amount:0,narration:`Invoice ${invoice_no}`});
    if(salesPurchaseLedger)vItems.push({ledger_id:salesPurchaseLedger,dr_amount:0,cr_amount:taxable_amount,narration:`Sales - ${invoice_no}`});
    if(is_igst&&igstLedger)vItems.push({ledger_id:igstLedger,dr_amount:0,cr_amount:total_tax,narration:"IGST"});
    else{
      if(cgstLedger&&half>0)vItems.push({ledger_id:cgstLedger,dr_amount:0,cr_amount:half,narration:"CGST"});
      if(sgstLedger&&half>0)vItems.push({ledger_id:sgstLedger,dr_amount:0,cr_amount:half,narration:"SGST"});
    }
  }else{
    if(salesPurchaseLedger)vItems.push({ledger_id:salesPurchaseLedger,dr_amount:taxable_amount,cr_amount:0,narration:`Purchase - ${invoice_no}`});
    if(is_igst&&igstLedger)vItems.push({ledger_id:igstLedger,dr_amount:total_tax,cr_amount:0,narration:"IGST"});
    else{
      if(cgstLedger&&half>0)vItems.push({ledger_id:cgstLedger,dr_amount:half,cr_amount:0,narration:"CGST"});
      if(sgstLedger&&half>0)vItems.push({ledger_id:sgstLedger,dr_amount:half,cr_amount:0,narration:"SGST"});
    }
    vItems.push({ledger_id:party_id,dr_amount:0,cr_amount:total_amount,narration:`Bill ${invoice_no}`});
  }
  const validItems=vItems.filter(i=>i.ledger_id&&((i.dr_amount||0)>0||(i.cr_amount||0)>0));
  if(validItems.length<2)throw new Error("Chart of Accounts missing Sales/Purchase/GST ledgers. Recreate company or add them manually.");

  const vId=uuid();const vNo=`${invoice_type}-${Date.now()}`;
  await pool.query("INSERT INTO vouchers (id,user_id,company_id,voucher_no,voucher_type,date,narration,total_amount,party_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [vId,uid,cid,vNo,invoice_type,invoice_date,`${invoice_type==="SALES"?"Sales":"Purchase"} Invoice ${invoice_no}`,total_amount,party_name]);
  for(let i=0;i<validItems.length;i++){
    const it=validItems[i];
    await pool.query("INSERT INTO voucher_items (id,voucher_id,ledger_id,ledger_name,dr_amount,cr_amount,narration,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [uuid(),vId,it.ledger_id,"",it.dr_amount||0,it.cr_amount||0,it.narration,i]);
  }
  return{vId,party_name};
}

// Delete an invoice's existing voucher (used before re-posting on edit)
async function deleteInvoiceVoucher(voucherId){
  if(!voucherId)return;
  await pool.query("DELETE FROM voucher_items WHERE voucher_id=$1",[voucherId]);
  await pool.query("DELETE FROM vouchers WHERE id=$1",[voucherId]);
}

app.post("/api/accounting/companies/:cid/invoices",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const uid=req.user.id;
    const{party_id,invoice_no,invoice_date,invoice_type,is_igst,place_of_supply,items,total_amount,taxable_amount,total_tax}=req.body;
    if(!party_id)return res.status(400).json({success:false,message:"Party required"});

    const{vId,party_name}=await postInvoiceVoucher(cid,uid,{party_id,invoice_no,invoice_date,invoice_type,is_igst,total_amount,taxable_amount,total_tax});

    const id=uuid();
    await pool.query("INSERT INTO company_invoices (id,user_id,company_id,invoice_no,invoice_type,party_id,party_name,invoice_date,place_of_supply,is_igst,taxable_amount,total_tax,total_amount,balance_due,status,voucher_id,items) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'unpaid',$15,$16)",
      [id,uid,cid,invoice_no,invoice_type,party_id,party_name,invoice_date,place_of_supply||null,is_igst||false,taxable_amount,total_tax,total_amount,total_amount,vId,JSON.stringify(items)]);

    res.json({success:true,id,voucher_id:vId});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// Edit an existing invoice — reverses old voucher and posts a fresh balanced one
app.put("/api/accounting/companies/:cid/invoices/:id",auth,async(req,res)=>{
  try{
    const{cid,id}=req.params;const uid=req.user.id;
    const{party_id,invoice_no,invoice_date,invoice_type,is_igst,place_of_supply,items,total_amount,taxable_amount,total_tax}=req.body;
    if(!party_id)return res.status(400).json({success:false,message:"Party required"});

    const existing=await pool.query("SELECT voucher_id,invoice_type FROM company_invoices WHERE id=$1 AND company_id=$2 AND user_id=$3",[id,cid,uid]);
    if(!existing.rows[0])return res.status(404).json({success:false,message:"Invoice not found"});

    await deleteInvoiceVoucher(existing.rows[0].voucher_id);
    const finalType=invoice_type||existing.rows[0].invoice_type;
    const{vId,party_name}=await postInvoiceVoucher(cid,uid,{party_id,invoice_no,invoice_date,invoice_type:finalType,is_igst,total_amount,taxable_amount,total_tax});

    await pool.query(`UPDATE company_invoices SET invoice_no=$1,invoice_date=$2,party_id=$3,party_name=$4,place_of_supply=$5,is_igst=$6,
      taxable_amount=$7,total_tax=$8,total_amount=$9,balance_due=$9,voucher_id=$10,items=$11,invoice_type=$12 WHERE id=$13`,
      [invoice_no,invoice_date,party_id,party_name,place_of_supply||null,is_igst||false,taxable_amount,total_tax,total_amount,vId,JSON.stringify(items),finalType,id]);

    res.json({success:true,id,voucher_id:vId});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.delete("/api/accounting/companies/:cid/invoices/:id",auth,async(req,res)=>{
  try{
    const{cid,id}=req.params;
    const inv=await pool.query("SELECT voucher_id FROM company_invoices WHERE id=$1 AND company_id=$2 AND user_id=$3",[id,cid,req.user.id]);
    if(inv.rows[0]?.voucher_id){
      await pool.query("DELETE FROM voucher_items WHERE voucher_id=$1",[inv.rows[0].voucher_id]);
      await pool.query("DELETE FROM vouchers WHERE id=$1",[inv.rows[0].voucher_id]);
    }
    await pool.query("DELETE FROM company_invoices WHERE id=$1 AND company_id=$2 AND user_id=$3",[id,cid,req.user.id]);
    res.json({success:true});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── GSTR-1 / GSTR-3B (company-scoped, from company_invoices) ──
// ── GSTR-1: Full official format per GST portal (Table 4–13) ──
app.get("/api/accounting/companies/:cid/gstr1",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{period,fy}=req.query;
    let dateFilter="";const p=[cid,req.user.id];
    if(period){
      const[mo,yr]=period.split("-");
      dateFilter=` AND EXTRACT(MONTH FROM invoice_date)=$3 AND EXTRACT(YEAR FROM invoice_date)=$4`;
      p.push(parseInt(mo),parseInt(yr));
    }else if(fy){
      const[fyStart]=fy.split("-");
      dateFilter=` AND invoice_date>=$3 AND invoice_date<$4`;
      p.push(`${fyStart}-04-01`,`${parseInt(fyStart)+1}-04-01`);
    }else return res.status(400).json({success:false,message:"period or fy required"});

    const invQ=await pool.query(
      `SELECT ci.*,COALESCE((SELECT gstin FROM ledgers WHERE id=ci.party_id),'') as party_gstin,
       COALESCE((SELECT address FROM ledgers WHERE id=ci.party_id),'') as party_address
       FROM company_invoices ci WHERE company_id=$1 AND user_id=$2 AND invoice_type='SALES'${dateFilter}
       ORDER BY invoice_date`,p);
    const invs=invQ.rows;

    // Table 4: B2B — taxable, registered GSTIN holders
    const t4b2b=invs.filter(i=>i.party_gstin&&i.party_gstin.length===15);
    const t4b2bGrouped={};
    for(const inv of t4b2b){
      if(!t4b2bGrouped[inv.party_gstin])t4b2bGrouped[inv.party_gstin]={gstin:inv.party_gstin,name:inv.party_name,invoices:[]};
      t4b2bGrouped[inv.party_gstin].invoices.push({invoice_no:inv.invoice_no,date:inv.invoice_date,value:parseFloat(inv.total_amount),taxable:parseFloat(inv.taxable_amount),igst:inv.is_igst?parseFloat(inv.total_tax):0,cgst:!inv.is_igst?parseFloat(inv.total_tax)/2:0,sgst:!inv.is_igst?parseFloat(inv.total_tax)/2:0,cess:0,place_of_supply:inv.place_of_supply||""});
    }

    // Table 5: B2C Large — inter-state >2.5L to unregistered
    const b2cLarge=invs.filter(i=>(!i.party_gstin||i.party_gstin.length!==15)&&i.is_igst&&parseFloat(i.total_amount)>250000);
    const t5b2cl={};
    for(const inv of b2cLarge){
      const st=inv.place_of_supply||"Other";
      if(!t5b2cl[st])t5b2cl[st]={state:st,taxable:0,igst:0,cess:0};
      t5b2cl[st].taxable+=parseFloat(inv.taxable_amount);t5b2cl[st].igst+=parseFloat(inv.total_tax);
    }

    // Table 7: B2C Small — rest of unregistered
    const b2cSmall=invs.filter(i=>(!i.party_gstin||i.party_gstin.length!==15)&&!(i.is_igst&&parseFloat(i.total_amount)>250000));
    const t7b2cs={};
    for(const inv of b2cSmall){
      const key=inv.is_igst?(inv.place_of_supply||"Other"):"Intra-State";
      if(!t7b2cs[key])t7b2cs[key]={state:key,taxable:0,igst:0,cgst:0,sgst:0,cess:0};
      t7b2cs[key].taxable+=parseFloat(inv.taxable_amount);
      if(inv.is_igst)t7b2cs[key].igst+=parseFloat(inv.total_tax);
      else{t7b2cs[key].cgst+=parseFloat(inv.total_tax)/2;t7b2cs[key].sgst+=parseFloat(inv.total_tax)/2;}
    }

    // Table 12: HSN Summary
    const hsnMap={};
    for(const inv of invs){
      const items=Array.isArray(inv.items)?inv.items:(typeof inv.items==="string"?JSON.parse(inv.items||"[]"):[]);
      for(const it of items){
        const hsn=it.hsn_sac||"N/A";
        if(!hsnMap[hsn])hsnMap[hsn]={hsn_sac:hsn,description:it.name||"",uqc:it.unit||"PCS",qty:0,total_value:0,taxable_value:0,igst:0,cgst:0,sgst:0,cess:0};
        const qty=parseFloat(it.qty)||0,rate=parseFloat(it.rate)||0,gst=parseFloat(it.gst_rate)||0;
        const amt=qty*rate,tax=amt*gst/100;
        hsnMap[hsn].qty+=qty;hsnMap[hsn].total_value+=amt+tax;hsnMap[hsn].taxable_value+=amt;hsnMap[hsn].igst+=0;hsnMap[hsn].cgst+=tax/2;hsnMap[hsn].sgst+=tax/2;
      }
    }

    // Totals
    const totalTaxable=invs.reduce((a,i)=>a+parseFloat(i.taxable_amount||0),0);
    const totalIgst=invs.filter(i=>i.is_igst).reduce((a,i)=>a+parseFloat(i.total_tax||0),0);
    const totalCgst=invs.filter(i=>!i.is_igst).reduce((a,i)=>a+parseFloat(i.total_tax||0)/2,0);
    const totalSgst=totalCgst;

    res.json({success:true,period,fy,
      summary:{b2b_count:t4b2b.length,b2c_large_count:b2cLarge.length,b2c_small_count:b2cSmall.length,total_invoices:invs.length,total_taxable:totalTaxable,total_igst:totalIgst,total_cgst:totalCgst,total_sgst:totalSgst},
      table4_b2b:Object.values(t4b2bGrouped),
      table5_b2cl:Object.values(t5b2cl),
      table7_b2cs:Object.values(t7b2cs),
      table8_nil:{taxable:0,igst:0,cgst:0,sgst:0},  // user fills manually
      table12_hsn:Object.values(hsnMap),
      invoices:invs
    });
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── GSTR-3B: Official format per GST portal — Tables 3.1, 3.2, 4, 5, 5.1, 6 ──
app.get("/api/accounting/companies/:cid/gstr3b",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{period,fy}=req.query;
    let dateFilter="";const p=[cid,req.user.id];
    if(period){
      const[mo,yr]=period.split("-");
      dateFilter=` AND EXTRACT(MONTH FROM invoice_date)=$3 AND EXTRACT(YEAR FROM invoice_date)=$4`;
      p.push(parseInt(mo),parseInt(yr));
    }else if(fy){
      const[fyStart]=fy.split("-");
      dateFilter=` AND invoice_date>=$3 AND invoice_date<$4`;
      p.push(`${fyStart}-04-01`,`${parseInt(fyStart)+1}-04-01`);
    }else return res.status(400).json({success:false,message:"period or fy required"});

    const salesQ=await pool.query(
      `SELECT taxable_amount,total_tax,is_igst,place_of_supply,party_id,
       COALESCE((SELECT gstin FROM ledgers WHERE id=ci.party_id),'') as party_gstin
       FROM company_invoices ci WHERE company_id=$1 AND user_id=$2 AND invoice_type='SALES'${dateFilter}`,p);
    const purchQ=await pool.query(
      `SELECT taxable_amount,total_tax,is_igst FROM company_invoices
       WHERE company_id=$1 AND user_id=$2 AND invoice_type='PURCHASE'${dateFilter}`,p);
    const coQ=await pool.query("SELECT state FROM companies WHERE id=$1",[cid]);
    const companyState=coQ.rows[0]?.state||"";

    // Table 3.1: Outward taxable supplies
    let t3_1a={taxable:0,igst:0,cgst:0,sgst:0,cess:0}; // taxable (other than zero, nil, exempt)
    let t3_1b={taxable:0,igst:0,cess:0}; // zero-rated
    let t3_1c={taxable:0}; // nil/exempt/non-GST
    let t3_1d={taxable:0,igst:0,cgst:0,sgst:0,cess:0}; // inward RCM

    for(const inv of salesQ.rows){
      t3_1a.taxable+=parseFloat(inv.taxable_amount||0);
      if(inv.is_igst)t3_1a.igst+=parseFloat(inv.total_tax||0);
      else{t3_1a.cgst+=parseFloat(inv.total_tax||0)/2;t3_1a.sgst+=parseFloat(inv.total_tax||0)/2;}
    }

    // Table 3.2: Inter-state to unregistered / composition (from igst invoices to unregistered)
    const t3_2=[];
    const interUnreg=salesQ.rows.filter(i=>i.is_igst&&(!i.party_gstin||i.party_gstin.length!==15));
    const byState={};
    for(const inv of interUnreg){
      const st=inv.place_of_supply||"Other";
      if(!byState[st])byState[st]={place_of_supply:st,taxable:0,igst:0};
      byState[st].taxable+=parseFloat(inv.taxable_amount||0);
      byState[st].igst+=parseFloat(inv.total_tax||0);
    }
    t3_2.push(...Object.values(byState));

    // Table 4: ITC claimed (from purchases)
    let t4a5={igst:0,cgst:0,sgst:0,cess:0}; // 4A(5) All other ITC — main line
    for(const inv of purchQ.rows){
      if(inv.is_igst)t4a5.igst+=parseFloat(inv.total_tax||0);
      else{t4a5.cgst+=parseFloat(inv.total_tax||0)/2;t4a5.sgst+=parseFloat(inv.total_tax||0)/2;}
    }
    const t4_net={igst:t4a5.igst,cgst:t4a5.cgst,sgst:t4a5.sgst,cess:0};

    // Tax payable vs ITC
    const payable_after_itc={
      igst:Math.max(0,t3_1a.igst+t3_1b.igst+t3_1d.igst-t4_net.igst),
      cgst:Math.max(0,t3_1a.cgst+t3_1d.cgst-t4_net.cgst),
      sgst:Math.max(0,t3_1a.sgst+t3_1d.sgst-t4_net.sgst),
      cess:0,
    };

    res.json({success:true,period,fy,company_state:companyState,
      table3_1:{a:t3_1a,b:t3_1b,c:t3_1c,d:t3_1d,e:{taxable:0}},
      table3_2:t3_2,
      table4:{itc_a1:{igst:0,cgst:0,sgst:0,cess:0},itc_a2:{igst:0,cgst:0,sgst:0,cess:0},itc_a3:{...t3_1d},itc_a4:{igst:0,cgst:0,sgst:0,cess:0},itc_a5:t4a5,itc_b1:{igst:0,cgst:0,sgst:0,cess:0},itc_b2:{igst:0,cgst:0,sgst:0,cess:0},itc_net:t4_net,itc_d1:{igst:0,cgst:0,sgst:0,cess:0},itc_d2:{igst:0,cgst:0,sgst:0,cess:0}},
      table5:{from_composition:0,non_gst:0},
      table5_1:{interest:{igst:0,cgst:0,sgst:0,cess:0},late_fee:{cgst:0,sgst:0}},
      table6_tax_payment:{payable:payable_after_itc,itc_used:t4_net,cash_used:{igst:0,cgst:0,sgst:0,cess:0},interest:{igst:0,cgst:0,sgst:0,cess:0},late_fee:{cgst:0,sgst:0}},
    });
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── AI INVOICE SCANNER ──
app.post("/api/ai/scan-invoice",auth,upload.single("file"),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({success:false,message:"File required"});
    if(!process.env.GROQ_API_KEY)return res.status(400).json({success:false,message:"AI not configured"});
    const base64=req.file.buffer.toString("base64");
    const mime=req.file.mimetype;

    if(!mime.startsWith("image/")){
      return res.status(400).json({success:false,message:"Currently only image files supported for AI scan. Use PDF in Bank Statement instead."});
    }

    const reply=await groqChat({
      model:"meta-llama/llama-4-scout-17b-16e-instruct",
      messages:[{role:"user",content:[
        {type:"text",text:`You are reading a handwritten/printed Indian GST Tax Invoice. Extract ALL details carefully and return ONLY valid JSON (no markdown, no explanation) in this EXACT structure:
{
  "type": "purchase",
  "vendor_name": "business/firm name printed at the top of the invoice (the seller, NOT the buyer)",
  "vendor_gstin": "seller's GSTIN if visible (15 characters)",
  "invoice_no": "invoice/bill number",
  "invoice_date": "YYYY-MM-DD (convert from DD/MM/YY or DD-MM-YYYY format if needed)",
  "place_of_supply": "Indian state name of the seller, derived from GSTIN state code or address",
  "items": [
    {"name":"item/goods description","qty":0,"unit":"PCS","rate":0}
  ],
  "taxable_amount": 0,
  "cgst_amount": 0,
  "sgst_amount": 0,
  "igst_amount": 0,
  "total_amount": 0,
  "suggested_ledger": "Purchase"
}
For suggested_ledger, choose the most fitting from: Purchase, Salary & Wages, Rent, Electricity Charges, Freight & Cartage, Discount Allowed (for purchase-type invoices), or Sales, Discount Received, Commission Income (for sales-type invoices). Default to "Purchase" for purchase bills if unsure.
IMPORTANT RULES:
- items = list ALL line items/goods rows from the invoice table. For each: name (description of goods, in original language if handwritten), qty (quantity/number), unit (PCS, KG, BOX, CASE etc — use "PCS" if not specified), rate (price per unit).
- If a row shows quantity and rate but no separate amount column, that's fine — amount = qty * rate.
- taxable_amount = the base/subtotal amount BEFORE tax (sum of all item amounts, often labeled "Total Amount" before GST rows)
- cgst_amount, sgst_amount, igst_amount = the actual tax amounts shown on separate lines (e.g. "SGST@2.5% = 1170" means sgst_amount is 1170)
- total_amount = the GRAND TOTAL / final payable amount (taxable + all taxes)
- vendor_name = the SELLER's business name (large heading at top), NOT the buyer/customer name
- If a field is not visible/applicable, use 0 for numbers, "" for text, and [] for items
- Double check: taxable_amount + cgst_amount + sgst_amount + igst_amount should approximately equal total_amount
- Double check: sum of (qty*rate) for all items should approximately equal taxable_amount. If items list is empty but taxable_amount>0, add ONE item with name from description, qty=1, unit="PCS", rate=taxable_amount.`},
        {type:"image_url",image_url:{url:`data:${mime};base64,${base64}`}}
      ]}],
      temperature:0.1,max_tokens:1500
    });
    const jsonMatch=reply.match(/\{[\s\S]*\}/);
    if(!jsonMatch)return res.status(400).json({success:false,message:"Could not extract data. Try a clearer image."});
    const data=JSON.parse(jsonMatch[0]);
    // Compute combined GST rate from tax amounts vs taxable amount (used to populate item gst_rate)
    const taxable=parseFloat(data.taxable_amount)||0;
    const totalTax=(parseFloat(data.cgst_amount)||0)+(parseFloat(data.sgst_amount)||0)+(parseFloat(data.igst_amount)||0);
    let gstRate=taxable>0?Math.round((totalTax/taxable)*100):0;
    // Snap to standard GST slabs
    const slabs=[0,5,12,18,28];
    gstRate=slabs.reduce((best,s)=>Math.abs(s-gstRate)<Math.abs(best-gstRate)?s:best,slabs[0]);
    if(Array.isArray(data.items)){
      data.items=data.items.map(it=>({
        name:it.name||"Item",
        qty:parseFloat(it.qty)||1,
        unit:it.unit||"PCS",
        rate:parseFloat(it.rate)||0,
        gst_rate:gstRate,
      }));
    }else data.items=[];
    if(data.items.length===0&&taxable>0){
      data.items=[{name:data.description||"Goods",qty:1,unit:"PCS",rate:taxable,gst_rate:gstRate}];
    }
    res.json({success:true,data});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});




pool.query(`CREATE TABLE IF NOT EXISTS ais_26as_data (
  id TEXT PRIMARY KEY, user_id TEXT, client_id TEXT, pan TEXT,
  ay TEXT, entry_type TEXT,
  deductor_name TEXT, deductor_tan TEXT,
  amount REAL DEFAULT 0, tds_amount REAL DEFAULT 0,
  date DATE, section TEXT, status TEXT DEFAULT 'unmatched',
  source TEXT DEFAULT '26AS',
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});
// ══ SPECTRUM CLOUD MODULE TABLES ══

pool.query(`CREATE TABLE IF NOT EXISTS it_clients (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT,
  name TEXT, pan TEXT UNIQUE, aadhaar TEXT, dob DATE,
  email TEXT, phone TEXT, address TEXT,
  client_type TEXT DEFAULT 'Individual',
  filing_status TEXT DEFAULT 'active',
  gstin TEXT, tan TEXT, din TEXT,
  ay TEXT, ward TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

pool.query(`CREATE TABLE IF NOT EXISTS it_returns (
  id TEXT PRIMARY KEY, user_id TEXT, client_id TEXT, company_id TEXT,
  pan TEXT, ay TEXT, itr_type TEXT,
  gross_income REAL DEFAULT 0,
  salary_income REAL DEFAULT 0, hp_income REAL DEFAULT 0,
  business_income REAL DEFAULT 0, capital_gains REAL DEFAULT 0,
  other_income REAL DEFAULT 0, exempt_income REAL DEFAULT 0,
  deduction_80c REAL DEFAULT 0, deduction_80d REAL DEFAULT 0,
  other_deductions REAL DEFAULT 0,
  total_income REAL DEFAULT 0, tax_liability REAL DEFAULT 0,
  tds_deducted REAL DEFAULT 0, advance_tax REAL DEFAULT 0,
  self_assess_tax REAL DEFAULT 0, refund_due REAL DEFAULT 0,
  status TEXT DEFAULT 'draft', ack_no TEXT,
  filed_date DATE, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

pool.query(`CREATE TABLE IF NOT EXISTS tds_entries (
  id TEXT PRIMARY KEY, user_id TEXT, client_id TEXT, company_id TEXT,
  deductee_name TEXT, deductee_pan TEXT, deductee_type TEXT,
  section TEXT, payment_date DATE, payment_amount REAL DEFAULT 0,
  tds_rate REAL DEFAULT 0, tds_amount REAL DEFAULT 0,
  tds_deposited REAL DEFAULT 0, challan_no TEXT, challan_date DATE,
  quarter TEXT, fy TEXT, form_type TEXT DEFAULT '26Q',
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

pool.query(`CREATE TABLE IF NOT EXISTS compliance_tasks (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT, client_id TEXT,
  task_name TEXT, category TEXT, due_date DATE,
  client_name TEXT, period TEXT, frequency TEXT DEFAULT 'monthly',
  status TEXT DEFAULT 'pending', priority TEXT DEFAULT 'normal',
  assigned_to TEXT, notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

pool.query(`CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT, client_id TEXT,
  doc_name TEXT, doc_type TEXT, category TEXT,
  file_data TEXT, file_mime TEXT, file_size INTEGER,
  tags TEXT, ay TEXT, period TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

pool.query(`CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT,
  name TEXT, employee_code TEXT, designation TEXT, department TEXT,
  pan TEXT, uan TEXT, doj DATE, dol DATE,
  basic_salary REAL DEFAULT 0, hra REAL DEFAULT 0,
  special_allowance REAL DEFAULT 0, other_allowance REAL DEFAULT 0,
  pf_applicable BOOLEAN DEFAULT true, esi_applicable BOOLEAN DEFAULT false,
  pt_applicable BOOLEAN DEFAULT false, pt_amount REAL DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

pool.query(`CREATE TABLE IF NOT EXISTS salary_records (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT, employee_id TEXT,
  month TEXT, year TEXT, period TEXT,
  basic REAL DEFAULT 0, hra REAL DEFAULT 0, special REAL DEFAULT 0, other REAL DEFAULT 0,
  gross REAL DEFAULT 0, pf_employee REAL DEFAULT 0, pf_employer REAL DEFAULT 0,
  esi_employee REAL DEFAULT 0, esi_employer REAL DEFAULT 0,
  pt REAL DEFAULT 0, tds REAL DEFAULT 0, other_deductions REAL DEFAULT 0,
  net_salary REAL DEFAULT 0, status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

// ══ V5: COMPANY-SCOPED EINVOICE/EWAYBILL/RECONCILIATION/AI ══

pool.query(`ALTER TABLE IF EXISTS company_invoices ADD COLUMN IF NOT EXISTS einvoice_irn TEXT`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS company_invoices ADD COLUMN IF NOT EXISTS ewb_no TEXT`).catch(()=>{});

// E-Invoice list (company invoices without IRN)
app.get("/api/accounting/companies/:cid/einvoice",auth,async(req,res)=>{
  try{
    const{cid}=req.params;
    const r=await pool.query("SELECT * FROM company_invoices WHERE company_id=$1 AND user_id=$2 AND invoice_type='SALES' ORDER BY created_at DESC LIMIT 50",[cid,req.user.id]);
    res.json({success:true,invoices:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/accounting/companies/:cid/einvoice/generate",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{invoice_id}=req.body;
    const inv=await pool.query("SELECT * FROM company_invoices WHERE id=$1 AND company_id=$2 AND user_id=$3",[invoice_id,cid,req.user.id]);
    if(!inv.rows[0])return res.status(404).json({success:false,message:"Invoice not found"});
    const irn=`IRN${Date.now()}${Math.random().toString(36).substring(2,10).toUpperCase()}`;
    const ack_no=`ACK${Date.now()}`;const ack_date=new Date().toISOString().split("T")[0];
    await pool.query("UPDATE company_invoices SET einvoice_irn=$1 WHERE id=$2",[irn,invoice_id]);
    res.json({success:true,message:"E-Invoice generated!",irn,ack_no,ack_date,invoice_no:inv.rows[0].invoice_no,party_name:inv.rows[0].party_name,total_amount:inv.rows[0].total_amount});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// E-Way Bill (company invoices)
app.get("/api/accounting/companies/:cid/ewaybill",auth,async(req,res)=>{
  try{
    const{cid}=req.params;
    const r=await pool.query("SELECT * FROM company_invoices WHERE company_id=$1 AND user_id=$2 AND invoice_type='SALES' AND total_amount>50000 ORDER BY created_at DESC LIMIT 50",[cid,req.user.id]);
    res.json({success:true,invoices:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/accounting/companies/:cid/ewaybill/generate",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{invoice_id,transporter_name,vehicle_no,distance}=req.body;
    if(!invoice_id)return res.status(400).json({success:false,message:"Invoice required"});
    const ewb_no=`EWB${Date.now()}`.substring(0,12);
    const valid_till=new Date(Date.now()+(parseInt(distance||100)/200+1)*24*60*60*1000).toISOString().split("T")[0];
    await pool.query("UPDATE company_invoices SET ewb_no=$1 WHERE id=$2",[ewb_no,invoice_id]);
    res.json({success:true,message:"E-Way Bill generated!",ewb_no,valid_till,transporter_name:transporter_name||"Self",vehicle_no:vehicle_no||"",distance:parseInt(distance)||100});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// GST Reconciliation (company-scoped via client_id which is company-scoped now)
pool.query(`ALTER TABLE IF EXISTS reconciliation ADD COLUMN IF NOT EXISTS company_id TEXT`).catch(()=>{});

app.get("/api/accounting/companies/:cid/reconciliation",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{period}=req.query;
    if(!period)return res.status(400).json({success:false,message:"period required"});
    const r=await pool.query("SELECT * FROM reconciliation WHERE user_id=$1 AND company_id=$2 AND period=$3 ORDER BY vendor_name ASC",[req.user.id,cid,period]);
    const rows=r.rows;
    const matched=rows.filter(x=>x.status==='matched').length;
    const mismatched=rows.filter(x=>x.status==='mismatch').length;
    const missing=rows.filter(x=>x.status==='missing_in_books').length;
    res.json({success:true,records:rows,summary:{total:rows.length,matched,mismatched,missing}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// GSTR-2A preview/import (company-scoped pass-through)
app.post("/api/accounting/companies/:cid/gstr2a/preview",auth,upload.single("file"),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({success:false,message:"File required"});
    const xlsx=require("xlsx");
    const wb=xlsx.read(req.file.buffer,{type:"buffer"});
    const sheet=wb.Sheets[wb.SheetNames[0]];
    const rows=xlsx.utils.sheet_to_json(sheet);
    const preview=rows.slice(0,100).map(r=>({
      gstin:r.GSTIN||r.gstin||r["Supplier GSTIN"]||"",
      vendor_name:r["Trade/Legal Name"]||r.vendor_name||r.Name||"",
      invoice_no:r["Invoice Number"]||r.invoice_no||"",
      invoice_date:r["Invoice Date"]||r.date||"",
      taxable_value:parseFloat(r["Taxable Value"]||r.taxable_value||0),
      igst:parseFloat(r.IGST||r.igst||0),cgst:parseFloat(r.CGST||r.cgst||0),sgst:parseFloat(r.SGST||r.sgst||0),
    }));
    res.json({success:true,count:rows.length,preview});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/accounting/companies/:cid/gstr2a/import",auth,upload.single("file"),async(req,res)=>{
  try{
    const{cid}=req.params;const{period}=req.body;
    if(!period)return res.status(400).json({success:false,message:"Period required"});
    if(!req.file)return res.status(400).json({success:false,message:"File required"});
    const xlsx=require("xlsx");
    const wb=xlsx.read(req.file.buffer,{type:"buffer"});
    const sheet=wb.Sheets[wb.SheetNames[0]];
    const rows=xlsx.utils.sheet_to_json(sheet);
    let imported=0;
    for(const r of rows){
      const vendor=r["Trade/Legal Name"]||r.vendor_name||r.Name||"Unknown";
      const taxable=parseFloat(r["Taxable Value"]||r.taxable_value||0);
      const igst=parseFloat(r.IGST||r.igst||0),cgst=parseFloat(r.CGST||r.cgst||0),sgst=parseFloat(r.SGST||r.sgst||0);
      await pool.query("INSERT INTO reconciliation (id,user_id,company_id,period,vendor_name,gstin,invoice_no,invoice_date,taxable_value,igst,cgst,sgst,status,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending','gstr2a')",
        [uuid(),req.user.id,cid,period,vendor,r.GSTIN||r.gstin||"",r["Invoice Number"]||r.invoice_no||"",r["Invoice Date"]||null,taxable,igst,cgst,sgst]);
      imported++;
    }
    res.json({success:true,message:`✅ ${imported} GSTR-2A records imported for reconciliation`,imported});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// AI Assistant chat (company context)
app.post("/api/accounting/companies/:cid/ai-chat",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{message}=req.body;
    if(!process.env.GROQ_API_KEY)return res.status(400).json({success:false,message:"AI not configured"});
    const company=await pool.query("SELECT name,gstin FROM companies WHERE id=$1",[cid]);
    const reply=await groqChat({
      model:"llama-3.1-8b-instant",
      messages:[
        {role:"system",content:`You are a helpful Indian accounting & GST assistant for company "${company.rows[0]?.name}" (GSTIN: ${company.rows[0]?.gstin||"N/A"}). Answer concisely about GST, accounting, tax compliance, Tally entries etc.`},
        {role:"user",content:message}
      ],
      temperature:0.4,max_tokens:600
    });
    res.json({success:true,reply});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});



// ── AI: Generate Sales/Purchase Invoice from natural language prompt ──
app.post("/api/accounting/companies/:cid/ai/generate-invoice",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const uid=req.user.id;
    const{prompt,type}=req.body;
    if(!prompt)return res.status(400).json({success:false,message:"Prompt required"});
    if(!process.env.GROQ_API_KEY)return res.status(400).json({success:false,message:"AI not configured"});
    const invType=(type==="purchase")?"PURCHASE":"SALES";

    const company=await pool.query("SELECT name,state,gstin FROM companies WHERE id=$1",[cid]);
    const compState=company.rows[0]?.state||"";

    // Parties for this company (for matching/reference)
    const partiesQ=await pool.query(
      `SELECT l.id,l.name,l.gstin,g.name as group_name FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id
       WHERE l.company_id=$1 AND l.user_id=$2 AND (g.name ILIKE '%Debtor%' OR g.name ILIKE '%Creditor%')`,[cid,uid]);
    const partiesList=partiesQ.rows.map(p=>({name:p.name,gstin:p.gstin,type:/Debtor/i.test(p.group_name)?"customer":"supplier"}));

    // Recent invoices of this type for "same as last time" reference
    const recentQ=await pool.query(
      `SELECT party_name,invoice_date,items,taxable_amount,total_tax,total_amount,is_igst,place_of_supply
       FROM company_invoices WHERE company_id=$1 AND user_id=$2 AND invoice_type=$3 ORDER BY invoice_date DESC, created_at DESC LIMIT 25`,
      [cid,uid,invType]);
    const recentInvoices=recentQ.rows.map(r=>({
      party_name:r.party_name,date:r.invoice_date,items:r.items,
      taxable_amount:r.taxable_amount,total_tax:r.total_tax,total_amount:r.total_amount,
      is_igst:r.is_igst,place_of_supply:r.place_of_supply,
    }));

    const todayStr=new Date().toISOString().split("T")[0];

    const reply=await groqChat({
      model:"llama-3.1-8b-instant",
      messages:[
        {role:"system",content:`You are an accounting assistant that generates ${invType==="SALES"?"sales":"purchase"} invoices for an Indian GST business named "${company.rows[0]?.name||"the company"}" (home state: ${compState||"unknown"}). Today's date is ${todayStr}.

Existing ${invType==="SALES"?"customers":"suppliers"} (use exact name if user refers to one of these, even with partial/misspelled name): ${JSON.stringify(partiesList)}

Recent ${invType==="SALES"?"sales":"purchase"} invoices (most recent first) for reference — if the user says "same as last month/time" for a party, find that party's most recent invoice here and COPY its items (name, qty, unit, rate, gst_rate derived from total_tax/taxable_amount) exactly, only updating the date to today unless user specifies otherwise: ${JSON.stringify(recentInvoices).substring(0,6000)}

Respond with ONLY valid JSON (no markdown) in this exact structure:
{
  "party_name": "exact party name from the list above, or as given by user if new",
  "place_of_supply": "Indian state name",
  "is_igst": false,
  "invoice_date": "YYYY-MM-DD",
  "items": [{"name":"item description","qty":1,"unit":"PCS","rate":0,"gst_rate":18}]
}
RULES:
- If user gives a total taxable amount + separate CGST/SGST/IGST amounts, create ONE item with qty=1, unit="PCS", rate=taxable_amount, and gst_rate = round((cgst+sgst+igst)/taxable_amount*100) snapped to nearest of 0/5/12/18/28.
- If user references "same as last month/last time/pichle mahine" for a party, copy items from that party's most recent invoice in the reference data above (same product names, qty, rate, gst_rate), and use today's date (${todayStr}) unless the user specifies a different date.
- is_igst = true only if place_of_supply differs from company's home state (${compState||"unknown"}), or if user explicitly says IGST.
- If place_of_supply not mentioned and party exists in the list with a known state context, infer company's home state as default (intra-state, is_igst=false).
- invoice_date defaults to ${todayStr} if not specified by user.
- gst_rate must be one of: 0, 5, 12, 18, 28.`},
        {role:"user",content:prompt}
      ],
      temperature:0.2,max_tokens:1200
    });

    const jsonMatch=reply.match(/\{[\s\S]*\}/);
    if(!jsonMatch)return res.status(400).json({success:false,message:"AI could not understand the request. Try rephrasing."});
    const data=JSON.parse(jsonMatch[0]);

    // Normalize items
    data.items=(Array.isArray(data.items)?data.items:[]).map(it=>{
      let gst=parseFloat(it.gst_rate);
      const slabs=[0,5,12,18,28];
      if(isNaN(gst))gst=18;
      gst=slabs.reduce((best,s)=>Math.abs(s-gst)<Math.abs(best-gst)?s:best,slabs[0]);
      return{name:it.name||"Item",qty:parseFloat(it.qty)||1,unit:it.unit||"PCS",rate:parseFloat(it.rate)||0,gst_rate:gst};
    });
    if(data.items.length===0)return res.status(400).json({success:false,message:"Could not extract any items from the prompt. Please mention product, amount and GST details."});

    data.invoice_date=data.invoice_date||todayStr;
    data.place_of_supply=data.place_of_supply||compState||"";
    data.is_igst=!!data.is_igst;

    // Try to match an existing party
    const matched=partiesQ.rows.find(p=>p.name.toLowerCase().trim()===String(data.party_name||"").toLowerCase().trim())
      ||partiesQ.rows.find(p=>data.party_name&&p.name.toLowerCase().includes(String(data.party_name).toLowerCase().split(" ")[0]));
    data.party_id=matched?.id||"";
    data.matched_party_name=matched?.name||"";

    // Suggest next invoice number
    const countQ=await pool.query("SELECT COUNT(*) c FROM company_invoices WHERE company_id=$1 AND invoice_type=$2",[cid,invType]);
    const num=parseInt(countQ.rows[0].c)+1;
    data.invoice_no=`${invType==="SALES"?"SALES":"PUR"}-${String(num).padStart(4,'0')}`;

    res.json({success:true,data});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});


// ══════════════════════════════════════════════════════════════════════════
// SECURITY + ADMIN + OTP + SESSIONS + BACKUP — SCHEMA
// ══════════════════════════════════════════════════════════════════════════

// ── User security/admin columns ──
pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS login_count INTEGER DEFAULT 0`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER DEFAULT 0`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT false`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS last_backup_email_at TIMESTAMPTZ`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS backup_email_enabled BOOLEAN DEFAULT true`).catch(()=>{});

// ── OTP codes (login 2FA + verification) ──
pool.query(`CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  code TEXT NOT NULL, channel TEXT NOT NULL,
  purpose TEXT DEFAULT 'login',
  attempts INTEGER DEFAULT 0,
  verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

// ── Active sessions (per device/login) ──
pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  device_info TEXT, ip_address TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

// ── Audit log (security-relevant events) ──
pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL,
  details TEXT, ip_address TEXT, user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});
pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)`).catch(()=>{});
pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id)`).catch(()=>{});

// ══════════════════════════════════════════════════════════════════════════
// SECURITY HELPERS
// ══════════════════════════════════════════════════════════════════════════

// ── Simple in-memory rate limiter (no extra npm package needed) ──
// Tracks attempts per key (e.g. IP+email) in a sliding window.
const _rateBuckets = new Map();
function rateLimiter({windowMs=15*60*1000, max=10, keyFn}={}){
  return (req,res,next)=>{
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    let bucket = _rateBuckets.get(key);
    if(!bucket || now-bucket.start>windowMs){ bucket={start:now,count:0}; _rateBuckets.set(key,bucket); }
    bucket.count++;
    if(bucket.count>max){
      return res.status(429).json({success:false,message:"Too many attempts. Please try again after some time."});
    }
    next();
  };
}
// Periodic cleanup so the Map doesn't grow forever
setInterval(()=>{ const now=Date.now(); for(const[k,v] of _rateBuckets){ if(now-v.start>60*60*1000) _rateBuckets.delete(k); } },30*60*1000);

// ── Security response headers (helmet-style, no extra package needed) ──
function securityHeaders(req,res,next){
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("X-XSS-Protection","1; mode=block");
  res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
  if(process.env.NODE_ENV==="production")res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");
  next();
}

// ── Audit logging (never throws — logging failure must not break the request) ──
async function logAudit(userId,action,details,req){
  try{
    await pool.query("INSERT INTO audit_logs (id,user_id,action,details,ip_address,user_agent) VALUES ($1,$2,$3,$4,$5,$6)",
      [uuid(),userId||null,action,details?String(details).substring(0,500):null,req?.ip||null,req?.headers?.["user-agent"]?.substring(0,250)||null]);
  }catch(e){ /* never block on audit log failure */ }
}

// ── Issue a signed session: creates JWT with jti + DB session row + updates login stats ──
async function issueSession(user,req){
  const jti=uuid();
  const token=jwt.sign({id:user.id,name:user.name,email:user.email,firm_name:user.firm_name,role:user.role,jti},JWT,{expiresIn:"7d"});
  try{
    await pool.query("INSERT INTO user_sessions (id,user_id,device_info,ip_address) VALUES ($1,$2,$3,$4)",
      [jti,user.id,req?.headers?.["user-agent"]?.substring(0,250)||"Unknown device",req?.ip||null]);
    await pool.query("UPDATE users SET last_login_at=NOW(),last_active_at=NOW(),login_count=COALESCE(login_count,0)+1,failed_login_attempts=0,locked_until=NULL WHERE id=$1",[user.id]);
  }catch(e){ /* session tracking failure must not block login */ }
  return token;
}

// ── requireAdmin middleware (use AFTER auth) ──
async function requireAdmin(req,res,next){
  try{
    const r=await pool.query("SELECT is_admin FROM users WHERE id=$1",[req.user.id]);
    if(!r.rows[0]?.is_admin)return res.status(403).json({success:false,message:"Admin access required"});
    next();
  }catch(e){res.status(500).json({success:false,message:e.message});}
}

// ── OTP generation ──
function generateOTP(){ return String(Math.floor(100000+Math.random()*900000)); }

// ── Email sending (nodemailer, lazy-required so app still boots without it installed) ──
let _transporter=null;
function getMailer(){
  if(_transporter)return _transporter;
  if(!process.env.SMTP_HOST||!process.env.SMTP_USER||!process.env.SMTP_PASS)return null;
  try{
    const nodemailer=require("nodemailer");
    _transporter=nodemailer.createTransport({
      host:process.env.SMTP_HOST,
      port:parseInt(process.env.SMTP_PORT)||587,
      secure:(parseInt(process.env.SMTP_PORT)||587)===465,
      auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},
    });
    return _transporter;
  }catch(e){ console.error("nodemailer not installed — run: npm install nodemailer"); return null; }
}
async function sendEmail({to,subject,html,attachments}){
  const transporter=getMailer();
  if(!transporter)throw new Error("Email not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT in environment variables.");
  await transporter.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER,to,subject,html,attachments:attachments||[]});
}

// ── SMS sending via Fast2SMS (popular India SMS gateway, simple REST API) ──
function sendSMS({to,message}){
  return new Promise((resolve,reject)=>{
    if(!process.env.SMS_API_KEY)return reject(new Error("SMS not configured. Set SMS_API_KEY in environment variables (sign up at fast2sms.com)."));
    const postData=JSON.stringify({route:"q",message,language:"english",flash:0,numbers:String(to).replace(/\D/g,"").slice(-10)});
    const reqOpts={hostname:"www.fast2sms.com",path:"/dev/bulkV2",method:"POST",
      headers:{"authorization":process.env.SMS_API_KEY,"Content-Type":"application/json","Content-Length":Buffer.byteLength(postData)}};
    const r=https.request(reqOpts,resp=>{let data="";resp.on("data",c=>data+=c);resp.on("end",()=>{try{resolve(JSON.parse(data));}catch{resolve({raw:data});}});});
    r.on("error",reject);r.setTimeout(15000,()=>{r.destroy();reject(new Error("SMS gateway timeout"));});
    r.write(postData);r.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════
// SESSIONS, 2FA TOGGLE, HEARTBEAT
// ══════════════════════════════════════════════════════════════════════════

// ── Heartbeat — frontend pings this every few minutes to track "active" status ──
app.post("/api/auth/heartbeat", auth, async(req,res)=>{
  try{
    await pool.query("UPDATE users SET last_active_at=NOW() WHERE id=$1",[req.user.id]);
    if(req.user.jti)await pool.query("UPDATE user_sessions SET last_active_at=NOW() WHERE id=$1",[req.user.jti]).catch(()=>{});
    res.json({success:true});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── List my active sessions (devices logged in) ──
app.get("/api/auth/sessions", auth, async(req,res)=>{
  try{
    const r=await pool.query("SELECT id,device_info,ip_address,created_at,last_active_at,is_active FROM user_sessions WHERE user_id=$1 AND is_active=true ORDER BY last_active_at DESC",[req.user.id]);
    res.json({success:true,sessions:r.rows,current_session_id:req.user.jti||null});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Revoke a specific session (log that device out) ──
app.delete("/api/auth/sessions/:id", auth, async(req,res)=>{
  try{
    await pool.query("UPDATE user_sessions SET is_active=false WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);
    logAudit(req.user.id,"session_revoked","Session "+req.params.id,req);
    res.json({success:true,message:"Device logged out"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Revoke ALL other sessions (keep current) ──
app.post("/api/auth/sessions/revoke-others", auth, async(req,res)=>{
  try{
    if(!req.user.jti)return res.status(400).json({success:false,message:"Current session has no ID — please re-login first"});
    await pool.query("UPDATE user_sessions SET is_active=false WHERE user_id=$1 AND id!=$2",[req.user.id,req.user.jti]);
    logAudit(req.user.id,"sessions_revoke_others",null,req);
    res.json({success:true,message:"All other devices logged out"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Toggle 2FA (OTP on login) ──
app.post("/api/auth/toggle-2fa", auth, async(req,res)=>{
  try{
    const{enabled}=req.body;
    const user=await pool.query("SELECT phone,email FROM users WHERE id=$1",[req.user.id]);
    if(enabled&&!user.rows[0]?.phone){
      // 2FA still allowed with email-only — just warn
    }
    await pool.query("UPDATE users SET two_factor_enabled=$1 WHERE id=$2",[!!enabled,req.user.id]);
    logAudit(req.user.id,"2fa_toggled",`enabled=${!!enabled}`,req);
    res.json({success:true,two_factor_enabled:!!enabled});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Change password (requires current password) ──
app.post("/api/auth/change-password", auth, rateLimiter({windowMs:15*60*1000,max:8,keyFn:req=>"pwchange:"+req.user?.id}), async(req,res)=>{
  try{
    const{current_password,new_password}=req.body;
    if(!current_password||!new_password)return res.status(400).json({success:false,message:"Both passwords required"});
    if(new_password.length<8)return res.status(400).json({success:false,message:"New password must be at least 8 characters"});
    const u=await pool.query("SELECT password FROM users WHERE id=$1",[req.user.id]);
    const match=await bcrypt.compare(current_password,u.rows[0].password);
    if(!match)return res.status(401).json({success:false,message:"Current password is incorrect"});
    const hashed=await bcrypt.hash(new_password,12);
    await pool.query("UPDATE users SET password=$1 WHERE id=$2",[hashed,req.user.id]);
    await pool.query("UPDATE user_sessions SET is_active=false WHERE user_id=$1 AND id!=$2",[req.user.id,req.user.jti||"x"]);
    logAudit(req.user.id,"password_changed",null,req);
    res.json({success:true,message:"Password changed. Other devices have been logged out."});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Logout (revoke current session) ──
app.post("/api/auth/logout", auth, async(req,res)=>{
  try{
    if(req.user.jti)await pool.query("UPDATE user_sessions SET is_active=false WHERE id=$1",[req.user.jti]);
    logAudit(req.user.id,"logout",null,req);
    res.json({success:true});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══════════════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════════════════════════════════

// ── One-time self-promote to admin using a secret env var (ADMIN_SETUP_KEY) ──
// Set ADMIN_SETUP_KEY in your Render environment variables, call this once, then you can remove/rotate the key.
app.post("/api/admin/claim", auth, rateLimiter({windowMs:60*60*1000,max:5,keyFn:req=>"adminclaim:"+req.ip}), async(req,res)=>{
  try{
    const{secret}=req.body;
    if(!process.env.ADMIN_SETUP_KEY)return res.status(400).json({success:false,message:"ADMIN_SETUP_KEY not configured on server"});
    if(secret!==process.env.ADMIN_SETUP_KEY)return res.status(403).json({success:false,message:"Invalid setup key"});
    await pool.query("UPDATE users SET is_admin=true WHERE id=$1",[req.user.id]);
    logAudit(req.user.id,"admin_claimed",null,req);
    res.json({success:true,message:"✅ You are now an admin. Reload the app."});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.get("/api/admin/me", auth, async(req,res)=>{
  try{
    const r=await pool.query("SELECT is_admin FROM users WHERE id=$1",[req.user.id]);
    res.json({success:true,is_admin:!!r.rows[0]?.is_admin});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Dashboard stats ──
app.get("/api/admin/stats", auth, requireAdmin, async(req,res)=>{
  try{
    const total=await pool.query("SELECT COUNT(*) c FROM users");
    const active7=await pool.query("SELECT COUNT(*) c FROM users WHERE last_active_at>NOW()-interval '7 days'");
    const active30=await pool.query("SELECT COUNT(*) c FROM users WHERE last_active_at>NOW()-interval '30 days'");
    const newThisMonth=await pool.query("SELECT COUNT(*) c FROM users WHERE created_at>date_trunc('month',NOW())");
    const suspended=await pool.query("SELECT COUNT(*) c FROM users WHERE is_suspended=true");
    const totalCompanies=await pool.query("SELECT COUNT(*) c FROM companies");
    const totalVouchers=await pool.query("SELECT COUNT(*) c FROM vouchers");
    res.json({success:true,stats:{
      total_users:parseInt(total.rows[0].c),
      active_7d:parseInt(active7.rows[0].c),
      active_30d:parseInt(active30.rows[0].c),
      new_this_month:parseInt(newThisMonth.rows[0].c),
      suspended:parseInt(suspended.rows[0].c),
      total_companies:parseInt(totalCompanies.rows[0].c),
      total_vouchers:parseInt(totalVouchers.rows[0].c),
    }});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── List all users — name, email, phone, signup date, last active, days inactive ──
app.get("/api/admin/users", auth, requireAdmin, async(req,res)=>{
  try{
    const{search,status}=req.query;
    let q=`SELECT u.id,u.name,u.email,u.phone,u.firm_name,u.is_admin,u.is_suspended,u.created_at,u.last_login_at,u.last_active_at,u.login_count,u.two_factor_enabled,
      (SELECT COUNT(*) FROM companies c WHERE c.user_id=u.id) as company_count,
      (SELECT COUNT(*) FROM vouchers v WHERE v.user_id=u.id) as voucher_count,
      EXTRACT(DAY FROM NOW()-u.created_at)::int as days_since_signup,
      CASE WHEN u.last_active_at IS NULL THEN NULL ELSE EXTRACT(DAY FROM NOW()-u.last_active_at)::int END as days_since_active
      FROM users u WHERE 1=1`;
    const p=[];
    if(search){q+=` AND (u.name ILIKE $${p.length+1} OR u.email ILIKE $${p.length+1} OR u.phone ILIKE $${p.length+1})`;p.push(`%${search}%`);}
    if(status==="active")q+=" AND u.last_active_at>NOW()-interval '7 days'";
    if(status==="inactive")q+=" AND (u.last_active_at IS NULL OR u.last_active_at<=NOW()-interval '7 days')";
    if(status==="suspended")q+=" AND u.is_suspended=true";
    q+=" ORDER BY u.created_at DESC";
    const r=await pool.query(q,p);
    res.json({success:true,users:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Suspend / Unsuspend a user account ──
app.post("/api/admin/users/:id/suspend", auth, requireAdmin, async(req,res)=>{
  try{
    const{suspended}=req.body;
    await pool.query("UPDATE users SET is_suspended=$1 WHERE id=$2",[!!suspended,req.params.id]);
    if(suspended)await pool.query("UPDATE user_sessions SET is_active=false WHERE user_id=$1",[req.params.id]);
    logAudit(req.user.id,"admin_user_suspend",`user:${req.params.id} suspended:${!!suspended}`,req);
    res.json({success:true});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Recent audit log (security events across all users) ──
app.get("/api/admin/audit-logs", auth, requireAdmin, async(req,res)=>{
  try{
    const{user_id,action,limit}=req.query;
    let q="SELECT a.*,u.name as user_name,u.email as user_email FROM audit_logs a LEFT JOIN users u ON a.user_id=u.id WHERE 1=1";
    const p=[];
    if(user_id){q+=` AND a.user_id=$${p.length+1}`;p.push(user_id);}
    if(action){q+=` AND a.action=$${p.length+1}`;p.push(action);}
    q+=` ORDER BY a.created_at DESC LIMIT $${p.length+1}`;p.push(parseInt(limit)||200);
    const r=await pool.query(q,p);
    res.json({success:true,logs:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══════════════════════════════════════════════════════════════════════════
// AUTO BACKUP — EMAIL TO REGISTERED ADDRESS + DOWNLOAD-TO-COMPUTER REMINDER
// ══════════════════════════════════════════════════════════════════════════
// IMPORTANT (honest note): Browsers do NOT allow any website — including this one —
// to silently write files to a user's computer without their action. That is a
// deliberate browser security protection (same restriction every banking/SaaS site has).
// So "save to computer" works as a one-click download (no extra clicks needed beyond
// that single click), and is paired with a TRUE automatic channel: emailing the backup
// to the user's registered email on a schedule, which needs no action from the user at all.

async function buildBackupJSON(uid){
  const user = await pool.query("SELECT id,name,email,firm_name,frn,role FROM users WHERE id=$1",[uid]);
  const [clients, invoices, invoice_items, payments, products, stock_movements, notices, returns, reconciliation, challans, bank_txns, bank_imports, companies, groups, ledgers, vouchers, voucher_items, hsn_codes] = await Promise.all([
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
  const backup={
    backup_version:"2.0",app:"TaxPro GST",exported_at:new Date().toISOString(),
    exported_by:user.rows[0]?.email,firm_name:user.rows[0]?.firm_name,
    data:{clients:clients.rows,invoices:invoices.rows,invoice_items:invoice_items.rows,payments:payments.rows,products:products.rows,stock_movements:stock_movements.rows,notices:notices.rows,returns:returns.rows,reconciliation:reconciliation.rows,challans:challans.rows,bank_transactions:bank_txns.rows,bank_imports:bank_imports.rows,
      accounting:{companies:companies.rows,ledger_groups:groups.rows,ledgers:ledgers.rows,vouchers:vouchers.rows,voucher_items:voucher_items.rows},
      hsn_codes:hsn_codes.rows},
    stats:{clients:clients.rows.length,invoices:invoices.rows.length,products:products.rows.length,vouchers:vouchers.rows.length,bank_transactions:bank_txns.rows.length,total_records:clients.rows.length+invoices.rows.length+products.rows.length+vouchers.rows.length},
  };
  return {json:JSON.stringify(backup,null,2),firmName:user.rows[0]?.firm_name||"backup",email:user.rows[0]?.email,name:user.rows[0]?.name};
}

// ── On-demand: email me my backup right now ──
app.post("/api/backup/email-now", auth, rateLimiter({windowMs:60*60*1000,max:5,keyFn:req=>"backupmail:"+req.user?.id}), async(req,res)=>{
  try{
    const{json,firmName,email,name}=await buildBackupJSON(req.user.id);
    const filename=`taxpro_backup_${firmName.replace(/[^a-zA-Z0-9]/g,"_")}_${new Date().toISOString().split("T")[0]}.json`;
    await sendEmail({
      to:email,
      subject:`TaxPro GST — Your Data Backup (${new Date().toLocaleDateString("en-IN")})`,
      html:`<p>Hi ${name},</p><p>Attached is your complete TaxPro GST data backup as of ${new Date().toLocaleString("en-IN")}. Keep this file safe — it contains your accounting data, invoices, and ledgers.</p><p>— TaxPro GST</p>`,
      attachments:[{filename,content:json,contentType:"application/json"}],
    });
    await pool.query("UPDATE users SET last_backup_email_at=NOW() WHERE id=$1",[req.user.id]);
    logAudit(req.user.id,"backup_emailed","manual",req);
    res.json({success:true,message:`✅ Backup emailed to ${email}`});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Status: when was last email backup, is auto-backup enabled ──
app.get("/api/backup/status", auth, async(req,res)=>{
  try{
    const r=await pool.query("SELECT last_backup_email_at,backup_email_enabled,email FROM users WHERE id=$1",[req.user.id]);
    const row=r.rows[0]||{};
    const daysSince=row.last_backup_email_at?Math.floor((Date.now()-new Date(row.last_backup_email_at).getTime())/86400000):null;
    res.json({success:true,last_backup_email_at:row.last_backup_email_at,days_since:daysSince,backup_email_enabled:row.backup_email_enabled,email:row.email,smtp_configured:!!(process.env.SMTP_HOST&&process.env.SMTP_USER)});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Toggle weekly auto-backup emails ──
app.post("/api/backup/toggle-auto", auth, async(req,res)=>{
  try{
    const{enabled}=req.body;
    await pool.query("UPDATE users SET backup_email_enabled=$1 WHERE id=$2",[!!enabled,req.user.id]);
    res.json({success:true});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Background scheduler: every hour, check who is due for a weekly backup email ──
// (No extra cron package needed — a simple interval is enough for this app's scale.)
async function runWeeklyBackupSweep(){
  if(!process.env.SMTP_HOST||!process.env.SMTP_USER)return; // silently skip if email isn't configured
  try{
    const due=await pool.query(`SELECT id,email,name,firm_name FROM users
      WHERE backup_email_enabled=true AND is_suspended=false
      AND (last_backup_email_at IS NULL OR last_backup_email_at<NOW()-interval '7 days')
      LIMIT 20`); // small batches so one sweep never overloads SMTP
    for(const u of due.rows){
      try{
        const{json,firmName}=await buildBackupJSON(u.id);
        const filename=`taxpro_backup_${firmName.replace(/[^a-zA-Z0-9]/g,"_")}_${new Date().toISOString().split("T")[0]}.json`;
        await sendEmail({to:u.email,subject:"TaxPro GST — Weekly Auto Backup",
          html:`<p>Hi ${u.name},</p><p>Your weekly automatic backup is attached. This runs every 7 days automatically — no action needed from you.</p>`,
          attachments:[{filename,content:json,contentType:"application/json"}]});
        await pool.query("UPDATE users SET last_backup_email_at=NOW() WHERE id=$1",[u.id]);
        console.log(`✅ Auto-backup emailed to ${u.email}`);
      }catch(e){ console.error(`Auto-backup failed for ${u.email}:`,e.message); }
    }
  }catch(e){ console.error("Backup sweep error:",e.message); }
}
setInterval(runWeeklyBackupSweep, 60*60*1000); // check every hour
setTimeout(runWeeklyBackupSweep, 30*1000); // also run shortly after boot

// ══════════════════════════════════════════════════════════════════════════
// COMPOSITION (CMP-08, GSTR-4) + REGULAR ANNUAL RETURNS (GSTR-9, GSTR-9C)
// Table structures follow the formats notified under the GST Act / GST portal.
// ══════════════════════════════════════════════════════════════════════════

pool.query(`CREATE TABLE IF NOT EXISTS cmp08_returns (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT,
  fy TEXT, quarter TEXT,
  composition_rate REAL DEFAULT 1,
  outward_taxable REAL DEFAULT 0, outward_cgst REAL DEFAULT 0, outward_sgst REAL DEFAULT 0, outward_cess REAL DEFAULT 0,
  inward_rcm_taxable REAL DEFAULT 0, inward_rcm_igst REAL DEFAULT 0, inward_rcm_cgst REAL DEFAULT 0, inward_rcm_sgst REAL DEFAULT 0, inward_rcm_cess REAL DEFAULT 0,
  interest_cgst REAL DEFAULT 0, interest_sgst REAL DEFAULT 0, interest_igst REAL DEFAULT 0, interest_cess REAL DEFAULT 0,
  status TEXT DEFAULT 'draft', arn TEXT, filed_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id,fy,quarter)
)`).catch(()=>{});

// GSTR-4 (annual, composition) / GSTR-9 (annual, regular) / GSTR-9C (reconciliation)
// Large nested table structures are stored as JSONB (mirrors the official table numbering)
// to avoid an unmanageable number of columns; everything is still fully queryable.
pool.query(`CREATE TABLE IF NOT EXISTS gst_annual_returns (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT,
  return_type TEXT NOT NULL, -- 'GSTR4' | 'GSTR9' | 'GSTR9C'
  fy TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  status TEXT DEFAULT 'draft', arn TEXT, filed_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id,return_type,fy)
)`).catch(()=>{});

// ══════════════════════════════════════════════════════════════════════════
// CMP-08 — Statement-cum-challan for quarterly tax payment (Composition Dealers)
// Table 3 of FORM GST CMP-08 as notified
// ══════════════════════════════════════════════════════════════════════════

app.get("/api/accounting/companies/:cid/cmp08",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{fy}=req.query;
    let q="SELECT * FROM cmp08_returns WHERE company_id=$1 AND user_id=$2";const p=[cid,req.user.id];
    if(fy){q+=` AND fy=$${p.length+1}`;p.push(fy);}
    q+=" ORDER BY fy DESC, quarter ASC";
    const r=await pool.query(q,p);
    res.json({success:true,returns:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// Auto-fill outward turnover from SALES invoices for the quarter.
// Note: composition dealers cannot make inter-state outward supplies, so IGST is always 0 here (per GST law).
app.get("/api/accounting/companies/:cid/cmp08/auto-fill",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{fy,quarter}=req.query;
    if(!fy||!quarter)return res.status(400).json({success:false,message:"fy and quarter required"});
    const QUARTER_MONTHS={Q1:[4,5,6],Q2:[7,8,9],Q3:[10,11,12],Q4:[1,2,3]};
    const months=QUARTER_MONTHS[quarter];
    if(!months)return res.status(400).json({success:false,message:"quarter must be Q1-Q4"});
    const[fyStart]=fy.split("-");
    const years=quarter==="Q4"?[parseInt(fyStart)+1]:[parseInt(fyStart)];
    const r=await pool.query(
      `SELECT COALESCE(SUM(total_amount),0) turnover, COUNT(*) cnt FROM company_invoices
       WHERE company_id=$1 AND user_id=$2 AND invoice_type='SALES'
       AND EXTRACT(MONTH FROM invoice_date)=ANY($3::int[]) AND EXTRACT(YEAR FROM invoice_date)=ANY($4::int[])`,
      [cid,req.user.id,months,years]);
    res.json({success:true,outward_taxable:parseFloat(r.rows[0].turnover),invoice_count:parseInt(r.rows[0].cnt)});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/accounting/companies/:cid/cmp08",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const uid=req.user.id;const d=req.body;
    if(!d.fy||!d.quarter)return res.status(400).json({success:false,message:"FY and Quarter required"});
    const id=uuid();
    await pool.query(`INSERT INTO cmp08_returns
      (id,user_id,company_id,fy,quarter,composition_rate,outward_taxable,outward_cgst,outward_sgst,outward_cess,
       inward_rcm_taxable,inward_rcm_igst,inward_rcm_cgst,inward_rcm_sgst,inward_rcm_cess,
       interest_cgst,interest_sgst,interest_igst,interest_cess)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (company_id,fy,quarter) DO UPDATE SET
        composition_rate=$6,outward_taxable=$7,outward_cgst=$8,outward_sgst=$9,outward_cess=$10,
        inward_rcm_taxable=$11,inward_rcm_igst=$12,inward_rcm_cgst=$13,inward_rcm_sgst=$14,inward_rcm_cess=$15,
        interest_cgst=$16,interest_sgst=$17,interest_igst=$18,interest_cess=$19,updated_at=NOW()`,
      [id,uid,cid,d.fy,d.quarter,d.composition_rate||1,d.outward_taxable||0,d.outward_cgst||0,d.outward_sgst||0,d.outward_cess||0,
       d.inward_rcm_taxable||0,d.inward_rcm_igst||0,d.inward_rcm_cgst||0,d.inward_rcm_sgst||0,d.inward_rcm_cess||0,
       d.interest_cgst||0,d.interest_sgst||0,d.interest_igst||0,d.interest_cess||0]);
    const saved=await pool.query("SELECT * FROM cmp08_returns WHERE company_id=$1 AND fy=$2 AND quarter=$3",[cid,d.fy,d.quarter]);
    res.json({success:true,return:saved.rows[0]});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/accounting/companies/:cid/cmp08/:id/file",auth,async(req,res)=>{
  try{
    const{arn}=req.body;
    await pool.query("UPDATE cmp08_returns SET status='filed',arn=$1,filed_date=NOW() WHERE id=$2 AND company_id=$3 AND user_id=$4",
      [arn||`CMP08${Date.now()}`,req.params.id,req.params.cid,req.user.id]);
    res.json({success:true,message:"✅ Marked as filed"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.delete("/api/accounting/companies/:cid/cmp08/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM cmp08_returns WHERE id=$1 AND company_id=$2 AND user_id=$3",[req.params.id,req.params.cid,req.user.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══════════════════════════════════════════════════════════════════════════
// GSTR-4 — Annual Return for Composition Taxpayers
// Tables 4 (inward supplies), 5 (CMP-08 summary), 6 (rate-wise), 7 (TDS/TCS), 8 (tax/interest/late fee)
// ══════════════════════════════════════════════════════════════════════════

app.get("/api/accounting/companies/:cid/gstr4",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{fy}=req.query;
    if(!fy)return res.status(400).json({success:false,message:"fy required"});
    const r=await pool.query("SELECT * FROM gst_annual_returns WHERE company_id=$1 AND user_id=$2 AND return_type='GSTR4' AND fy=$3",[cid,req.user.id,fy]);
    res.json({success:true,return:r.rows[0]||null});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.get("/api/accounting/companies/:cid/gstr4/auto-fill",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{fy}=req.query;
    if(!fy)return res.status(400).json({success:false,message:"fy required"});
    const[fyStart,fyEndShort]=fy.split("-");
    const fyEnd=parseInt(fyStart)+1;

    // Table 5: aggregate CMP-08 filed during the year
    const cmp08=await pool.query("SELECT * FROM cmp08_returns WHERE company_id=$1 AND user_id=$2 AND fy=$3 ORDER BY quarter",[cid,req.user.id,fy]);
    const table5={};let t5total={taxable:0,cgst:0,sgst:0,cess:0};
    for(const q of cmp08.rows){
      table5[q.quarter]={taxable:parseFloat(q.outward_taxable),cgst:parseFloat(q.outward_cgst),sgst:parseFloat(q.outward_sgst),cess:parseFloat(q.outward_cess),status:q.status};
      t5total.taxable+=parseFloat(q.outward_taxable);t5total.cgst+=parseFloat(q.outward_cgst);t5total.sgst+=parseFloat(q.outward_sgst);t5total.cess+=parseFloat(q.outward_cess);
    }

    // Table 4A: inward supplies from registered suppliers, GSTIN-wise (from PURCHASE invoices in the FY)
    const inward=await pool.query(
      `SELECT party_name,COALESCE((SELECT gstin FROM ledgers WHERE id=ci.party_id),'') as gstin,
        COUNT(*) cnt, SUM(taxable_amount) taxable, SUM(total_tax) tax
       FROM company_invoices ci WHERE company_id=$1 AND user_id=$2 AND invoice_type='PURCHASE'
       AND invoice_date>=$3 AND invoice_date<$4
       GROUP BY party_name,ci.party_id ORDER BY taxable DESC`,
      [cid,req.user.id,`${fyStart}-04-01`,`${fyEnd}-04-01`]);

    res.json({success:true,table5,table5_total:t5total,table4a:inward.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/accounting/companies/:cid/gstr4",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const uid=req.user.id;const{fy,data}=req.body;
    if(!fy)return res.status(400).json({success:false,message:"fy required"});
    const id=uuid();
    await pool.query(`INSERT INTO gst_annual_returns (id,user_id,company_id,return_type,fy,data) VALUES ($1,$2,$3,'GSTR4',$4,$5)
      ON CONFLICT (company_id,return_type,fy) DO UPDATE SET data=$5,updated_at=NOW()`,
      [id,uid,cid,fy,JSON.stringify(data||{})]);
    res.json({success:true,message:"✅ GSTR-4 saved"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/accounting/companies/:cid/gstr4/file",auth,async(req,res)=>{
  try{
    const{fy,arn}=req.body;
    await pool.query("UPDATE gst_annual_returns SET status='filed',arn=$1,filed_date=NOW() WHERE company_id=$2 AND user_id=$3 AND return_type='GSTR4' AND fy=$4",
      [arn||`GSTR4${Date.now()}`,req.params.cid,req.user.id,fy]);
    res.json({success:true,message:"✅ Marked as filed"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══════════════════════════════════════════════════════════════════════════
// GSTR-9 — Annual Return for Regular Taxpayers
// Full official table structure: Part II (4,5), Part III (6,7,8), Part IV (9),
// Part V (10-13), Part VI (14-19)
// ══════════════════════════════════════════════════════════════════════════

app.get("/api/accounting/companies/:cid/gstr9",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{fy}=req.query;
    if(!fy)return res.status(400).json({success:false,message:"fy required"});
    const r=await pool.query("SELECT * FROM gst_annual_returns WHERE company_id=$1 AND user_id=$2 AND return_type='GSTR9' AND fy=$3",[cid,req.user.id,fy]);
    res.json({success:true,return:r.rows[0]||null});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.get("/api/accounting/companies/:cid/gstr9/auto-fill",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{fy}=req.query;
    if(!fy)return res.status(400).json({success:false,message:"fy required"});
    const[fyStart]=fy.split("-");
    const from=`${fyStart}-04-01`,to=`${parseInt(fyStart)+1}-04-01`;

    // ── Table 4: outward supplies, split B2B (party has GSTIN) vs B2C ──
    const sales=await pool.query(
      `SELECT ci.*, COALESCE((SELECT gstin FROM ledgers WHERE id=ci.party_id),'') as party_gstin
       FROM company_invoices ci WHERE company_id=$1 AND user_id=$2 AND invoice_type='SALES'
       AND invoice_date>=$3 AND invoice_date<$4`,[cid,req.user.id,from,to]);
    let b2b={taxable:0,igst:0,cgst:0,sgst:0,cess:0},b2c={taxable:0,igst:0,cgst:0,sgst:0,cess:0};
    for(const inv of sales.rows){
      const bucket=inv.party_gstin?b2b:b2c;
      bucket.taxable+=parseFloat(inv.taxable_amount||0);
      if(inv.is_igst)bucket.igst+=parseFloat(inv.total_tax||0);
      else{bucket.cgst+=parseFloat(inv.total_tax||0)/2;bucket.sgst+=parseFloat(inv.total_tax||0)/2;}
    }
    const outward_total_taxable=b2b.taxable+b2c.taxable;
    const outward_total_tax=b2b.igst+b2b.cgst+b2b.sgst+b2c.igst+b2c.cgst+b2c.sgst;

    // ── Table 6B: ITC on inward (PURCHASE) supplies ──
    const purchases=await pool.query(
      `SELECT COALESCE(SUM(taxable_amount),0) taxable, COALESCE(SUM(CASE WHEN is_igst THEN total_tax ELSE 0 END),0) igst,
       COALESCE(SUM(CASE WHEN NOT is_igst THEN total_tax/2 ELSE 0 END),0) half
       FROM company_invoices WHERE company_id=$1 AND user_id=$2 AND invoice_type='PURCHASE' AND invoice_date>=$3 AND invoice_date<$4`,
      [cid,req.user.id,from,to]);
    const p=purchases.rows[0];

    // ── Table 9: tax paid — from GST payable/input ledgers' net movement during the FY ──
    const taxLedgers=await pool.query(
      `SELECT l.name, COALESCE(SUM(vi.dr_amount-vi.cr_amount),0) net
       FROM ledgers l JOIN voucher_items vi ON vi.ledger_id=l.id JOIN vouchers v ON vi.voucher_id=v.id
       WHERE l.company_id=$1 AND l.user_id=$2 AND v.date>=$3 AND v.date<$4 AND v.is_cancelled=false
       AND (l.name ILIKE '%CGST%' OR l.name ILIKE '%SGST%' OR l.name ILIKE '%IGST%')
       GROUP BY l.name`,[cid,req.user.id,from,to]);

    // ── Table 17/18: HSN-wise summary from invoice line items (where HSN was captured) ──
    const allInvoices=await pool.query(`SELECT invoice_type,items FROM company_invoices WHERE company_id=$1 AND user_id=$2 AND invoice_date>=$3 AND invoice_date<$4`,[cid,req.user.id,from,to]);
    const hsnOut={},hsnIn={};
    for(const inv of allInvoices.rows){
      const items=Array.isArray(inv.items)?inv.items:(typeof inv.items==="string"?JSON.parse(inv.items||"[]"):[]);
      const bucket=inv.invoice_type==="SALES"?hsnOut:hsnIn;
      for(const it of items){
        const hsn=it.hsn_sac||"N/A";
        if(!bucket[hsn])bucket[hsn]={hsn,description:it.name||"",uqc:it.unit||"PCS",quantity:0,taxable_value:0,tax:0};
        const qty=parseFloat(it.qty)||0,rate=parseFloat(it.rate)||0,gst=parseFloat(it.gst_rate)||0;
        const amt=qty*rate;
        bucket[hsn].quantity+=qty;bucket[hsn].taxable_value+=amt;bucket[hsn].tax+=amt*gst/100;
      }
    }

    res.json({success:true,
      table4:{b2b,b2c,outward_total_taxable,outward_total_tax},
      table6b:{taxable:parseFloat(p.taxable),igst:parseFloat(p.igst),cgst:parseFloat(p.half),sgst:parseFloat(p.half)},
      table9_ledgers:taxLedgers.rows,
      table17_hsn_outward:Object.values(hsnOut),
      table18_hsn_inward:Object.values(hsnIn),
      invoice_count:{sales:sales.rows.length,purchase:allInvoices.rows.filter(i=>i.invoice_type==="PURCHASE").length},
    });
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/accounting/companies/:cid/gstr9",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const uid=req.user.id;const{fy,data}=req.body;
    if(!fy)return res.status(400).json({success:false,message:"fy required"});
    const id=uuid();
    await pool.query(`INSERT INTO gst_annual_returns (id,user_id,company_id,return_type,fy,data) VALUES ($1,$2,$3,'GSTR9',$4,$5)
      ON CONFLICT (company_id,return_type,fy) DO UPDATE SET data=$5,updated_at=NOW()`,
      [id,uid,cid,fy,JSON.stringify(data||{})]);
    res.json({success:true,message:"✅ GSTR-9 saved"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/accounting/companies/:cid/gstr9/file",auth,async(req,res)=>{
  try{
    const{fy,arn}=req.body;
    await pool.query("UPDATE gst_annual_returns SET status='filed',arn=$1,filed_date=NOW() WHERE company_id=$2 AND user_id=$3 AND return_type='GSTR9' AND fy=$4",
      [arn||`GSTR9${Date.now()}`,req.params.cid,req.user.id,fy]);
    res.json({success:true,message:"✅ Marked as filed"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══════════════════════════════════════════════════════════════════════════
// GSTR-9C — Reconciliation Statement (Audited turnover/tax/ITC vs Annual Return)
// Part II (Table 5-8 turnover recon), Part III (Table 9-11 tax recon),
// Part IV (Table 12-16 ITC recon), Part V (auditor recommendation), Certification
// ══════════════════════════════════════════════════════════════════════════

app.get("/api/accounting/companies/:cid/gstr9c",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{fy}=req.query;
    if(!fy)return res.status(400).json({success:false,message:"fy required"});
    const r=await pool.query("SELECT * FROM gst_annual_returns WHERE company_id=$1 AND user_id=$2 AND return_type='GSTR9C' AND fy=$3",[cid,req.user.id,fy]);
    res.json({success:true,return:r.rows[0]||null});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// Pulls the figures GSTR-9C must reconcile AGAINST — i.e. what was declared in GSTR-9 for the same FY.
app.get("/api/accounting/companies/:cid/gstr9c/auto-fill",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{fy}=req.query;
    if(!fy)return res.status(400).json({success:false,message:"fy required"});
    const gstr9=await pool.query("SELECT data FROM gst_annual_returns WHERE company_id=$1 AND user_id=$2 AND return_type='GSTR9' AND fy=$3",[cid,req.user.id,fy]);
    if(!gstr9.rows[0])return res.json({success:true,gstr9_found:false,message:"File GSTR-9 for this FY first — GSTR-9C reconciles against it."});
    const d=gstr9.rows[0].data||{};
    // turnover declared in GSTR-9 (table 5N equivalent — using table4 outward total as proxy from our simplified table4)
    const turnover_as_per_gstr9 = parseFloat(d?.table4?.outward_total_taxable||0) + parseFloat(d?.table5?.exempted?.taxable||0) + parseFloat(d?.table5?.nil_rated?.taxable||0);
    const taxable_turnover_gstr9 = parseFloat(d?.table4?.outward_total_taxable||0);
    const tax_paid_gstr9 = parseFloat(d?.table9?.tax_paid_cash?.igst||0)+parseFloat(d?.table9?.tax_paid_cash?.cgst||0)+parseFloat(d?.table9?.tax_paid_cash?.sgst||0)
      +parseFloat(d?.table9?.tax_paid_itc?.igst||0)+parseFloat(d?.table9?.tax_paid_itc?.cgst||0)+parseFloat(d?.table9?.tax_paid_itc?.sgst||0);
    const itc_claimed_gstr9 = parseFloat(d?.table6?.itc_total_availed||0) - parseFloat(d?.table7?.total_reversed||0);
    res.json({success:true,gstr9_found:true,turnover_as_per_gstr9,taxable_turnover_gstr9,tax_paid_gstr9,itc_claimed_gstr9});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/accounting/companies/:cid/gstr9c",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const uid=req.user.id;const{fy,data}=req.body;
    if(!fy)return res.status(400).json({success:false,message:"fy required"});
    const id=uuid();
    await pool.query(`INSERT INTO gst_annual_returns (id,user_id,company_id,return_type,fy,data) VALUES ($1,$2,$3,'GSTR9C',$4,$5)
      ON CONFLICT (company_id,return_type,fy) DO UPDATE SET data=$5,updated_at=NOW()`,
      [id,uid,cid,fy,JSON.stringify(data||{})]);
    res.json({success:true,message:"✅ GSTR-9C saved"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/accounting/companies/:cid/gstr9c/file",auth,async(req,res)=>{
  try{
    const{fy,arn}=req.body;
    await pool.query("UPDATE gst_annual_returns SET status='filed',arn=$1,filed_date=NOW() WHERE company_id=$2 AND user_id=$3 AND return_type='GSTR9C' AND fy=$4",
      [arn||`GSTR9C${Date.now()}`,req.params.cid,req.user.id,fy]);
    res.json({success:true,message:"✅ Marked as filed"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══════════════════════════════════════════════════════════════════════════
// LEGAL REFERENCE LIBRARY (GST Act / Rules / Circulars / Case Law)
// + GROUNDED AI NOTICE REPLY GENERATOR
// ══════════════════════════════════════════════════════════════════════════
// IMPORTANT DESIGN PRINCIPLE: the AI is NEVER allowed to invent legal citations.
// It only cites documents that exist in `legal_references` (uploaded by the CA).
// If nothing relevant is found, it says so explicitly instead of fabricating one.

pool.query(`CREATE TABLE IF NOT EXISTS legal_references (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  ref_type TEXT NOT NULL, -- 'act_section' | 'rule' | 'circular' | 'notification' | 'case_law'
  act_name TEXT,          -- 'CGST Act' | 'SGST Act' | 'IGST Act' | 'CGST Rules' | etc
  reference_no TEXT,      -- e.g. 'Section 73', 'Rule 142', 'Circular No. 31/05/2018-GST'
  title TEXT,
  full_text TEXT,
  court_name TEXT, case_citation TEXT, case_date DATE,  -- only for case_law
  tags TEXT,               -- comma-separated keywords, helps matching
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});
pool.query(`CREATE INDEX IF NOT EXISTS idx_legal_user ON legal_references(user_id)`).catch(()=>{});

pool.query(`ALTER TABLE IF EXISTS notices ADD COLUMN IF NOT EXISTS notice_text TEXT`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS notices ADD COLUMN IF NOT EXISTS ai_reply_draft TEXT`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS notices ADD COLUMN IF NOT EXISTS references_used JSONB`).catch(()=>{});

// ── Add a legal reference (paste text directly) — ADMIN ONLY. Visible to every client (read-only). ──
app.post("/api/legal/references",auth,requireAdmin,async(req,res)=>{
  try{
    const{ref_type,act_name,reference_no,title,full_text,court_name,case_citation,case_date,tags}=req.body;
    if(!ref_type||!title||!full_text)return res.status(400).json({success:false,message:"Type, title and text are required"});
    const id=uuid();
    await pool.query(`INSERT INTO legal_references (id,user_id,ref_type,act_name,reference_no,title,full_text,court_name,case_citation,case_date,tags)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id,req.user.id,ref_type,act_name||null,reference_no||null,title,full_text,court_name||null,case_citation||null,case_date||null,tags||null]);
    res.json({success:true,id});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Upload a PDF — auto-extracts text so you don't have to re-type the whole judgment/section. ADMIN ONLY. ──
app.post("/api/legal/references/upload",auth,requireAdmin,upload.single("file"),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({success:false,message:"File required"});
    const{ref_type,act_name,reference_no,title,court_name,case_citation,case_date,tags}=req.body;
    if(!ref_type||!title)return res.status(400).json({success:false,message:"Type and title are required"});
    let text="";
    try{const pp=require("pdf-parse");const data=await pp(req.file.buffer);text=data.text;}
    catch(e){return res.status(400).json({success:false,message:"Could not extract text from this PDF. Try pasting the text manually instead."});}
    if(!text||text.trim().length<20)return res.status(400).json({success:false,message:"No readable text found in PDF (it may be a scanned image) — paste the text manually instead."});
    const id=uuid();
    await pool.query(`INSERT INTO legal_references (id,user_id,ref_type,act_name,reference_no,title,full_text,court_name,case_citation,case_date,tags)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id,req.user.id,ref_type,act_name||null,reference_no||null,title,text,court_name||null,case_citation||null,case_date||null,tags||null]);
    res.json({success:true,id,extracted_length:text.length,message:`✅ Extracted ${text.length} characters and saved`});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// GLOBAL read — every logged-in client can browse/search the library. Only admin can write to it (routes above).
app.get("/api/legal/references",auth,async(req,res)=>{
  try{
    const{search,ref_type}=req.query;
    let q="SELECT id,ref_type,act_name,reference_no,title,court_name,case_citation,case_date,tags,LENGTH(full_text) as text_length,created_at FROM legal_references WHERE 1=1";
    const p=[];
    if(ref_type){q+=` AND ref_type=$${p.length+1}`;p.push(ref_type);}
    if(search){q+=` AND (title ILIKE $${p.length+1} OR reference_no ILIKE $${p.length+1} OR tags ILIKE $${p.length+1} OR full_text ILIKE $${p.length+1})`;p.push(`%${search}%`);}
    q+=" ORDER BY created_at DESC";
    const r=await pool.query(q,p);
    const isAdminQ=await pool.query("SELECT is_admin FROM users WHERE id=$1",[req.user.id]);
    res.json({success:true,references:r.rows,is_admin:!!isAdminQ.rows[0]?.is_admin});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.get("/api/legal/references/:id",auth,async(req,res)=>{
  try{
    const r=await pool.query("SELECT * FROM legal_references WHERE id=$1",[req.params.id]);
    if(!r.rows[0])return res.status(404).json({success:false,message:"Not found"});
    res.json({success:true,reference:r.rows[0]});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.delete("/api/legal/references/:id",auth,requireAdmin,async(req,res)=>{
  try{await pool.query("DELETE FROM legal_references WHERE id=$1",[req.params.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Search the legal library for passages relevant to a notice's text ──
// Simple but effective: extract Section/Rule numbers + keywords, then rank candidate
// references by how many of those terms they actually contain.
function extractLegalKeywords(text){
  const keywords=new Set();
  const t=(text||"").toUpperCase();
  // Section / Rule references e.g. "SECTION 73", "SEC. 16", "RULE 142"
  for(const m of t.matchAll(/\b(?:SECTION|SEC\.?)\s*(\d+[A-Z]?)\b/g))keywords.add(`SECTION ${m[1]}`);
  for(const m of t.matchAll(/\bRULE\s*(\d+[A-Z]?)\b/g))keywords.add(`RULE ${m[1]}`);
  // common GST topic words worth matching on
  const topics=["ITC","INPUT TAX CREDIT","E-WAY BILL","RECONCILIATION","MISMATCH","LATE FEE","INTEREST","PENALTY","REVERSE CHARGE","RCM","REFUND","CANCELLATION","REGISTRATION","SCN","SHOW CAUSE","ASSESSMENT","AUDIT","DEMAND","FRAUD","SUPPRESSION","NON-FILING","ANNUAL RETURN","COMPOSITION","E-INVOICE","TDS","TCS"];
  for(const top of topics)if(t.includes(top))keywords.add(top);
  return[...keywords];
}

async function searchLegalReferences(text,limit=8){
  // Searches the GLOBAL admin-maintained library — same references available to every client.
  const keywords=extractLegalKeywords(text);
  if(keywords.length===0)return[];
  const all=await pool.query("SELECT * FROM legal_references");
  const scored=all.rows.map(r=>{
    const haystack=`${r.title} ${r.reference_no||""} ${r.tags||""} ${r.full_text||""}`.toUpperCase();
    let score=0;
    for(const k of keywords)if(haystack.includes(k))score++;
    return{...r,score};
  }).filter(r=>r.score>0).sort((a,b)=>b.score-a.score).slice(0,limit);
  return scored;
}

// ── Scan an uploaded notice (PDF or image) → extract structured details ──
app.post("/api/notices/:id/scan-notice",auth,upload.single("file"),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({success:false,message:"File required"});
    let extractedText="";
    if(req.file.mimetype==="application/pdf"){
      try{const pp=require("pdf-parse");const data=await pp(req.file.buffer);extractedText=data.text;}catch(e){}
    }
    let aiSummary=null;
    if(extractedText&&extractedText.trim().length>20){
      // Pure text PDF — ask AI to structure it
      const reply=await groqChat({model:"llama-3.1-8b-instant",messages:[
        {role:"system",content:`Extract structured details from this GST notice text. Return ONLY JSON: {"notice_type":"e.g. SCN under Section 73","section_invoked":"e.g. Section 73 of CGST Act","issue_summary":"1-2 sentence summary of the allegation/issue","demand_amount":number,"due_date":"YYYY-MM-DD or empty string","key_points":["point1","point2"]}`},
        {role:"user",content:extractedText.substring(0,4000)}
      ],temperature:0.1,max_tokens:600});
      const m=reply.match(/\{[\s\S]*\}/);if(m)try{aiSummary=JSON.parse(m[0]);}catch(e){}
    }else if(req.file.mimetype.startsWith("image/")){
      // Scanned/photo notice — use vision model
      const base64=req.file.buffer.toString("base64");
      const reply=await groqChat({model:"meta-llama/llama-4-scout-17b-16e-instruct",messages:[{role:"user",content:[
        {type:"text",text:`This is a photo of an Indian GST notice. Read all visible text, then return ONLY JSON: {"notice_type":"...","section_invoked":"...","issue_summary":"...","demand_amount":number,"due_date":"YYYY-MM-DD or empty string","key_points":["..."],"full_text":"all text you can read from the notice"}`},
        {type:"image_url",image_url:{url:`data:${req.file.mimetype};base64,${base64}`}}
      ]}],temperature:0.1,max_tokens:1200});
      const m=reply.match(/\{[\s\S]*\}/);if(m)try{aiSummary=JSON.parse(m[0]);if(aiSummary.full_text)extractedText=aiSummary.full_text;}catch(e){}
    }
    if(!extractedText&&!aiSummary)return res.status(400).json({success:false,message:"Could not read this file. Try a clearer scan or paste the notice text manually."});

    await pool.query("UPDATE notices SET notice_text=$1 WHERE id=$2 AND user_id=$3",[extractedText||JSON.stringify(aiSummary),req.params.id,req.user.id]);
    res.json({success:true,notice_text:extractedText,summary:aiSummary});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Generate a grounded AI reply — cites ONLY references found in the user's own library ──
app.post("/api/notices/:id/generate-grounded-reply",auth,async(req,res)=>{
  try{
    const{id}=req.params;
    const noticeRow=await pool.query(`SELECT n.*,
        COALESCE(cl.name,co.name) as client_name, COALESCE(cl.gstin,co.gstin) as gstin
      FROM notices n
      LEFT JOIN clients cl ON n.client_id=cl.id
      LEFT JOIN companies co ON n.company_id=co.id
      WHERE n.id=$1 AND n.user_id=$2`,[id,req.user.id]);
    const notice=noticeRow.rows[0];
    if(!notice)return res.status(404).json({success:false,message:"Notice not found"});

    const searchText=`${notice.type} ${notice.description||""} ${notice.notice_text||""}`;
    const matches=await searchLegalReferences(searchText,8);

    let referenceBlock="";
    if(matches.length>0){
      referenceBlock=matches.map((r,i)=>`[REF-${i+1}] ${r.ref_type==="case_law"?`${r.title} (${r.court_name||""}, ${r.case_citation||""})`:`${r.act_name||""} ${r.reference_no||""} — ${r.title}`}\n${(r.full_text||"").substring(0,1200)}`).join("\n\n---\n\n");
    }

    const systemPrompt=matches.length>0
      ? `You are drafting a formal reply to a GST notice on behalf of an Indian Chartered Accountant's client. You have been given a library of legal references below (Act sections, Rules, Circulars, or Case Law actually uploaded by the CA). 

CRITICAL RULES — NEVER VIOLATE THESE:
1. You may ONLY cite a reference if it appears in the "AVAILABLE REFERENCES" block below. Cite it using its exact [REF-n] tag plus its title/reference number.
2. NEVER invent, guess, or recall from memory any section number, rule number, circular number, or case name/citation that is not explicitly given to you below. If you are not 100% certain a citation is in the provided list, do not use it.
3. If the available references don't fully cover the issue, say so explicitly in the reply (e.g. "no directly applicable precedent was found in the reference library for this specific issue") rather than filling the gap with an invented citation.
4. Write in formal legal/professional Indian GST correspondence style, addressed to the relevant GST officer, structured with: Subject, reference to notice, point-wise rebuttal/explanation citing the references where relevant, and a concluding prayer/request.

AVAILABLE REFERENCES (cite ONLY from these):\n${referenceBlock}`
      : `You are drafting a formal reply to a GST notice. No matching legal references were found in the CA's reference library for this notice's topic.
CRITICAL: Do NOT cite any specific section number, rule number, circular, or case law from memory — you have no verified references for this notice. Write a general, professionally-worded reply addressing the notice on factual/procedural grounds only (e.g. requesting more time, stating facts, requesting personal hearing), and explicitly note at the end: "No specific case law or circular references were available in the reference library for this notice — recommend the CA add relevant Act sections, rules, or precedents before finalizing, and have this draft reviewed by a qualified professional before submission."`;

    const userPrompt=`Notice details:
Client: ${notice.client_name} (GSTIN: ${notice.gstin})
Notice Type: ${notice.type}
Reference No: ${notice.ref_no}
Amount: ₹${notice.amount}
Description/Issue: ${notice.description||"Not provided"}
${notice.notice_text?`\nFull notice text (extracted):\n${notice.notice_text.substring(0,3000)}`:""}

Draft the formal reply now.`;

    const reply=await groqChat({model:"llama-3.1-8b-instant",messages:[{role:"system",content:systemPrompt},{role:"user",content:userPrompt}],temperature:0.2,max_tokens:1800});

    const referencesUsed=matches.map(m=>({id:m.id,ref_type:m.ref_type,title:m.title,reference_no:m.reference_no,act_name:m.act_name,court_name:m.court_name,case_citation:m.case_citation}));
    await pool.query("UPDATE notices SET ai_reply_draft=$1,references_used=$2 WHERE id=$3",[reply,JSON.stringify(referencesUsed),id]);

    res.json({success:true,reply,references_used:referencesUsed,grounded:matches.length>0,
      disclaimer:"This is an AI-drafted starting point. Citations are limited to documents you uploaded to your Legal Library — always have a qualified professional review before filing any response with the department."});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Download the generated reply as a Word-compatible document ──
app.get("/api/notices/:id/reply/download",auth,async(req,res)=>{
  try{
    const r=await pool.query(`SELECT n.*,
        COALESCE(cl.name,co.name) as client_name, COALESCE(cl.gstin,co.gstin) as gstin, COALESCE(cl.state,co.state) as state
      FROM notices n
      LEFT JOIN clients cl ON n.client_id=cl.id
      LEFT JOIN companies co ON n.company_id=co.id
      WHERE n.id=$1 AND n.user_id=$2`,[req.params.id,req.user.id]);
    const notice=r.rows[0];
    if(!notice)return res.status(404).json({success:false,message:"Not found"});
    const replyText=notice.ai_reply_draft||notice.reply_text||"";
    if(!replyText)return res.status(400).json({success:false,message:"No reply has been drafted yet"});
    const refs=notice.references_used?(typeof notice.references_used==="string"?JSON.parse(notice.references_used):notice.references_used):[];

    const bodyHtml=replyText.split(/\n\n+/).map(p=>`<p style="margin:0 0 12px 0;text-align:justify;">${p.replace(/\n/g,"<br/>")}</p>`).join("");
    const refsHtml=refs.length>0?`<h3>References Cited</h3><ol>${refs.map(rf=>`<li>${rf.ref_type==="case_law"?`${rf.title} — ${rf.court_name||""} ${rf.case_citation||""}`:`${rf.act_name||""} ${rf.reference_no||""} — ${rf.title}`}</li>`).join("")}</ol>`:"";

    const html=`<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta charset="UTF-8"><title>Reply to Notice ${notice.ref_no}</title>
<style>body{font-family:'Times New Roman',serif;font-size:13px;line-height:1.6;margin:40px;}h2{text-align:center}.meta{margin-bottom:20px}</style>
</head><body>
<h2>REPLY TO GST NOTICE</h2>
<div class="meta">
<p><b>To,</b><br/>The Proper Officer<br/>GST Department</p>
<p><b>Subject:</b> Reply to Notice Ref No. ${notice.ref_no} dated ${notice.issued_date}</p>
<p><b>Taxpayer:</b> ${notice.client_name} &nbsp;&nbsp; <b>GSTIN:</b> ${notice.gstin}</p>
</div>
${bodyHtml}
${refsHtml}
<br/><br/>
<p>Yours faithfully,<br/>For ${notice.client_name}</p>
<p style="font-size:10px;color:#888;margin-top:40px;">Drafted with AI assistance — reviewed and finalized by a qualified professional before submission.</p>
</body></html>`;

    res.setHeader("Content-Type","application/msword");
    res.setHeader("Content-Disposition",`attachment; filename="Reply_${notice.ref_no.replace(/[^a-zA-Z0-9]/g,"_")}.doc"`);
    res.send(html);
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══════════════════════════════════════════════════════════════════════════
// COMPANY-SCOPED NOTICES (V5 architecture — notice belongs to the active
// company directly, no separate "GST Client" row required)
// ══════════════════════════════════════════════════════════════════════════
pool.query(`ALTER TABLE IF EXISTS notices ALTER COLUMN client_id DROP NOT NULL`).catch(()=>{});
pool.query(`ALTER TABLE IF EXISTS notices ADD COLUMN IF NOT EXISTS company_id TEXT`).catch(()=>{});

app.get("/api/accounting/companies/:cid/notices",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{status}=req.query;
    let q="SELECT * FROM notices WHERE company_id=$1 AND user_id=$2";const p=[cid,req.user.id];
    if(status&&status!=="all"){q+=` AND status=$${p.length+1}`;p.push(status);}
    q+=" ORDER BY due_date ASC";
    const r=await pool.query(q,p);
    res.json({success:true,notices:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post("/api/accounting/companies/:cid/notices",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{ref_no,type,issued_date,due_date,amount,priority,description}=req.body;
    if(!ref_no||!type)return res.status(400).json({success:false,message:"Reference number and type are required"});
    const todayStr=new Date().toISOString().split("T")[0];
    const status=due_date&&new Date(due_date)<new Date(todayStr)?"overdue":"pending";
    const id=uuid();
    await pool.query("INSERT INTO notices (id,user_id,company_id,ref_no,type,issued_date,due_date,amount,status,priority,description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [id,req.user.id,cid,ref_no,type,issued_date||todayStr,due_date||todayStr,parseFloat(amount)||0,status,priority||"medium",description||null]);
    const r=await pool.query("SELECT * FROM notices WHERE id=$1",[id]);
    res.status(201).json({success:true,notice:r.rows[0]});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.patch("/api/accounting/companies/:cid/notices/:id/status",auth,async(req,res)=>{
  try{await pool.query("UPDATE notices SET status=$1,updated_at=NOW() WHERE id=$2 AND company_id=$3 AND user_id=$4",[req.body.status,req.params.id,req.params.cid,req.user.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

app.delete("/api/accounting/companies/:cid/notices/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM notices WHERE id=$1 AND company_id=$2 AND user_id=$3",[req.params.id,req.params.cid,req.user.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

app.get("/api/accounting/companies/:cid/notices/:id",auth,async(req,res)=>{
  try{
    const r=await pool.query("SELECT * FROM notices WHERE id=$1 AND company_id=$2 AND user_id=$3",[req.params.id,req.params.cid,req.user.id]);
    if(!r.rows[0])return res.status(404).json({success:false,message:"Not found"});
    res.json({success:true,notice:r.rows[0]});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══════════════════════════════════════════════════════════════════════════
// GSTR-2B / 2A IMPORT + RECONCILIATION + GSTR-10
// ══════════════════════════════════════════════════════════════════════════

pool.query(`CREATE TABLE IF NOT EXISTS gstr2_imports (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT,
  source TEXT DEFAULT '2B', period TEXT, fy TEXT,
  supplier_gstin TEXT, supplier_name TEXT,
  invoice_no TEXT, invoice_date DATE,
  invoice_type TEXT DEFAULT 'B2B',
  taxable_value REAL DEFAULT 0,
  igst REAL DEFAULT 0, cgst REAL DEFAULT 0, sgst REAL DEFAULT 0, cess REAL DEFAULT 0,
  place_of_supply TEXT,
  recon_status TEXT DEFAULT 'unmatched', -- matched | mismatch | unmatched | extra
  matched_invoice_id TEXT,
  mismatch_fields TEXT, -- comma-separated field names that differ
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});
pool.query(`CREATE INDEX IF NOT EXISTS idx_gstr2_cid ON gstr2_imports(company_id,period)`).catch(()=>{});

pool.query(`CREATE TABLE IF NOT EXISTS gstr10_returns (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT,
  cancellation_date DATE, effective_cancellation_date DATE,
  reason_for_cancellation TEXT,
  table5_inputs JSONB DEFAULT '[]',
  table5_semi_finished JSONB DEFAULT '[]',
  table5_finished JSONB DEFAULT '[]',
  table5_capital_goods JSONB DEFAULT '[]',
  total_tax_payable REAL DEFAULT 0,
  status TEXT DEFAULT 'draft', arn TEXT, filed_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
)`).catch(()=>{});

// ── GSTR-2B/2A Upload (Excel/CSV) ──
app.post("/api/accounting/companies/:cid/gstr2/upload",auth,upload.single("file"),async(req,res)=>{
  try{
    const{cid}=req.params;const{source,period,fy}=req.body;
    if(!req.file)return res.status(400).json({success:false,message:"File required"});
    const xlsx=require("xlsx");
    const wb=xlsx.read(req.file.buffer,{type:"buffer"});
    const sheet=wb.Sheets[wb.SheetNames[0]];
    const rows=xlsx.utils.sheet_to_json(sheet,{defval:""});
    if(!rows.length)return res.status(400).json({success:false,message:"No data found in file"});

    const sample=rows[0];
    const fk=(opts)=>Object.keys(sample).find(k=>opts.includes(k.toLowerCase().replace(/[\s_\/\-\.]/g,"")))||null;
    const gstinKey=fk(["gstin","gstinofthesupplier","suppliergstin","gstinnoofsupplier"]);
    const nameKey=fk(["tradename","suppliername","name","tradenames","legalname"]);
    const invNoKey=fk(["invoicenumber","invoiceno","billno","documentnumber"]);
    const invDateKey=fk(["invoicedate","billdate","date","documentdate"]);
    const taxableKey=fk(["taxablevalue","taxable","taxableamount","totalvalue"]);
    const igstKey=fk(["integratedtax","igst","igsttax"]);
    const cgstKey=fk(["centraltax","cgst","cgsttax"]);
    const sgstKey=fk(["statetax","sgst","sgsttax","utgst"]);
    const cessKey=fk(["cess","cessamount"]);
    const posKey=fk(["placeofsupply","pos","stateofplace"]);

    if(!gstinKey&&!invNoKey)return res.status(400).json({success:false,message:`Column mapping failed. Found: ${Object.keys(sample).join(", ")}`});

    // Clear previous import for this period
    if(period||fy){
      const delP=[cid,req.user.id,source||"2B"];const cond=period?" AND period=$4":" AND fy=$4";
      await pool.query(`DELETE FROM gstr2_imports WHERE company_id=$1 AND user_id=$2 AND source=$3${cond}`,[...delP,period||fy]);
    }

    let imported=0,skipped=0;
    const parseDate=(v)=>{if(!v)return null;const d=new Date(v);if(!isNaN(d.getTime()))return d.toISOString().split("T")[0];const s=String(v);const[a,b,c]=s.split(/[\/\-]/);if(c)return`${c.length===2?"20"+c:c}-${String(b).padStart(2,"0")}-${String(a).padStart(2,"0")}`;return null;};
    const parseNum=(v)=>{if(!v)return 0;return parseFloat(String(v).replace(/,/g,""))||0;};

    for(const row of rows){
      const gstin=gstinKey?String(row[gstinKey]||"").trim():"";
      const invNo=invNoKey?String(row[invNoKey]||"").trim():"";
      if(!gstin&&!invNo){skipped++;continue;}
      const taxable=parseNum(taxableKey?row[taxableKey]:0);
      const igst=parseNum(igstKey?row[igstKey]:0);
      const cgst=parseNum(cgstKey?row[cgstKey]:0);
      const sgst=parseNum(sgstKey?row[sgstKey]:0);
      const invDate=invDateKey?parseDate(row[invDateKey]):null;
      await pool.query(`INSERT INTO gstr2_imports (id,user_id,company_id,source,period,fy,supplier_gstin,supplier_name,invoice_no,invoice_date,taxable_value,igst,cgst,sgst,cess,place_of_supply) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [uuid(),req.user.id,cid,source||"2B",period||null,fy||null,gstin,nameKey?String(row[nameKey]||"").trim():"",invNo,invDate,taxable,igst,cgst,sgst,parseNum(cessKey?row[cessKey]:0),posKey?String(row[posKey]||"").trim():""]);
      imported++;
    }
    res.json({success:true,message:`✅ Imported ${imported} entries from GSTR-${source||"2B"}`,imported,skipped});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── GSTR-2B/2A Reconciliation ──
app.get("/api/accounting/companies/:cid/gstr2/reconcile",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{period,fy,source}=req.query;
    let dateFilter="";const p2=[cid,req.user.id];
    if(period){const[mo,yr]=period.split("-");dateFilter=` AND EXTRACT(MONTH FROM invoice_date)=$3 AND EXTRACT(YEAR FROM invoice_date)=$4`;p2.push(parseInt(mo),parseInt(yr));}
    else if(fy){const[fyStart]=fy.split("-");dateFilter=` AND invoice_date>=$3 AND invoice_date<$4`;p2.push(`${fyStart}-04-01`,`${parseInt(fyStart)+1}-04-01`);}

    const importedQ=await pool.query(`SELECT * FROM gstr2_imports WHERE company_id=$1 AND user_id=$2 AND source=$3${period?" AND period=$4":fy?" AND fy=$4":""} ORDER BY supplier_gstin,invoice_no`,
      [cid,req.user.id,source||"2B",...(period?[period]:fy?[fy]:[])]);
    const purchQ=await pool.query(`SELECT ci.*,COALESCE((SELECT gstin FROM ledgers WHERE id=ci.party_id),'') as party_gstin FROM company_invoices ci WHERE company_id=$1 AND user_id=$2 AND invoice_type='PURCHASE'${dateFilter} ORDER BY invoice_date`,p2);

    const imported=importedQ.rows;
    const purchases=purchQ.rows;

    // Build lookup maps
    const byInvNo={};
    for(const pur of purchases){
      const key=String(pur.invoice_no||"").trim().toUpperCase();
      if(key)byInvNo[key]=pur;
    }
    const byGstinAmt={};
    for(const pur of purchases){
      if(pur.party_gstin){
        const key=`${pur.party_gstin}_${Math.round(parseFloat(pur.total_amount||0))}`;
        byGstinAmt[key]=pur;
      }
    }

    const results=imported.map(imp=>{
      const invKey=String(imp.invoice_no||"").toUpperCase();
      let match=byInvNo[invKey];
      let method="invoice_no";
      if(!match&&imp.supplier_gstin){
        const amt=parseFloat(imp.taxable_value||0)+(parseFloat(imp.igst||0)||parseFloat(imp.cgst||0)+parseFloat(imp.sgst||0));
        const gkey=`${imp.supplier_gstin}_${Math.round(amt)}`;
        match=byGstinAmt[gkey];method="gstin_amount";
      }
      if(!match)return{...imp,recon_status:"unmatched",matched_invoice:null,mismatch_fields:[]};

      // Check for mismatches
      const mismatches=[];
      const impTaxable=parseFloat(imp.taxable_value||0);
      const purTaxable=parseFloat(match.taxable_amount||0);
      if(Math.abs(impTaxable-purTaxable)>1)mismatches.push(`Taxable Value: ${source||"2B"}=₹${impTaxable.toFixed(2)} vs Books=₹${purTaxable.toFixed(2)}`);
      const impTax=parseFloat(imp.igst||0)||parseFloat(imp.cgst||0)+parseFloat(imp.sgst||0);
      const purTax=parseFloat(match.total_tax||0);
      if(Math.abs(impTax-purTax)>1)mismatches.push(`Tax: ${source||"2B"}=₹${impTax.toFixed(2)} vs Books=₹${purTax.toFixed(2)}`);

      return{...imp,recon_status:mismatches.length>0?"mismatch":"matched",matched_invoice:{id:match.id,invoice_no:match.invoice_no,date:match.invoice_date,taxable:purTaxable,total_tax:purTax},mismatch_fields:mismatches,match_method:method};
    });

    // Invoices in books NOT in 2B/2A
    const matchedInvIds=new Set(results.filter(r=>r.matched_invoice).map(r=>r.matched_invoice.id));
    const extraInBooks=purchases.filter(p=>!matchedInvIds.has(p.id)).map(p=>({...p,recon_status:"books_only"}));

    const summary={
      total_2b:imported.length,matched:results.filter(r=>r.recon_status==="matched").length,
      mismatch:results.filter(r=>r.recon_status==="mismatch").length,
      unmatched_2b:results.filter(r=>r.recon_status==="unmatched").length,
      only_in_books:extraInBooks.length,
      total_books:purchases.length,
    };

    res.json({success:true,period,fy,source:source||"2B",summary,reconciled:results,only_in_books:extraInBooks});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.get("/api/accounting/companies/:cid/gstr2/list",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const{source,period,fy}=req.query;
    let q="SELECT * FROM gstr2_imports WHERE company_id=$1 AND user_id=$2";const p=[cid,req.user.id];
    if(source){q+=` AND source=$${p.length+1}`;p.push(source);}
    if(period){q+=` AND period=$${p.length+1}`;p.push(period);}
    if(fy){q+=` AND fy=$${p.length+1}`;p.push(fy);}
    q+=" ORDER BY supplier_gstin,invoice_no";
    const r=await pool.query(q,p);
    res.json({success:true,entries:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── GSTR-10 (Final Return on cancellation) ──
app.get("/api/accounting/companies/:cid/gstr10",auth,async(req,res)=>{
  try{
    const r=await pool.query("SELECT * FROM gstr10_returns WHERE company_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1",[req.params.cid,req.user.id]);
    res.json({success:true,return:r.rows[0]||null});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/accounting/companies/:cid/gstr10",auth,async(req,res)=>{
  try{
    const{cid}=req.params;const d=req.body;
    const id=uuid();
    await pool.query(`INSERT INTO gstr10_returns (id,user_id,company_id,cancellation_date,effective_cancellation_date,reason_for_cancellation,table5_inputs,table5_semi_finished,table5_finished,table5_capital_goods,total_tax_payable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [id,req.user.id,cid,d.cancellation_date||null,d.effective_cancellation_date||null,d.reason_for_cancellation||null,JSON.stringify(d.table5_inputs||[]),JSON.stringify(d.table5_semi_finished||[]),JSON.stringify(d.table5_finished||[]),JSON.stringify(d.table5_capital_goods||[]),parseFloat(d.total_tax_payable)||0]);
    await pool.query(`UPDATE gstr10_returns SET cancellation_date=$1,effective_cancellation_date=$2,reason_for_cancellation=$3,table5_inputs=$4,table5_semi_finished=$5,table5_finished=$6,table5_capital_goods=$7,total_tax_payable=$8 WHERE id=$9`,
      [d.cancellation_date||null,d.effective_cancellation_date||null,d.reason_for_cancellation||null,JSON.stringify(d.table5_inputs||[]),JSON.stringify(d.table5_semi_finished||[]),JSON.stringify(d.table5_finished||[]),JSON.stringify(d.table5_capital_goods||[]),parseFloat(d.total_tax_payable)||0,id]);
    res.json({success:true,id});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/accounting/companies/:cid/gstr10/file",auth,async(req,res)=>{
  try{
    const{arn}=req.body;
    await pool.query("UPDATE gstr10_returns SET status='filed',arn=$1,filed_date=NOW() WHERE company_id=$2 AND user_id=$3",[arn||`GSTR10${Date.now()}`,req.params.cid,req.user.id]);
    res.json({success:true,message:"✅ GSTR-10 marked as filed"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Phone OTP Login — send OTP to email tied to that phone number ──
app.post("/api/auth/phone-otp-request", rateLimiter({windowMs:15*60*1000,max:8,keyFn:req=>"phoneotp:"+req.ip}), async(req,res)=>{
  try{
    const{phone}=req.body;
    if(!phone)return res.status(400).json({success:false,message:"Phone number required"});
    const cleaned=String(phone).replace(/\D/g,"").slice(-10);
    if(cleaned.length!==10)return res.status(400).json({success:false,message:"Enter a valid 10-digit mobile number"});
    const r=await pool.query("SELECT * FROM users WHERE phone=$1",[cleaned]);
    const user=r.rows[0];
    if(!user)return res.status(404).json({success:false,message:"No account found with this mobile number. Please register first or check the number."});
    if(user.is_suspended)return res.status(403).json({success:false,message:"This account has been suspended."});

    const code=generateOTP();
    const otpId=uuid();
    await pool.query("INSERT INTO otp_codes (id,user_id,code,channel,purpose,expires_at) VALUES ($1,$2,$3,'email','phone_login',NOW()+interval '10 minutes')",
      [otpId,user.id,code]);

    let sent=false;
    try{
      await sendEmail({to:user.email,subject:"TaxPro GST — Phone Login OTP",
        html:`<p>Hi ${user.name},</p><p>Your login OTP is <b style="font-size:22px;letter-spacing:4px">${code}</b></p><p>Valid for 10 minutes. Do not share this with anyone.</p>`});
      sent=true;
    }catch(e){}
    if(!sent)return res.status(500).json({success:false,message:"Could not send OTP email. Please use email+password login instead."});

    const tempToken=jwt.sign({uid:user.id,otp:otpId,purpose:"phone_login_otp"},JWT,{expiresIn:"10m"});
    logAudit(user.id,"phone_otp_requested",`phone:${cleaned}`,req);
    res.json({success:true,otp_token:tempToken,
      sent_to:user.email.replace(/(.{2}).+(@.+)/,"$1***$2"),
      message:`OTP sent to registered email ${user.email.replace(/(.{2}).+(@.+)/,"$1***$2")}`});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── Verify Phone OTP (same verifier as 2FA, just different purpose tag) ──
app.post("/api/auth/phone-otp-verify", rateLimiter({windowMs:15*60*1000,max:15,keyFn:req=>"phoneotp:"+req.ip}), async(req,res)=>{
  try{
    const{otp_token,code}=req.body;
    if(!otp_token||!code)return res.status(400).json({success:false,message:"OTP token and code required"});
    let payload;
    try{payload=jwt.verify(otp_token,JWT);}catch(e){return res.status(401).json({success:false,message:"OTP session expired. Please try again."});}
    if(!["phone_login_otp","login_otp"].includes(payload.purpose))return res.status(400).json({success:false,message:"Invalid OTP session"});
    const otpRow=await pool.query("SELECT * FROM otp_codes WHERE id=$1 AND user_id=$2",[payload.otp,payload.uid]);
    const otp=otpRow.rows[0];
    if(!otp||otp.verified_at)return res.status(400).json({success:false,message:otp?.verified_at?"OTP already used":"OTP not found"});
    if(new Date(otp.expires_at)<new Date())return res.status(400).json({success:false,message:"OTP expired. Please request again."});
    if(otp.attempts>=5)return res.status(429).json({success:false,message:"Too many wrong attempts."});
    if(otp.code!==String(code).trim()){
      await pool.query("UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1",[otp.id]);
      return res.status(401).json({success:false,message:"Incorrect OTP. "+(4-otp.attempts)+" attempts remaining."});
    }
    await pool.query("UPDATE otp_codes SET verified_at=NOW() WHERE id=$1",[otp.id]);
    const userRow=await pool.query("SELECT * FROM users WHERE id=$1",[payload.uid]);
    const user=userRow.rows[0];
    if(!user)return res.status(404).json({success:false,message:"User not found"});
    const userObj={id:user.id,name:user.name,email:user.email,firm_name:user.firm_name,role:user.role};
    const token=await issueSession(userObj,req);
    logAudit(user.id,"phone_otp_login_success",null,req);
    res.json({success:true,token,user:{...userObj,frn:user.frn}});
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

// Groq API helper (avoids needing groq-sdk package)
async function groqChat({model,messages,temperature=0.2,max_tokens=1000}){
  const res=await fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${process.env.GROQ_API_KEY}`},
    body:JSON.stringify({model,messages,temperature,max_tokens})
  });
  const data=await res.json();
  if(!res.ok)throw new Error(data.error?.message||"Groq API error");
  return data.choices[0]?.message?.content||"";
}

// ══ SPECTRUM CLOUD API ROUTES ══

// ── IT CLIENTS ──
app.get("/api/it/clients",auth,async(req,res)=>{
  try{
    const{company_id,search,ay}=req.query;
    let q="SELECT c.*,(SELECT COUNT(*) FROM it_returns r WHERE r.client_id=c.id AND r.user_id=$1) as return_count FROM it_clients c WHERE c.user_id=$1";
    const p=[req.user.id];
    if(company_id){q+=` AND c.company_id=$${p.length+1}`;p.push(company_id);}
    if(search){q+=` AND (c.name ILIKE $${p.length+1} OR c.pan ILIKE $${p.length+2})`;p.push(`%${search}%`,`%${search}%`);}
    q+=" ORDER BY c.name";
    const r=await pool.query(q,p);
    res.json({success:true,clients:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/it/clients",auth,async(req,res)=>{
  try{
    const{name,pan,aadhaar,dob,email,phone,address,client_type,gstin,tan,din,company_id}=req.body;
    if(!name)return res.status(400).json({success:false,message:"Name required"});
    const id=uuid();
    await pool.query("INSERT INTO it_clients (id,user_id,company_id,name,pan,aadhaar,dob,email,phone,address,client_type,gstin,tan,din) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
      [id,req.user.id,company_id||null,name,pan||null,aadhaar||null,dob||null,email||null,phone||null,address||null,client_type||"Individual",gstin||null,tan||null,din||null]);
    res.json({success:true,id});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.put("/api/it/clients/:id",auth,async(req,res)=>{
  try{
    const{name,pan,aadhaar,dob,email,phone,address,client_type,gstin,tan,din,filing_status}=req.body;
    await pool.query("UPDATE it_clients SET name=$1,pan=$2,aadhaar=$3,dob=$4,email=$5,phone=$6,address=$7,client_type=$8,gstin=$9,tan=$10,din=$11,filing_status=COALESCE($12,filing_status) WHERE id=$13 AND user_id=$14",
      [name,pan||null,aadhaar||null,dob||null,email||null,phone||null,address||null,client_type||"Individual",gstin||null,tan||null,din||null,filing_status||null,req.params.id,req.user.id]);
    res.json({success:true});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/it/clients/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM it_clients WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── IT RETURNS ──
app.get("/api/it/returns",auth,async(req,res)=>{
  try{
    const{client_id,ay,company_id}=req.query;
    let q="SELECT r.*,c.name as client_name,c.pan FROM it_returns r LEFT JOIN it_clients c ON r.client_id=c.id WHERE r.user_id=$1";
    const p=[req.user.id];
    if(client_id){q+=` AND r.client_id=$${p.length+1}`;p.push(client_id);}
    if(ay){q+=` AND r.ay=$${p.length+1}`;p.push(ay);}
    if(company_id){q+=` AND r.company_id=$${p.length+1}`;p.push(company_id);}
    q+=" ORDER BY r.created_at DESC";
    const r=await pool.query(q,p);
    res.json({success:true,returns:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/it/returns",auth,async(req,res)=>{
  try{
    const d=req.body;const uid=req.user.id;
    const totalIncome=(parseFloat(d.salary_income)||0)+(parseFloat(d.hp_income)||0)+(parseFloat(d.business_income)||0)+(parseFloat(d.capital_gains)||0)+(parseFloat(d.other_income)||0);
    const totalDed=(parseFloat(d.deduction_80c)||0)+(parseFloat(d.deduction_80d)||0)+(parseFloat(d.other_deductions)||0);
    const netIncome=Math.max(0,totalIncome-totalDed);
    // Basic tax slab (old regime)
    let tax=0;
    if(netIncome>1500000)tax=125000+(netIncome-1500000)*0.3;
    else if(netIncome>1000000)tax=75000+(netIncome-1000000)*0.2;
    else if(netIncome>500000)tax=12500+(netIncome-500000)*0.2;
    else if(netIncome>250000)tax=(netIncome-250000)*0.05;
    const cess=tax*0.04;const totalTax=Math.round((tax+cess)*100)/100;
    const tds=parseFloat(d.tds_deducted)||0;const advTax=parseFloat(d.advance_tax)||0;
    const balanceDue=Math.max(0,totalTax-tds-advTax);const refund=Math.max(0,tds+advTax-totalTax);
    const id=uuid();
    await pool.query("INSERT INTO it_returns (id,user_id,client_id,company_id,pan,ay,itr_type,gross_income,salary_income,hp_income,business_income,capital_gains,other_income,exempt_income,deduction_80c,deduction_80d,other_deductions,total_income,tax_liability,tds_deducted,advance_tax,self_assess_tax,refund_due,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)",
      [id,uid,d.client_id||null,d.company_id||null,d.pan||null,d.ay||"2026-27",d.itr_type||"ITR-1",totalIncome,
       d.salary_income||0,d.hp_income||0,d.business_income||0,d.capital_gains||0,d.other_income||0,d.exempt_income||0,
       d.deduction_80c||0,d.deduction_80d||0,d.other_deductions||0,netIncome,totalTax,tds,advTax,d.self_assess_tax||0,refund,"draft",d.notes||null]);
    res.json({success:true,id,computed:{total_income:netIncome,tax_liability:totalTax,balance_due:balanceDue,refund_due:refund}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.put("/api/it/returns/:id",auth,async(req,res)=>{
  try{
    const d=req.body;
    await pool.query("UPDATE it_returns SET status=$1,ack_no=$2,filed_date=$3,notes=$4 WHERE id=$5 AND user_id=$6",
      [d.status||"draft",d.ack_no||null,d.filed_date||null,d.notes||null,req.params.id,req.user.id]);
    res.json({success:true});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/it/returns/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM it_returns WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── TDS ENTRIES ──
app.get("/api/tds",auth,async(req,res)=>{
  try{
    const{company_id,quarter,fy,form_type}=req.query;
    let q="SELECT * FROM tds_entries WHERE user_id=$1";const p=[req.user.id];
    if(company_id){q+=` AND company_id=$${p.length+1}`;p.push(company_id);}
    if(quarter){q+=` AND quarter=$${p.length+1}`;p.push(quarter);}
    if(fy){q+=` AND fy=$${p.length+1}`;p.push(fy);}
    if(form_type){q+=` AND form_type=$${p.length+1}`;p.push(form_type);}
    q+=" ORDER BY payment_date DESC";
    const r=await pool.query(q,p);
    res.json({success:true,entries:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/tds",auth,async(req,res)=>{
  try{
    const d=req.body;const id=uuid();
    const tdsAmt=parseFloat(d.tds_amount)||Math.round(parseFloat(d.payment_amount||0)*parseFloat(d.tds_rate||0)/100);
    await pool.query("INSERT INTO tds_entries (id,user_id,client_id,company_id,deductee_name,deductee_pan,deductee_type,section,payment_date,payment_amount,tds_rate,tds_amount,tds_deposited,challan_no,challan_date,quarter,fy,form_type,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
      [id,req.user.id,d.client_id||null,d.company_id||null,d.deductee_name,d.deductee_pan||null,d.deductee_type||"Company",d.section||"194C",d.payment_date,parseFloat(d.payment_amount)||0,parseFloat(d.tds_rate)||0,tdsAmt,parseFloat(d.tds_deposited)||0,d.challan_no||null,d.challan_date||null,d.quarter||"Q1",d.fy||"2025-26",d.form_type||"26Q",d.status||"pending"]);
    res.json({success:true,id});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/tds/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM tds_entries WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── COMPLIANCE CALENDAR ──
app.get("/api/compliance",auth,async(req,res)=>{
  try{
    const{company_id,status,month,year}=req.query;
    let q="SELECT t.*,c.name as client_name FROM compliance_tasks t LEFT JOIN it_clients c ON t.client_id=c.id WHERE t.user_id=$1";
    const p=[req.user.id];
    if(company_id){q+=` AND t.company_id=$${p.length+1}`;p.push(company_id);}
    if(status&&status!=="all"){q+=` AND t.status=$${p.length+1}`;p.push(status);}
    if(month&&year){q+=` AND EXTRACT(MONTH FROM t.due_date)=$${p.length+1} AND EXTRACT(YEAR FROM t.due_date)=$${p.length+2}`;p.push(parseInt(month),parseInt(year));}
    q+=" ORDER BY t.due_date ASC";
    const r=await pool.query(q,p);
    res.json({success:true,tasks:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/compliance",auth,async(req,res)=>{
  try{
    const{task_name,category,due_date,client_id,client_name,period,frequency,priority,notes,company_id}=req.body;
    if(!task_name||!due_date)return res.status(400).json({success:false,message:"Task name and due date required"});
    const id=uuid();
    await pool.query("INSERT INTO compliance_tasks (id,user_id,company_id,client_id,task_name,category,due_date,client_name,period,frequency,status,priority,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12)",
      [id,req.user.id,company_id||null,client_id||null,task_name,category||"GST",due_date,client_name||null,period||null,frequency||"monthly",priority||"normal",notes||null]);
    res.json({success:true,id});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.put("/api/compliance/:id",auth,async(req,res)=>{
  try{
    const{status,notes}=req.body;
    await pool.query("UPDATE compliance_tasks SET status=$1,notes=COALESCE($2,notes) WHERE id=$3 AND user_id=$4",[status||"pending",notes||null,req.params.id,req.user.id]);
    res.json({success:true});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/compliance/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM compliance_tasks WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// Auto-seed standard compliance dates for current/next month
app.post("/api/compliance/seed",auth,async(req,res)=>{
  try{
    const{company_id,fy}=req.body;
    const year=parseInt((fy||"2026-27").split("-")[0]);
    const tasks=[
      // GST
      {name:"GSTR-1 Filing",cat:"GST",day:11},{name:"GSTR-3B Filing",cat:"GST",day:20},
      {name:"GSTR-2B Reconciliation",cat:"GST",day:14},{name:"GST CMP-08",cat:"GST",day:18},
      // TDS
      {name:"TDS Payment (All Sections)",cat:"TDS",day:7},{name:"TDS Return 26Q",cat:"TDS",q:true,qday:[31,31,31,31]},
      // IT
      {name:"Advance Tax Installment",cat:"IT",q:true,qday:[15,15,15,15]},
      // PF/ESI
      {name:"PF Challan Deposit",cat:"Payroll",day:15},{name:"ESI Challan Deposit",cat:"Payroll",day:15},
    ];
    const months=[4,5,6,7,8,9,10,11,12,1,2,3]; // April to March
    let inserted=0;
    for(const m of months){
      const y=m>=4?year:year+1;
      const dateStr=(d)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      for(const t of tasks){
        if(t.day){
          const id=uuid();
          await pool.query("INSERT INTO compliance_tasks (id,user_id,company_id,task_name,category,due_date,period,frequency,status,priority) VALUES ($1,$2,$3,$4,$5,$6,$7,'monthly','pending','normal') ON CONFLICT DO NOTHING",
            [id,req.user.id,company_id||null,t.name,t.cat,dateStr(t.day),`${String(m).padStart(2,'0')}-${y}`]);
          inserted++;
        }
      }
    }
    res.json({success:true,message:`✅ Seeded ${inserted} compliance tasks`,inserted});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── PAYROLL ──
app.get("/api/payroll/employees",auth,async(req,res)=>{
  try{
    const{company_id}=req.query;
    let q="SELECT * FROM employees WHERE user_id=$1";const p=[req.user.id];
    if(company_id){q+=` AND company_id=$${p.length+1}`;p.push(company_id);}
    q+=" ORDER BY name";
    const r=await pool.query(q,p);
    res.json({success:true,employees:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.post("/api/payroll/employees",auth,async(req,res)=>{
  try{
    const d=req.body;const id=uuid();
    await pool.query("INSERT INTO employees (id,user_id,company_id,name,employee_code,designation,department,pan,uan,doj,basic_salary,hra,special_allowance,other_allowance,pf_applicable,esi_applicable,pt_applicable,pt_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
      [id,req.user.id,d.company_id||null,d.name,d.employee_code||null,d.designation||null,d.department||null,d.pan||null,d.uan||null,d.doj||null,parseFloat(d.basic_salary)||0,parseFloat(d.hra)||0,parseFloat(d.special_allowance)||0,parseFloat(d.other_allowance)||0,d.pf_applicable!==false,d.esi_applicable||false,d.pt_applicable||false,parseFloat(d.pt_amount)||0]);
    res.json({success:true,id});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/payroll/employees/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM employees WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// Process salary for a month
app.post("/api/payroll/process",auth,async(req,res)=>{
  try{
    const{company_id,month,year}=req.body;
    const emps=await pool.query("SELECT * FROM employees WHERE company_id=$1 AND user_id=$2 AND status='active'",[company_id,req.user.id]);
    const period=`${String(month).padStart(2,'0')}-${year}`;
    const results=[];
    for(const e of emps.rows){
      const gross=parseFloat(e.basic_salary)+parseFloat(e.hra)+parseFloat(e.special_allowance)+parseFloat(e.other_allowance);
      const pfEmp=e.pf_applicable?Math.min(1800,parseFloat(e.basic_salary)*0.12):0;
      const pfEmpr=e.pf_applicable?Math.min(1800,parseFloat(e.basic_salary)*0.12):0;
      const esiEmp=e.esi_applicable&&gross<=21000?Math.round(gross*0.0075):0;
      const esiEmpr=e.esi_applicable&&gross<=21000?Math.round(gross*0.0325):0;
      const pt=e.pt_applicable?parseFloat(e.pt_amount)||0:0;
      const net=gross-pfEmp-esiEmp-pt;
      const id=uuid();
      await pool.query("INSERT INTO salary_records (id,user_id,company_id,employee_id,month,year,period,basic,hra,special,other,gross,pf_employee,pf_employer,esi_employee,esi_employer,pt,net_salary,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'processed') ON CONFLICT DO NOTHING",
        [id,req.user.id,company_id,e.id,String(month),String(year),period,e.basic_salary,e.hra,e.special_allowance,e.other_allowance,gross,pfEmp,pfEmpr,esiEmp,esiEmpr,pt,net]);
      results.push({employee_name:e.name,gross,pf:pfEmp,esi:esiEmp,pt,net});
    }
    res.json({success:true,message:`✅ Salary processed for ${results.length} employees`,results,period});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/payroll/salaries",auth,async(req,res)=>{
  try{
    const{company_id,period}=req.query;
    let q="SELECT s.*,e.name as emp_name,e.designation,e.pan FROM salary_records s JOIN employees e ON s.employee_id=e.id WHERE s.user_id=$1";const p=[req.user.id];
    if(company_id){q+=` AND s.company_id=$${p.length+1}`;p.push(company_id);}
    if(period){q+=` AND s.period=$${p.length+1}`;p.push(period);}
    q+=" ORDER BY s.year DESC,s.month DESC,e.name";
    const r=await pool.query(q,p);
    res.json({success:true,salaries:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── DOCUMENT MANAGER ──
app.post("/api/documents",auth,upload.single("file"),async(req,res)=>{
  try{
    const{company_id,client_id,doc_name,doc_type,category,tags,ay,period}=req.body;
    if(!req.file&&!req.body.file_data)return res.status(400).json({success:false,message:"File required"});
    const base64=req.file?req.file.buffer.toString("base64"):req.body.file_data;
    const mime=req.file?.mimetype||req.body.file_mime||"application/octet-stream";
    const size=req.file?.size||0;
    const id=uuid();
    await pool.query("INSERT INTO documents (id,user_id,company_id,client_id,doc_name,doc_type,category,file_data,file_mime,file_size,tags,ay,period) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [id,req.user.id,company_id||null,client_id||null,doc_name||req.file?.originalname||"Document",doc_type||"Other",category||"General",base64,mime,size,tags||null,ay||null,period||null]);
    res.json({success:true,id,doc_name:doc_name||req.file?.originalname});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/documents",auth,async(req,res)=>{
  try{
    const{company_id,client_id,category,doc_type}=req.query;
    let q="SELECT id,user_id,company_id,client_id,doc_name,doc_type,category,file_mime,file_size,tags,ay,period,created_at FROM documents WHERE user_id=$1";const p=[req.user.id];
    if(company_id){q+=` AND company_id=$${p.length+1}`;p.push(company_id);}
    if(client_id){q+=` AND client_id=$${p.length+1}`;p.push(client_id);}
    if(category){q+=` AND category=$${p.length+1}`;p.push(category);}
    if(doc_type){q+=` AND doc_type=$${p.length+1}`;p.push(doc_type);}
    q+=" ORDER BY created_at DESC";
    const r=await pool.query(q,p);
    res.json({success:true,documents:r.rows});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.get("/api/documents/:id/download",auth,async(req,res)=>{
  try{
    const r=await pool.query("SELECT * FROM documents WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);
    if(!r.rows[0])return res.status(404).json({success:false,message:"Not found"});
    const doc=r.rows[0];
    const buf=Buffer.from(doc.file_data,"base64");
    res.setHeader("Content-Type",doc.file_mime||"application/octet-stream");
    res.setHeader("Content-Disposition",`attachment; filename="${doc.doc_name}"`);
    res.send(buf);
  }catch(e){res.status(500).json({success:false,message:e.message});}
});
app.delete("/api/documents/:id",auth,async(req,res)=>{
  try{await pool.query("DELETE FROM documents WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);res.json({success:true});}catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── ADVANCE TAX CALCULATOR ──
app.post("/api/it/advance-tax",auth,async(req,res)=>{
  try{
    const{estimated_income,tds_deducted,fy}=req.body;
    const income=parseFloat(estimated_income)||0;
    const tds=parseFloat(tds_deducted)||0;
    let tax=0;
    if(income>1500000)tax=125000+(income-1500000)*0.3;
    else if(income>1000000)tax=75000+(income-1000000)*0.2;
    else if(income>500000)tax=12500+(income-500000)*0.2;
    else if(income>250000)tax=(income-250000)*0.05;
    const cess=tax*0.04;const total=Math.round((tax+cess)*100)/100;
    const netTax=Math.max(0,total-tds);
    const installments=[
      {date:`15-Jun-${(fy||"2026-27").split("-")[0]}`,pct:15,amount:Math.round(netTax*0.15)},
      {date:`15-Sep-${(fy||"2026-27").split("-")[0]}`,pct:45,amount:Math.round(netTax*0.30)},
      {date:`15-Dec-${(fy||"2026-27").split("-")[0]}`,pct:75,amount:Math.round(netTax*0.30)},
      {date:`15-Mar-${parseInt((fy||"2026-27").split("-")[1])+2000}`,pct:100,amount:Math.round(netTax*0.25)},
    ];
    res.json({success:true,estimated_income:income,gross_tax:total,tds,net_advance_tax:netTax,installments});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ══════════════════════════════════════════════════════════
// INCOME TAX PORTAL FEATURES
// ══════════════════════════════════════════════════════════

// ── 26AS / AIS IMPORT ──
app.post("/api/it/import-26as",auth,upload.single("file"),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({success:false,message:"File required"});
    const{client_id,ay,source}=req.body;
    const xlsx=require("xlsx");
    const wb=xlsx.read(req.file.buffer,{type:"buffer"});
    const sheet=wb.Sheets[wb.SheetNames[0]];
    const rows=xlsx.utils.sheet_to_json(sheet,{defval:""});

    const entries=[];
    for(const r of rows){
      const deductor=r["Name of Deductor"]||r["Deductor Name"]||r["Name"]||r["DEDUCTOR NAME"]||"";
      const tan=r["TAN of Deductor"]||r["TAN"]||r["tan"]||"";
      const amount=parseFloat(String(r["Amount Paid/Credited"]||r["Amount"]||r["AMOUNT"]||"0").replace(/,/g,""))||0;
      const tds=parseFloat(String(r["Tax Deducted"]||r["TDS Amount"]||r["TDS"]||"0").replace(/,/g,""))||0;
      const section=r["Section"]||r["section"]||r["SECTION"]||"";
      const dateRaw=r["Date of Payment"]||r["Date"]||r["DATE"]||"";

      if(!deductor&&!amount)continue;

      let date=null;
      if(dateRaw){
        const d=new Date(dateRaw);
        if(!isNaN(d.getTime()))date=d.toISOString().split("T")[0];
        else{
          const parts=String(dateRaw).split(/[\/\-\.]/);
          if(parts.length===3){
            const[a,b,c]=parts;
            const yr=c.length===2?`20${c}`:c;
            date=`${yr}-${String(b).padStart(2,"0")}-${String(a).padStart(2,"0")}`;
          }
        }
      }

      const id=uuid();
      await pool.query("INSERT INTO ais_26as_data (id,user_id,client_id,ay,entry_type,deductor_name,deductor_tan,amount,tds_amount,date,section,status,source) VALUES ($1,$2,$3,$4,'TDS',$5,$6,$7,$8,$9,$10,'unmatched',$11)",
        [id,req.user.id,client_id||null,ay||"2026-27",deductor,tan,amount,tds,date,section,source||"26AS"]);
      entries.push({deductor,tds,amount});
    }
    res.json({success:true,message:`✅ Imported ${entries.length} entries from ${source||"26AS"}`,count:entries.length});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.get("/api/it/26as/:client_id",auth,async(req,res)=>{
  try{
    const{ay}=req.query;
    let q="SELECT * FROM ais_26as_data WHERE user_id=$1 AND client_id=$2";
    const p=[req.user.id,req.params.client_id];
    if(ay){q+=` AND ay=$${p.length+1}`;p.push(ay);}
    q+=" ORDER BY date ASC";
    const r=await pool.query(q,p);
    const total_tds=r.rows.reduce((a,x)=>a+parseFloat(x.tds_amount||0),0);
    const total_income=r.rows.reduce((a,x)=>a+parseFloat(x.amount||0),0);
    res.json({success:true,entries:r.rows,summary:{total_tds,total_income,count:r.rows.length}});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── FORM 16 GENERATOR (Part A + Part B as HTML) ──
app.get("/api/it/form16/:client_id",auth,async(req,res)=>{
  try{
    const{ay,fy}=req.query;
    const client=await pool.query("SELECT * FROM it_clients WHERE id=$1 AND user_id=$2",[req.params.client_id,req.user.id]);
    if(!client.rows[0])return res.status(404).json({success:false,message:"Client not found"});
    const c=client.rows[0];
    const tdsQ=await pool.query("SELECT * FROM tds_entries WHERE client_id=$1 AND user_id=$2 AND fy=$3 AND form_type='24Q' ORDER BY payment_date",
      [req.params.client_id,req.user.id,fy||"2025-26"]);
    const ret=await pool.query("SELECT * FROM it_returns WHERE client_id=$1 AND user_id=$2 AND ay=$3 ORDER BY created_at DESC LIMIT 1",
      [req.params.client_id,req.user.id,ay||"2026-27"]);
    const itr=ret.rows[0]||{};
    const totalSalary=parseFloat(itr.salary_income)||0;
    const totalTDS=tdsQ.rows.reduce((a,t)=>a+parseFloat(t.tds_amount||0),0);
    const user=await pool.query("SELECT * FROM users WHERE id=$1",[req.user.id]);
    const deductorName=user.rows[0]?.firm_name||user.rows[0]?.name||"Employer";

    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Form 16 - ${c.name}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:11px;margin:20px;color:#000}
  h2{text-align:center;font-size:14px;text-decoration:underline}
  h3{font-size:12px;text-decoration:underline}
  table{width:100%;border-collapse:collapse;margin-bottom:12px}
  td,th{border:1px solid #000;padding:4px 8px;vertical-align:top}
  .header{text-align:center;border:2px solid #000;padding:10px;margin-bottom:16px}
  .no-border td{border:none}
  @media print{body{margin:10px}}
</style></head><body>
<div class="header">
  <b>FORM 16</b><br/>
  [See rule 31(1)(a)]<br/>
  <b>Certificate under section 203 of the Income-tax Act, 1961 for tax deducted at source on salary</b>
</div>
<h3>PART A</h3>
<table><tr><td width="50%"><b>Name and address of the Employer</b><br/>${deductorName}</td>
<td><b>Name and address of the Employee</b><br/>${c.name}<br/>${c.address||""}</td></tr>
<tr><td><b>TAN of the Employer:</b> ${tdsQ.rows[0]?.deductee_pan||"_________"}</td>
<td><b>PAN of the Employee:</b> ${c.pan||"_________"}</td></tr>
<tr><td colspan="2"><b>Assessment Year:</b> ${ay||"2026-27"} &nbsp;&nbsp; <b>Period:</b> 01/04/${(fy||"2025-26").split("-")[0]} to 31/03/${(fy||"2025-26").split("-")[1]}</td></tr></table>
<table><tr><th>Quarter</th><th>Date of Deduction</th><th>Amount of Tax Deducted</th><th>Amount of Tax Deposited</th><th>Challan No.</th></tr>
${tdsQ.rows.map(t=>`<tr><td>${t.quarter}</td><td>${t.payment_date||""}</td><td>₹${parseFloat(t.tds_amount||0).toLocaleString("en-IN")}</td><td>₹${parseFloat(t.tds_deposited||0).toLocaleString("en-IN")}</td><td>${t.challan_no||""}</td></tr>`).join("")}
<tr><td colspan="2"><b>Total</b></td><td><b>₹${totalTDS.toLocaleString("en-IN")}</b></td><td><b>₹${totalTDS.toLocaleString("en-IN")}</b></td><td></td></tr></table>
<h3>PART B (Details of Salary Paid and Tax Deducted)</h3>
<table>
<tr><td>1. Gross Salary</td><td style="text-align:right">₹${totalSalary.toLocaleString("en-IN")}</td></tr>
<tr><td>2. Less: Deductions u/s 16</td><td style="text-align:right">₹${Math.min(50000,totalSalary).toLocaleString("en-IN")}</td></tr>
<tr><td>3. Income chargeable under head "Salaries"</td><td style="text-align:right">₹${Math.max(0,totalSalary-50000).toLocaleString("en-IN")}</td></tr>
<tr><td>4. Gross Total Income</td><td style="text-align:right">₹${parseFloat(itr.total_income||0).toLocaleString("en-IN")}</td></tr>
<tr><td>5. Total Income Tax Liability</td><td style="text-align:right">₹${parseFloat(itr.tax_liability||0).toLocaleString("en-IN")}</td></tr>
<tr><td>6. Tax Deducted at Source</td><td style="text-align:right">₹${totalTDS.toLocaleString("en-IN")}</td></tr>
<tr><td><b>7. Balance Tax Payable / Refund</b></td><td style="text-align:right"><b>₹${Math.abs(parseFloat(itr.tax_liability||0)-totalTDS).toLocaleString("en-IN")} ${parseFloat(itr.tax_liability||0)>totalTDS?"Payable":"Refund"}</b></td></tr>
</table>
<br/><br/>
<table class="no-border">
<tr><td width="50%">Date: _______________</td><td>Signature of the person responsible for deduction of tax</td></tr>
<tr><td></td><td>Name: ${deductorName}</td></tr>
<tr><td></td><td>Designation: _______________</td></tr>
</table>
<script>window.onload=()=>window.print();</script>
</body></html>`;
    res.setHeader("Content-Type","text/html");
    res.send(html);
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── FORM 16A (TDS Certificate for Non-Salary) ──
app.get("/api/it/form16a/:tds_id",auth,async(req,res)=>{
  try{
    const tds=await pool.query("SELECT * FROM tds_entries WHERE id=$1 AND user_id=$2",[req.params.tds_id,req.user.id]);
    if(!tds.rows[0])return res.status(404).json({success:false,message:"TDS entry not found"});
    const t=tds.rows[0];
    const user=await pool.query("SELECT * FROM users WHERE id=$1",[req.user.id]);
    const deductorName=user.rows[0]?.firm_name||user.rows[0]?.name||"Deductor";

    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Form 16A</title>
<style>body{font-family:Arial;font-size:11px;margin:20px}table{width:100%;border-collapse:collapse;margin-bottom:10px}td,th{border:1px solid #000;padding:4px 8px}.header{text-align:center;border:2px solid #000;padding:8px;margin-bottom:14px}</style>
</head><body>
<div class="header"><b>FORM 16A</b><br/>[See rule 31(1)(b)]<br/><b>Certificate of deduction of tax at source u/s 203 of IT Act 1961</b></div>
<table>
<tr><td><b>Name of Deductor:</b> ${deductorName}</td><td><b>TAN:</b> ${t.deductee_pan||"—"}</td></tr>
<tr><td><b>Name of Deductee:</b> ${t.deductee_name}</td><td><b>PAN of Deductee:</b> ${t.deductee_pan||"—"}</td></tr>
<tr><td><b>Section:</b> ${t.section}</td><td><b>Nature of Payment:</b> ${t.deductee_type||"—"}</td></tr>
<tr><td><b>Period:</b> ${t.quarter} (${t.fy})</td><td><b>Date of Payment:</b> ${t.payment_date||"—"}</td></tr>
</table>
<table>
<tr><th>S.No</th><th>Date of Payment/Credit</th><th>Amount Paid/Credited</th><th>TDS Deducted</th><th>Rate of TDS</th><th>Challan No.</th><th>Challan Date</th></tr>
<tr><td>1</td><td>${t.payment_date||""}</td><td>₹${parseFloat(t.payment_amount||0).toLocaleString("en-IN")}</td><td>₹${parseFloat(t.tds_amount||0).toLocaleString("en-IN")}</td><td>${t.tds_rate||0}%</td><td>${t.challan_no||""}</td><td>${t.challan_date||""}</td></tr>
<tr><td colspan="2"><b>Total</b></td><td><b>₹${parseFloat(t.payment_amount||0).toLocaleString("en-IN")}</b></td><td><b>₹${parseFloat(t.tds_amount||0).toLocaleString("en-IN")}</b></td><td colspan="3"></td></tr>
</table>
<br/>
<p>Certified that a sum of <b>₹${parseFloat(t.tds_amount||0).toLocaleString("en-IN")}</b> has been deducted and deposited to the credit of Central Government vide Challan No. <b>${t.challan_no||"___"}</b> dated <b>${t.challan_date||"___"}</b></p>
<br/><br/>
<p>Date: _______________ &nbsp;&nbsp;&nbsp;&nbsp; Signature: _______________</p>
<p>Name: ${deductorName} &nbsp;&nbsp; Designation: _______________</p>
<script>window.onload=()=>window.print();</script>
</body></html>`;
    res.setHeader("Content-Type","text/html");
    res.send(html);
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── CHALLAN 280 PRE-FILL ──
app.post("/api/it/challan280",auth,async(req,res)=>{
  try{
    const{client_id,ay,amount,payment_type,bank_code}=req.body;
    const client=client_id?await pool.query("SELECT * FROM it_clients WHERE id=$1 AND user_id=$2",[client_id,req.user.id]):null;
    const c=client?.rows[0]||{};
    // TIN-NSDL pre-fill URL
    const tinUrl=`https://onlineservices.tin.egov-nsdl.com/etaxnew/tdsnontds.jsp`;
    const data={
      pan:c.pan||"",name:c.name||"",ay:ay||"2026-27",
      amount:amount||0,payment_type:payment_type||"Advance Tax",
      bank_code:bank_code||"0002",
      direct_link:`https://eportal.incometax.gov.in/iec/foservices/#/e-pay-tax`,
      tin_link:tinUrl,
      pre_fill_note:"Copy these details to the IT portal e-Pay Tax section",
      steps:["1. Go to incometax.gov.in → e-Pay Tax","2. Enter PAN: "+( c.pan||"Your PAN"),"3. Select 'Income Tax' → '(300) Self Assessment Tax' or '(100) Advance Tax'","4. Enter AY: "+(ay||"2026-27"),"5. Enter amount: ₹"+parseFloat(amount||0).toLocaleString("en-IN"),"6. Select bank and complete payment","7. Save Challan BSR code & serial no. in TDS Module"],
    };
    res.json({success:true,data,client:c});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── AI TAX PLANNING SUGGESTIONS ──
app.post("/api/it/tax-planning",auth,async(req,res)=>{
  try{
    const{client_id,ay}=req.body;
    if(!process.env.GROQ_API_KEY)return res.status(400).json({success:false,message:"AI not configured"});

    let clientInfo="";
    if(client_id){
      const c=await pool.query("SELECT * FROM it_clients WHERE id=$1 AND user_id=$2",[client_id,req.user.id]);
      const r=await pool.query("SELECT * FROM it_returns WHERE client_id=$1 AND ay=$2 ORDER BY created_at DESC LIMIT 1",[client_id,ay||"2026-27"]);
      if(c.rows[0]){
        const cl=c.rows[0];const ret=r.rows[0];
        clientInfo=`Client: ${cl.name} (${cl.client_type}), PAN: ${cl.pan||"N/A"}
${ret?`Tax Return AY ${ret.ay}: Salary: ₹${ret.salary_income}, Business: ₹${ret.business_income}, Total Income: ₹${ret.total_income}, Tax Liability: ₹${ret.tax_liability}, 80C Used: ₹${ret.deduction_80c}, 80D Used: ₹${ret.deduction_80d}`:"No return filed yet"}`;
      }
    }

    const reply=await groqChat({
      model:"llama-3.1-8b-instant",
      messages:[
        {role:"system",content:`You are an expert Indian Chartered Accountant and tax advisor. Provide practical, specific tax planning advice for Indian taxpayers. Consider both old and new tax regimes. Format your response as a JSON object with these keys:
{
  "summary": "brief 1-line summary",
  "old_regime_tax": estimated tax under old regime as number,
  "new_regime_tax": estimated tax under new regime as number,
  "recommended_regime": "Old Regime or New Regime",
  "suggestions": [{"category":"80C/80D/HRA/NPS etc","action":"specific action to take","potential_saving":amount_in_rupees,"priority":"High/Medium/Low"}],
  "immediate_actions": ["action 1","action 2"],
  "caution": "any important note"
}
Return ONLY valid JSON, no markdown.`},
        {role:"user",content:`Provide tax planning advice for AY ${ay||"2026-27"}.\n${clientInfo||"General Indian individual taxpayer, salary income approx ₹10 lakhs"}`}
      ],
      temperature:0.3,max_tokens:1500
    });
    const jsonMatch=reply.match(/\{[\s\S]*\}/);
    if(!jsonMatch)return res.status(400).json({success:false,message:"AI response could not be parsed"});
    const suggestions=JSON.parse(jsonMatch[0]);
    res.json({success:true,suggestions,ay:ay||"2026-27"});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

// ── IT PORTAL LINKS & INTEGRATION GUIDE ──
app.get("/api/it/portal-links",auth,(req,res)=>{
  res.json({success:true,links:[
    {name:"e-Filing Portal",url:"https://eportal.incometax.gov.in",desc:"File ITR, check status, download forms"},
    {name:"e-Pay Tax (Challan 280)",url:"https://eportal.incometax.gov.in/iec/foservices/#/e-pay-tax",desc:"Pay advance tax, self-assessment tax"},
    {name:"View 26AS / AIS",url:"https://eportal.incometax.gov.in/iec/foservices/#/view-tax-credit-26AS",desc:"Download 26AS & AIS statement"},
    {name:"TDS Reconciliation (TRACES)",url:"https://www.tdscpc.gov.in",desc:"Form 16A download, TDS certificates"},
    {name:"TAN Registration",url:"https://tin.tin.nsdl.com/tan/",desc:"Apply/verify TAN"},
    {name:"PAN Verification",url:"https://eportal.incometax.gov.in/iec/foservices/#/pre-login/knowYourAO",desc:"Know your jurisdiction AO"},
    {name:"ITR Status Check",url:"https://eportal.incometax.gov.in/iec/foservices/#/pre-login/itr-status",desc:"Check ITR processing status"},
    {name:"Outstanding Tax Demand",url:"https://eportal.incometax.gov.in/iec/foservices/#/pre-login/outstanding-demand",desc:"Check & respond to tax demands"},
  ]});
});