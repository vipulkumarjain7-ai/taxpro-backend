const express = require("express");
const { v4: uuid } = require("uuid");
const Database = require("pg");
const auth = require("../middleware/auth");
const router = express.Router();
router.use(auth);
 
// Get db from parent
const db = (() => {
  try { return require("../config/db"); }
  catch(e) { return new Database(process.env.DB_PATH || "./taxpro.db"); }
})();
 
// ── Default Ledger Groups (Tally-like Chart of Accounts) ──────────────────
const DEFAULT_GROUPS = [
  // Capital & Liability
  { name:"Capital Account",       nature:"Liability",  parent:null,               affects_gross:0 },
  { name:"Reserves & Surplus",    nature:"Liability",  parent:"Capital Account",  affects_gross:0 },
  { name:"Loans (Liability)",     nature:"Liability",  parent:null,               affects_gross:0 },
  { name:"Secured Loans",         nature:"Liability",  parent:"Loans (Liability)",affects_gross:0 },
  { name:"Unsecured Loans",       nature:"Liability",  parent:"Loans (Liability)",affects_gross:0 },
  { name:"Current Liabilities",   nature:"Liability",  parent:null,               affects_gross:0 },
  { name:"Sundry Creditors",      nature:"Liability",  parent:"Current Liabilities",affects_gross:0 },
  { name:"Duties & Taxes",        nature:"Liability",  parent:"Current Liabilities",affects_gross:0 },
  { name:"Provisions",            nature:"Liability",  parent:"Current Liabilities",affects_gross:0 },
  // Assets
  { name:"Fixed Assets",          nature:"Asset",      parent:null,               affects_gross:0 },
  { name:"Investments",           nature:"Asset",      parent:null,               affects_gross:0 },
  { name:"Current Assets",        nature:"Asset",      parent:null,               affects_gross:0 },
  { name:"Sundry Debtors",        nature:"Asset",      parent:"Current Assets",   affects_gross:0 },
  { name:"Cash-in-Hand",          nature:"Asset",      parent:"Current Assets",   affects_gross:0 },
  { name:"Bank Accounts",         nature:"Asset",      parent:"Current Assets",   affects_gross:0 },
  { name:"Stock-in-Hand",         nature:"Asset",      parent:"Current Assets",   affects_gross:0 },
  { name:"Loans & Advances (Asset)",nature:"Asset",   parent:"Current Assets",   affects_gross:0 },
  // Income
  { name:"Sales Accounts",        nature:"Income",     parent:null,               affects_gross:1 },
  { name:"Direct Income",         nature:"Income",     parent:null,               affects_gross:1 },
  { name:"Indirect Income",       nature:"Income",     parent:null,               affects_gross:0 },
  // Expenses
  { name:"Purchase Accounts",     nature:"Expense",    parent:null,               affects_gross:1 },
  { name:"Direct Expenses",       nature:"Expense",    parent:null,               affects_gross:1 },
  { name:"Indirect Expenses",     nature:"Expense",    parent:null,               affects_gross:0 },
  { name:"Manufacturing Expenses",nature:"Expense",    parent:null,               affects_gross:1 },
];
 
// ── Default Ledgers ───────────────────────────────────────────────────────
const DEFAULT_LEDGERS = [
  { name:"Cash",               group:"Cash-in-Hand",      opening:0, type:"Dr" },
  { name:"Capital",            group:"Capital Account",   opening:0, type:"Cr" },
  { name:"Sales",              group:"Sales Accounts",    opening:0, type:"Cr" },
  { name:"Purchase",           group:"Purchase Accounts", opening:0, type:"Dr" },
  { name:"CGST Payable",       group:"Duties & Taxes",    opening:0, type:"Cr" },
  { name:"SGST Payable",       group:"Duties & Taxes",    opening:0, type:"Cr" },
  { name:"IGST Payable",       group:"Duties & Taxes",    opening:0, type:"Cr" },
  { name:"CGST Input",         group:"Current Assets",    opening:0, type:"Dr" },
  { name:"SGST Input",         group:"Current Assets",    opening:0, type:"Dr" },
  { name:"IGST Input",         group:"Current Assets",    opening:0, type:"Dr" },
  { name:"Discount Allowed",   group:"Indirect Expenses", opening:0, type:"Dr" },
  { name:"Discount Received",  group:"Indirect Income",   opening:0, type:"Cr" },
  { name:"Freight & Cartage",  group:"Direct Expenses",   opening:0, type:"Dr" },
  { name:"Salary & Wages",     group:"Indirect Expenses", opening:0, type:"Dr" },
  { name:"Rent",               group:"Indirect Expenses", opening:0, type:"Dr" },
  { name:"Electricity Charges",group:"Indirect Expenses", opening:0, type:"Dr" },
];
 
// ── Helper: Create default groups & ledgers ───────────────────────────────
const createDefaults = (companyId, userId) => {
  const groupMap = {};
 
  // Insert groups
  for (const g of DEFAULT_GROUPS) {
    const id = uuid();
    db.prepare(`INSERT OR IGNORE INTO ledger_groups (id,user_id,company_id,name,nature,affects_gross,is_default) VALUES (?,?,?,?,?,?,1)`)
      .run(id, userId, companyId, g.name, g.nature, g.affects_gross?1:0);
    const row = db.prepare("SELECT id FROM ledger_groups WHERE company_id=? AND name=?").get(companyId, g.name);
    if (row) groupMap[g.name] = row.id;
  }
 
  // Set parent relationships
  for (const g of DEFAULT_GROUPS) {
    if (g.parent && groupMap[g.parent] && groupMap[g.name]) {
      db.prepare("UPDATE ledger_groups SET parent_id=? WHERE id=?").run(groupMap[g.parent], groupMap[g.name]);
    }
  }
 
  // Insert default ledgers
  for (const l of DEFAULT_LEDGERS) {
    const groupId = groupMap[l.group];
    if (!groupId) continue;
    db.prepare(`INSERT OR IGNORE INTO ledgers (id,user_id,company_id,group_id,name,opening_balance,opening_type,is_default) VALUES (?,?,?,?,?,?,?,1)`)
      .run(uuid(), userId, companyId, groupId, l.name, l.opening, l.type);
  }
};
 
// ── Voucher number generator ──────────────────────────────────────────────
const genVoucherNo = (companyId, type) => {
  const prefixes = { SALES:"SI", PURCHASE:"PI", RECEIPT:"RC", PAYMENT:"PY", CONTRA:"CT", JOURNAL:"JV" };
  const prefix = prefixes[type] || "VR";
  const yr = new Date().getFullYear().toString().slice(-2);
  const mo = String(new Date().getMonth()+1).padStart(2,"0");
  const cnt = db.prepare("SELECT COUNT(*) as c FROM vouchers WHERE company_id=? AND voucher_type=?").get(companyId, type)?.c || 0;
  return `${prefix}/${yr}-${mo}/${String(cnt+1).padStart(4,"0")}`;
};
 
// ════════════════════════════════════════════════════════════════
// COMPANY ROUTES
// ════════════════════════════════════════════════════════════════
 
router.get("/companies", (req, res) => {
  try {
    const companies = db.prepare("SELECT * FROM companies WHERE user_id=? ORDER BY name ASC").all(req.user.id);
    res.json({ success:true, companies });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.post("/companies", (req, res) => {
  try {
    const { name, legal_name, gstin, pan, address, city, state, pincode, phone, email, fy_start, fy_end, financial_year } = req.body;
    if (!name) return res.status(400).json({ success:false, message:"Company name required" });
    const id = uuid();
    db.prepare(`INSERT INTO companies (id,user_id,name,legal_name,gstin,pan,address,city,state,pincode,phone,email,fy_start,fy_end,financial_year) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.user.id, name, legal_name||null, gstin||null, pan||null, address||null, city||null, state||null, pincode||null, phone||null, email||null, fy_start||"2024-04-01", fy_end||"2025-03-31", financial_year||"Apr-Mar");
    // Create default groups & ledgers
    createDefaults(id, req.user.id);
    const company = db.prepare("SELECT * FROM companies WHERE id=?").get(id);
    res.status(201).json({ success:true, message:"Company created with default Chart of Accounts!", company });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.put("/companies/:id", (req, res) => {
  try {
    const { name, legal_name, gstin, pan, address, city, state, pincode, phone, email, fy_start, fy_end } = req.body;
    db.prepare(`UPDATE companies SET name=?,legal_name=?,gstin=?,pan=?,address=?,city=?,state=?,pincode=?,phone=?,email=?,fy_start=?,fy_end=?,is_active=1 WHERE id=? AND user_id=?`)
      .run(name, legal_name||null, gstin||null, pan||null, address||null, city||null, state||null, pincode||null, phone||null, email||null, fy_start||"2024-04-01", fy_end||"2025-03-31", req.params.id, req.user.id);
    res.json({ success:true, message:"Company updated" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.delete("/companies/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM companies WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
    res.json({ success:true, message:"Company deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
// ════════════════════════════════════════════════════════════════
// LEDGER GROUP ROUTES
// ════════════════════════════════════════════════════════════════
 
router.get("/companies/:companyId/groups", (req, res) => {
  try {
    const groups = db.prepare("SELECT * FROM ledger_groups WHERE company_id=? AND user_id=? ORDER BY nature ASC, name ASC").all(req.params.companyId, req.user.id);
    res.json({ success:true, groups });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.post("/companies/:companyId/groups", (req, res) => {
  try {
    const { name, parent_id, nature, affects_gross } = req.body;
    if (!name || !nature) return res.status(400).json({ success:false, message:"Name and nature required" });
    const id = uuid();
    db.prepare("INSERT INTO ledger_groups (id,user_id,company_id,name,parent_id,nature,affects_gross) VALUES (?,?,?,?,?,?,?)")
      .run(id, req.user.id, req.params.companyId, name, parent_id||null, nature, affects_gross?1:0);
    res.status(201).json({ success:true, message:"Group created", group:db.prepare("SELECT * FROM ledger_groups WHERE id=?").get(id) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.put("/companies/:companyId/groups/:id", (req, res) => {
  try {
    const { name, parent_id, nature, affects_gross } = req.body;
    db.prepare("UPDATE ledger_groups SET name=?,parent_id=?,nature=?,affects_gross=? WHERE id=? AND user_id=?")
      .run(name, parent_id||null, nature, affects_gross?1:0, req.params.id, req.user.id);
    res.json({ success:true, message:"Group updated" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.delete("/companies/:companyId/groups/:id", (req, res) => {
  try {
    const hasLedgers = db.prepare("SELECT COUNT(*) as c FROM ledgers WHERE group_id=?").get(req.params.id)?.c || 0;
    if (hasLedgers > 0) return res.status(400).json({ success:false, message:"Cannot delete group with ledgers" });
    db.prepare("DELETE FROM ledger_groups WHERE id=? AND user_id=? AND is_default=0").run(req.params.id, req.user.id);
    res.json({ success:true, message:"Group deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
// ════════════════════════════════════════════════════════════════
// LEDGER ROUTES
// ════════════════════════════════════════════════════════════════
 
router.get("/companies/:companyId/ledgers", (req, res) => {
  try {
    const { group_id, nature, search } = req.query;
    let q = `SELECT l.*, g.name as group_name, g.nature FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.company_id=? AND l.user_id=?`;
    const params = [req.params.companyId, req.user.id];
    if (group_id) { q+=" AND l.group_id=?"; params.push(group_id); }
    if (nature)   { q+=" AND g.nature=?";   params.push(nature); }
    if (search)   { q+=" AND l.name LIKE ?"; params.push(`%${search}%`); }
    q += " ORDER BY g.nature ASC, l.name ASC";
    const ledgers = db.prepare(q).all(...params);
 
    // Calculate current balance for each ledger
    const withBalance = ledgers.map(l => {
      const txn = db.prepare("SELECT COALESCE(SUM(dr_amount),0) as dr, COALESCE(SUM(cr_amount),0) as cr FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=? AND v.is_cancelled=0").get(l.id);
      const totalDr = (l.opening_type==="Dr" ? l.opening_balance : 0) + (txn?.dr||0);
      const totalCr = (l.opening_type==="Cr" ? l.opening_balance : 0) + (txn?.cr||0);
      const balance = Math.abs(totalDr - totalCr);
      const balance_type = totalDr >= totalCr ? "Dr" : "Cr";
      return { ...l, total_dr:totalDr, total_cr:totalCr, balance, balance_type };
    });
 
    res.json({ success:true, ledgers:withBalance });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.post("/companies/:companyId/ledgers", (req, res) => {
  try {
    const { name, group_id, opening_balance, opening_type, alias, gstin, pan, address, phone, email, bank_account, bank_name, ifsc_code, credit_limit, credit_days, notes } = req.body;
    if (!name || !group_id) return res.status(400).json({ success:false, message:"Name and group required" });
    const exists = db.prepare("SELECT id FROM ledgers WHERE company_id=? AND name=?").get(req.params.companyId, name);
    if (exists) return res.status(409).json({ success:false, message:"Ledger with this name already exists" });
    const id = uuid();
    db.prepare(`INSERT INTO ledgers (id,user_id,company_id,group_id,name,alias,opening_balance,opening_type,gstin,pan,address,phone,email,bank_account,bank_name,ifsc_code,credit_limit,credit_days,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.user.id, req.params.companyId, group_id, name.trim(), alias||null, parseFloat(opening_balance)||0, opening_type||"Dr", gstin||null, pan||null, address||null, phone||null, email||null, bank_account||null, bank_name||null, ifsc_code||null, parseFloat(credit_limit)||0, parseInt(credit_days)||0, notes||null);
    res.status(201).json({ success:true, message:"Ledger created", ledger:db.prepare("SELECT * FROM ledgers WHERE id=?").get(id) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.put("/companies/:companyId/ledgers/:id", (req, res) => {
  try {
    const { name, group_id, opening_balance, opening_type, alias, gstin, pan, address, phone, email, bank_account, bank_name, ifsc_code, credit_limit, credit_days, notes } = req.body;
    db.prepare(`UPDATE ledgers SET name=?,group_id=?,alias=?,opening_balance=?,opening_type=?,gstin=?,pan=?,address=?,phone=?,email=?,bank_account=?,bank_name=?,ifsc_code=?,credit_limit=?,credit_days=?,notes=?,updated_at=datetime('now') WHERE id=? AND user_id=?`)
      .run(name, group_id, alias||null, parseFloat(opening_balance)||0, opening_type||"Dr", gstin||null, pan||null, address||null, phone||null, email||null, bank_account||null, bank_name||null, ifsc_code||null, parseFloat(credit_limit)||0, parseInt(credit_days)||0, notes||null, req.params.id, req.user.id);
    res.json({ success:true, message:"Ledger updated" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.delete("/companies/:companyId/ledgers/:id", (req, res) => {
  try {
    const hasVouchers = db.prepare("SELECT COUNT(*) as c FROM voucher_items WHERE ledger_id=?").get(req.params.id)?.c||0;
    if (hasVouchers>0) return res.status(400).json({ success:false, message:"Cannot delete ledger with transactions" });
    db.prepare("DELETE FROM ledgers WHERE id=? AND user_id=? AND is_default=0").run(req.params.id, req.user.id);
    res.json({ success:true, message:"Ledger deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
// GET Ledger Statement (transactions)
router.get("/companies/:companyId/ledgers/:id/statement", (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const ledger = db.prepare("SELECT l.*,g.name as group_name,g.nature FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.id=?").get(req.params.id);
    if (!ledger) return res.status(404).json({ success:false, message:"Ledger not found" });
 
    let q = `SELECT vi.*, v.date, v.voucher_no, v.voucher_type, v.narration as v_narration FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=? AND v.is_cancelled=0`;
    const params = [req.params.id];
    if (from_date) { q+=" AND v.date>=?"; params.push(from_date); }
    if (to_date)   { q+=" AND v.date<=?"; params.push(to_date); }
    q += " ORDER BY v.date ASC, v.created_at ASC";
    const transactions = db.prepare(q).all(...params);
 
    let runningBalance = ledger.opening_type==="Dr" ? ledger.opening_balance : -ledger.opening_balance;
    const withBalance = transactions.map(t => {
      runningBalance += (t.dr_amount||0) - (t.cr_amount||0);
      return { ...t, running_balance:Math.abs(runningBalance), balance_type:runningBalance>=0?"Dr":"Cr" };
    });
 
    const totalDr = transactions.reduce((a,t)=>a+(t.dr_amount||0),0);
    const totalCr = transactions.reduce((a,t)=>a+(t.cr_amount||0),0);
 
    res.json({ success:true, ledger, transactions:withBalance, summary:{ opening_balance:ledger.opening_balance, opening_type:ledger.opening_type, total_dr:totalDr, total_cr:totalCr, closing_balance:Math.abs(runningBalance), closing_type:runningBalance>=0?"Dr":"Cr" } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
// ════════════════════════════════════════════════════════════════
// VOUCHER ROUTES
// ════════════════════════════════════════════════════════════════
 
router.get("/companies/:companyId/vouchers", (req, res) => {
  try {
    const { type, from_date, to_date, search } = req.query;
    let q = "SELECT * FROM vouchers WHERE company_id=? AND user_id=? AND is_cancelled=0";
    const params = [req.params.companyId, req.user.id];
    if (type)      { q+=" AND voucher_type=?";      params.push(type); }
    if (from_date) { q+=" AND date>=?";             params.push(from_date); }
    if (to_date)   { q+=" AND date<=?";             params.push(to_date); }
    if (search)    { q+=" AND (party_name LIKE ? OR voucher_no LIKE ? OR narration LIKE ?)"; params.push(`%${search}%`,`%${search}%`,`%${search}%`); }
    q += " ORDER BY date DESC, created_at DESC";
    const vouchers = db.prepare(q).all(...params);
    res.json({ success:true, count:vouchers.length, vouchers });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.get("/companies/:companyId/vouchers/:id", (req, res) => {
  try {
    const voucher = db.prepare("SELECT * FROM vouchers WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!voucher) return res.status(404).json({ success:false, message:"Voucher not found" });
    const items = db.prepare("SELECT vi.*, l.name as ledger_name, g.name as group_name, g.nature FROM voucher_items vi JOIN ledgers l ON vi.ledger_id=l.id JOIN ledger_groups g ON l.group_id=g.id WHERE vi.voucher_id=? ORDER BY vi.sort_order ASC").all(req.params.id);
    res.json({ success:true, voucher:{ ...voucher, items } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.post("/companies/:companyId/vouchers", (req, res) => {
  try {
    const { voucher_type, date, ref_no, narration, party_ledger_id, party_name, items=[] } = req.body;
    if (!voucher_type || !date) return res.status(400).json({ success:false, message:"Voucher type and date required" });
    if (items.length < 2) return res.status(400).json({ success:false, message:"At least 2 ledger entries required (double entry)" });
 
    const totalDr = items.reduce((a,i)=>a+(parseFloat(i.dr_amount)||0),0);
    const totalCr = items.reduce((a,i)=>a+(parseFloat(i.cr_amount)||0),0);
 
    if (Math.abs(totalDr - totalCr) > 0.01) {
      return res.status(400).json({ success:false, message:`Voucher not balanced! Debit: Rs.${totalDr.toFixed(2)}, Credit: Rs.${totalCr.toFixed(2)}. Difference: Rs.${Math.abs(totalDr-totalCr).toFixed(2)}` });
    }
 
    const id = uuid();
    const voucher_no = genVoucherNo(req.params.companyId, voucher_type);
 
    db.prepare(`INSERT INTO vouchers (id,user_id,company_id,voucher_no,voucher_type,date,ref_no,narration,party_ledger_id,party_name,total_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.user.id, req.params.companyId, voucher_no, voucher_type, date, ref_no||null, narration||null, party_ledger_id||null, party_name||null, totalDr);
 
    const insertItem = db.prepare("INSERT INTO voucher_items (id,voucher_id,ledger_id,ledger_name,dr_amount,cr_amount,narration,sort_order) VALUES (?,?,?,?,?,?,?,?)");
    const insertAll = db.transaction((itms) => {
      itms.forEach((item, idx) => {
        const ledger = db.prepare("SELECT id,name FROM ledgers WHERE id=?").get(item.ledger_id);
        if (!ledger) throw new Error(`Ledger not found: ${item.ledger_id}`);
        insertItem.run(uuid(), id, item.ledger_id, ledger.name, parseFloat(item.dr_amount)||0, parseFloat(item.cr_amount)||0, item.narration||null, idx);
      });
    });
    insertAll(items);
 
    const voucher = db.prepare("SELECT * FROM vouchers WHERE id=?").get(id);
    const vItems  = db.prepare("SELECT * FROM voucher_items WHERE voucher_id=?").all(id);
    res.status(201).json({ success:true, message:"Voucher created", voucher:{ ...voucher, items:vItems } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.patch("/companies/:companyId/vouchers/:id/cancel", (req, res) => {
  try {
    db.prepare("UPDATE vouchers SET is_cancelled=1,updated_at=datetime('now') WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
    res.json({ success:true, message:"Voucher cancelled" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.delete("/companies/:companyId/vouchers/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM voucher_items WHERE voucher_id=?").run(req.params.id);
    db.prepare("DELETE FROM vouchers WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
    res.json({ success:true, message:"Voucher deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
// ════════════════════════════════════════════════════════════════
// ACCOUNTING REPORTS
// ════════════════════════════════════════════════════════════════
 
// Trial Balance
router.get("/companies/:companyId/reports/trial-balance", (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const companyId = req.params.companyId;
    const ledgers = db.prepare("SELECT l.*,g.name as group_name,g.nature FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.company_id=? AND l.user_id=?").all(companyId, req.user.id);
 
    let totalDr=0, totalCr=0;
    const rows = ledgers.map(l => {
      let q = "SELECT COALESCE(SUM(dr_amount),0) as dr, COALESCE(SUM(cr_amount),0) as cr FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=? AND v.is_cancelled=0";
      const params = [l.id];
      if (from_date) { q+=" AND v.date>=?"; params.push(from_date); }
      if (to_date)   { q+=" AND v.date<=?"; params.push(to_date); }
      const txn = db.prepare(q).get(...params);
      const opDr = l.opening_type==="Dr" ? l.opening_balance : 0;
      const opCr = l.opening_type==="Cr" ? l.opening_balance : 0;
      const netDr = opDr + (txn?.dr||0);
      const netCr = opCr + (txn?.cr||0);
      const balance = Math.abs(netDr - netCr);
      const balance_type = netDr >= netCr ? "Dr" : "Cr";
      if (balance_type==="Dr") totalDr += balance;
      else totalCr += balance;
      return { id:l.id, name:l.name, group:l.group_name, nature:l.nature, dr_amount:netDr>=netCr?balance:0, cr_amount:netCr>netDr?balance:0, balance, balance_type };
    }).filter(r => r.balance > 0);
 
    res.json({ success:true, rows, totals:{ dr:totalDr, cr:totalCr, balanced:Math.abs(totalDr-totalCr)<0.01 } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
// Profit & Loss Account
router.get("/companies/:companyId/reports/profit-loss", (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const companyId = req.params.companyId;
 
    const getLedgerBalance = (ledgerId) => {
      let q = "SELECT COALESCE(SUM(dr_amount),0) as dr, COALESCE(SUM(cr_amount),0) as cr FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=? AND v.is_cancelled=0";
      const params = [ledgerId];
      if (from_date) { q+=" AND v.date>=?"; params.push(from_date); }
      if (to_date)   { q+=" AND v.date<=?"; params.push(to_date); }
      return db.prepare(q).get(...params);
    };
 
    const groups = db.prepare("SELECT * FROM ledger_groups WHERE company_id=? AND user_id=?").all(companyId, req.user.id);
    const ledgers = db.prepare("SELECT l.*,g.nature FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.company_id=? AND l.user_id=?").all(companyId, req.user.id);
 
    const sections = { income:[], directExpense:[], indirectExpense:[], purchase:[], sales:[] };
    let grossProfit=0, netProfit=0, totalIncome=0, totalExpense=0;
 
    for (const l of ledgers) {
      const txn = getLedgerBalance(l.id);
      const netDr = (txn?.dr||0);
      const netCr = (txn?.cr||0);
      const balance = netCr - netDr;
 
      if (l.nature==="Income") {
        const amt = balance;
        if (l.group_id && groups.find(g=>g.id===l.group_id)?.name==="Sales Accounts") sections.sales.push({name:l.name, amount:amt});
        else sections.income.push({name:l.name, amount:amt});
        totalIncome += amt;
      } else if (l.nature==="Expense") {
        const amt = netDr - netCr;
        const grp = groups.find(g=>g.id===l.group_id);
        if (grp?.affects_gross) { sections.directExpense.push({name:l.name, amount:amt}); }
        else { sections.indirectExpense.push({name:l.name, amount:amt}); }
        totalExpense += amt;
      }
    }
 
    grossProfit = totalIncome - sections.directExpense.reduce((a,i)=>a+i.amount,0);
    netProfit   = totalIncome - totalExpense;
 
    res.json({ success:true, report:{ sales:sections.sales, direct_expenses:sections.directExpense, indirect_income:sections.income, indirect_expenses:sections.indirectExpense, gross_profit:grossProfit, net_profit:netProfit, total_income:totalIncome, total_expense:totalExpense } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
// Balance Sheet
router.get("/companies/:companyId/reports/balance-sheet", (req, res) => {
  try {
    const { as_on_date } = req.query;
    const companyId = req.params.companyId;
    const ledgers = db.prepare("SELECT l.*,g.name as group_name,g.nature,g.parent_id FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.company_id=? AND l.user_id=?").all(companyId, req.user.id);
 
    const getLedgerBalance = (ledgerId) => {
      let q = "SELECT COALESCE(SUM(dr_amount),0) as dr, COALESCE(SUM(cr_amount),0) as cr FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=? AND v.is_cancelled=0";
      const params = [ledgerId];
      if (as_on_date) { q+=" AND v.date<=?"; params.push(as_on_date); }
      return db.prepare(q).get(...params);
    };
 
    const assets=[], liabilities=[];
    let totalAssets=0, totalLiabilities=0;
 
    for (const l of ledgers) {
      const txn = getLedgerBalance(l.id);
      const opDr = l.opening_type==="Dr"?l.opening_balance:0;
      const opCr = l.opening_type==="Cr"?l.opening_balance:0;
      const netDr = opDr + (txn?.dr||0);
      const netCr = opCr + (txn?.cr||0);
      const balance = Math.abs(netDr - netCr);
      const balance_type = netDr>=netCr?"Dr":"Cr";
      if (balance===0) continue;
 
      const entry = { name:l.name, group:l.group_name, balance, balance_type };
      if (l.nature==="Asset") { assets.push(entry); totalAssets+=balance; }
      else if (l.nature==="Liability") { liabilities.push(entry); totalLiabilities+=balance; }
    }
 
    res.json({ success:true, as_on_date:as_on_date||new Date().toISOString().split("T")[0], assets, liabilities, total_assets:totalAssets, total_liabilities:totalLiabilities, difference:Math.abs(totalAssets-totalLiabilities) });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
// Day Book
router.get("/companies/:companyId/reports/day-book", (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split("T")[0];
    const vouchers = db.prepare("SELECT * FROM vouchers WHERE company_id=? AND user_id=? AND date=? AND is_cancelled=0 ORDER BY created_at ASC").all(req.params.companyId, req.user.id, targetDate);
    const withItems = vouchers.map(v => {
      const items = db.prepare("SELECT * FROM voucher_items WHERE voucher_id=?").all(v.id);
      return { ...v, items };
    });
    const totalDr = withItems.reduce((a,v)=>a+v.items.reduce((b,i)=>b+(i.dr_amount||0),0),0);
    const totalCr = withItems.reduce((a,v)=>a+v.items.reduce((b,i)=>b+(i.cr_amount||0),0),0);
    res.json({ success:true, date:targetDate, vouchers:withItems, summary:{ total_vouchers:vouchers.length, total_dr:totalDr, total_cr:totalCr } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
// Cash Book
router.get("/companies/:companyId/reports/cash-book", (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    // Find cash ledger
    const cashLedger = db.prepare("SELECT l.* FROM ledgers l JOIN ledger_groups g ON l.group_id=g.id WHERE l.company_id=? AND l.user_id=? AND l.name='Cash' LIMIT 1").get(req.params.companyId, req.user.id);
    if (!cashLedger) return res.status(404).json({ success:false, message:"Cash ledger not found" });
    let q = "SELECT vi.*,v.date,v.voucher_no,v.voucher_type,v.narration as v_narration,v.party_name FROM voucher_items vi JOIN vouchers v ON vi.voucher_id=v.id WHERE vi.ledger_id=? AND v.is_cancelled=0";
    const params = [cashLedger.id];
    if (from_date) { q+=" AND v.date>=?"; params.push(from_date); }
    if (to_date)   { q+=" AND v.date<=?"; params.push(to_date); }
    q += " ORDER BY v.date ASC";
    const transactions = db.prepare(q).all(...params);
    const totalDr = transactions.reduce((a,t)=>a+(t.dr_amount||0),0);
    const totalCr = transactions.reduce((a,t)=>a+(t.cr_amount||0),0);
    res.json({ success:true, ledger:cashLedger, transactions, summary:{ opening:cashLedger.opening_balance, opening_type:cashLedger.opening_type, total_receipts:totalDr, total_payments:totalCr, closing:cashLedger.opening_balance+totalDr-totalCr } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
// ════════════════════════════════════════════════════════════════
// GODOWN ROUTES
// ════════════════════════════════════════════════════════════════
 
router.get("/companies/:companyId/godowns", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM godowns WHERE company_id=? AND user_id=? ORDER BY name ASC").all(req.params.companyId, req.user.id);
    res.json({ success:true, godowns:rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});
 
router.post("/companies/:companyId/godowns", (req, res) => {
  try {
    const { name, address } = req.body;
    if (!name) return res.status(400).json({ success:false, message:"Godown name required" });
    const id = uuid();
    db.prepare("INSERT INTO godowns (id,user_id,company_id,name,address) VALUES (?,?,?,?,?)").run(id, req.user.id, req.params.companyId, name, address||null);
    res.status(201).json({ success:true, message:"Godown created" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});