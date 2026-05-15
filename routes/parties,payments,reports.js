const express = require("express");
const { v4: uuid } = require("uuid");
const pool = require("../config/database");
const auth = require("../middleware/auth");

// ── PARTIES ROUTER ─────────────────────────────────────────────────────────
const partiesRouter = express.Router();
partiesRouter.use(auth);

partiesRouter.get("/", async (req, res) => {
  try {
    const { search, type } = req.query;
    let query = `
      SELECT c.*,
        COALESCE((SELECT SUM(balance_due) FROM invoices WHERE party_id=c.id AND status IN ('unpaid','partial')), 0) as outstanding
      FROM clients c WHERE c.user_id=$1
    `;
    const params = [req.user.id];
    if (search) { query += ` AND (c.name ILIKE $${params.length+1} OR c.gstin ILIKE $${params.length+2})`; params.push(`%${search}%`,`%${search}%`); }
    if (type)   { query += ` AND c.type=$${params.length+1}`; params.push(type); }
    query += " ORDER BY c.name ASC";
    const result = await pool.query(query, params);
    res.json({ success: true, parties: result.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

partiesRouter.get("/:id/ledger", async (req, res) => {
  try {
    const party = await pool.query("SELECT * FROM clients WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!party.rows[0]) return res.status(404).json({ success: false, message: "Party not found" });
    const invoices  = await pool.query("SELECT * FROM invoices WHERE party_id=$1 AND user_id=$2 ORDER BY invoice_date DESC", [req.params.id, req.user.id]);
    const payments  = await pool.query("SELECT * FROM payments WHERE party_id=$1 AND user_id=$2 ORDER BY payment_date DESC", [req.params.id, req.user.id]);
    const totalSales     = invoices.rows.filter(i=>i.invoice_type==="SALES").reduce((a,i)=>a+parseFloat(i.total_amount||0),0);
    const totalPurchases = invoices.rows.filter(i=>i.invoice_type==="PURCHASE").reduce((a,i)=>a+parseFloat(i.total_amount||0),0);
    const totalPaid      = payments.rows.reduce((a,p)=>a+parseFloat(p.amount||0),0);
    const outstanding    = invoices.rows.reduce((a,i)=>a+parseFloat(i.balance_due||0),0);
    res.json({ success: true, party: party.rows[0], invoices: invoices.rows, payments: payments.rows, summary: { total_sales: totalSales, total_purchases: totalPurchases, total_paid: totalPaid, outstanding } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

partiesRouter.post("/", async (req, res) => {
  try {
    const { name, gstin, state, type, phone, email, address, city, pincode, pan, credit_limit } = req.body;
    if (!name) return res.status(400).json({ success: false, message: "Name required" });
    const id = uuid();
    await pool.query(`
      INSERT INTO clients (id,user_id,name,gstin,state,type,phone,email,address,city,pincode,pan,credit_limit)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [id, req.user.id, name, gstin||null, state||null, type||"Customer", phone||null, email||null, address||null, city||null, pincode||null, pan||null, credit_limit||0]);
    const party = await pool.query("SELECT * FROM clients WHERE id=$1", [id]);
    res.status(201).json({ success: true, message: "Party added", party: party.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

partiesRouter.put("/:id", async (req, res) => {
  try {
    const p = await pool.query("SELECT id FROM clients WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!p.rows[0]) return res.status(404).json({ success: false, message: "Party not found" });
    const { name, gstin, state, type, phone, email, address, city, pincode, pan, credit_limit } = req.body;
    await pool.query(
      "UPDATE clients SET name=$1,gstin=$2,state=$3,type=$4,phone=$5,email=$6,address=$7,city=$8,pincode=$9,pan=$10,credit_limit=$11,updated_at=NOW() WHERE id=$12",
      [name, gstin||null, state||null, type||"Customer", phone||null, email||null, address||null, city||null, pincode||null, pan||null, credit_limit||0, req.params.id]
    );
    const updated = await pool.query("SELECT * FROM clients WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Party updated", party: updated.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

partiesRouter.delete("/:id", async (req, res) => {
  try {
    const p = await pool.query("SELECT id FROM clients WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!p.rows[0]) return res.status(404).json({ success: false, message: "Party not found" });
    await pool.query("DELETE FROM clients WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Party deleted" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports.partiesRouter = partiesRouter;

// ── PAYMENTS ROUTER ────────────────────────────────────────────────────────
const paymentsRouter = express.Router();
paymentsRouter.use(auth);

paymentsRouter.get("/", async (req, res) => {
  try {
    const { type, from_date, to_date } = req.query;
    let query = "SELECT * FROM payments WHERE user_id=$1";
    const params = [req.user.id];
    if (type)      { query += ` AND type=$${params.length+1}`;              params.push(type); }
    if (from_date) { query += ` AND payment_date>=$${params.length+1}`;     params.push(from_date); }
    if (to_date)   { query += ` AND payment_date<=$${params.length+1}`;     params.push(to_date); }
    query += " ORDER BY payment_date DESC";
    const result = await pool.query(query, params);
    res.json({ success: true, payments: result.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

paymentsRouter.post("/", async (req, res) => {
  try {
    const { party_id, party_name, type, amount, method, reference_no, payment_date, notes } = req.body;
    if (!amount || !payment_date) return res.status(400).json({ success: false, message: "Amount and date required" });
    const id = uuid();
    await pool.query(
      "INSERT INTO payments (id,user_id,invoice_id,party_id,party_name,type,amount,method,reference_no,payment_date,notes) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10)",
      [id, req.user.id, party_id||null, party_name||null, type||"RECEIVED", amount, method||"CASH", reference_no||null, payment_date, notes||null]
    );
    const payment = await pool.query("SELECT * FROM payments WHERE id=$1", [id]);
    res.status(201).json({ success: true, message: "Payment recorded", payment: payment.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports.paymentsRouter = paymentsRouter;

// ── REPORTS ROUTER ─────────────────────────────────────────────────────────
const reportsRouter = express.Router();
reportsRouter.use(auth);

// Sales Register
reportsRouter.get("/sales-register", async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    let query = "SELECT * FROM invoices WHERE user_id=$1 AND invoice_type='SALES'";
    const params = [req.user.id];
    if (from_date) { query += ` AND invoice_date>=$${params.length+1}`; params.push(from_date); }
    if (to_date)   { query += ` AND invoice_date<=$${params.length+1}`; params.push(to_date); }
    query += " ORDER BY invoice_date ASC";
    const result = await pool.query(query, params);
    const summary = {
      total_invoices:  result.rows.length,
      total_taxable:   result.rows.reduce((a,i)=>a+parseFloat(i.taxable_amount||0),0),
      total_igst:      result.rows.reduce((a,i)=>a+parseFloat(i.igst_amount||0),0),
      total_cgst:      result.rows.reduce((a,i)=>a+parseFloat(i.cgst_amount||0),0),
      total_sgst:      result.rows.reduce((a,i)=>a+parseFloat(i.sgst_amount||0),0),
      total_amount:    result.rows.reduce((a,i)=>a+parseFloat(i.total_amount||0),0),
      total_collected: result.rows.reduce((a,i)=>a+parseFloat(i.paid_amount||0),0),
      total_pending:   result.rows.reduce((a,i)=>a+parseFloat(i.balance_due||0),0),
    };
    res.json({ success: true, invoices: result.rows, summary });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// Purchase Register
reportsRouter.get("/purchase-register", async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    let query = "SELECT * FROM invoices WHERE user_id=$1 AND invoice_type='PURCHASE'";
    const params = [req.user.id];
    if (from_date) { query += ` AND invoice_date>=$${params.length+1}`; params.push(from_date); }
    if (to_date)   { query += ` AND invoice_date<=$${params.length+1}`; params.push(to_date); }
    query += " ORDER BY invoice_date ASC";
    const result = await pool.query(query, params);
    const summary = {
      total_invoices: result.rows.length,
      total_taxable:  result.rows.reduce((a,i)=>a+parseFloat(i.taxable_amount||0),0),
      total_igst:     result.rows.reduce((a,i)=>a+parseFloat(i.igst_amount||0),0),
      total_cgst:     result.rows.reduce((a,i)=>a+parseFloat(i.cgst_amount||0),0),
      total_sgst:     result.rows.reduce((a,i)=>a+parseFloat(i.sgst_amount||0),0),
      total_amount:   result.rows.reduce((a,i)=>a+parseFloat(i.total_amount||0),0),
      total_itc:      result.rows.reduce((a,i)=>a+parseFloat(i.total_tax||0),0),
    };
    res.json({ success: true, invoices: result.rows, summary });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GST Summary Report
reportsRouter.get("/gst-summary", async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const params = [req.user.id];
    let dateFilter = "";
    if (from_date) { dateFilter += ` AND invoice_date>=$${params.length+1}`; params.push(from_date); }
    if (to_date)   { dateFilter += ` AND invoice_date<=$${params.length+1}`; params.push(to_date); }

    const salesQ    = await pool.query(`SELECT COALESCE(SUM(taxable_amount),0) as taxable, COALESCE(SUM(igst_amount),0) as igst, COALESCE(SUM(cgst_amount),0) as cgst, COALESCE(SUM(sgst_amount),0) as sgst, COALESCE(SUM(total_amount),0) as total FROM invoices WHERE user_id=$1 AND invoice_type='SALES'${dateFilter}`, params);
    const purchaseQ = await pool.query(`SELECT COALESCE(SUM(taxable_amount),0) as taxable, COALESCE(SUM(igst_amount),0) as igst, COALESCE(SUM(cgst_amount),0) as cgst, COALESCE(SUM(sgst_amount),0) as sgst, COALESCE(SUM(total_amount),0) as total FROM invoices WHERE user_id=$1 AND invoice_type='PURCHASE'${dateFilter}`, params);

    const sales    = salesQ.rows[0];
    const purchase = purchaseQ.rows[0];
    const outputTax = parseFloat(sales.igst) + parseFloat(sales.cgst) + parseFloat(sales.sgst);
    const inputTax  = parseFloat(purchase.igst) + parseFloat(purchase.cgst) + parseFloat(purchase.sgst);
    const netTax    = outputTax - inputTax;

    res.json({
      success: true,
      report: {
        sales:    { taxable: parseFloat(sales.taxable), igst: parseFloat(sales.igst), cgst: parseFloat(sales.cgst), sgst: parseFloat(sales.sgst), total: parseFloat(sales.total) },
        purchase: { taxable: parseFloat(purchase.taxable), igst: parseFloat(purchase.igst), cgst: parseFloat(purchase.cgst), sgst: parseFloat(purchase.sgst), total: parseFloat(purchase.total) },
        output_tax: outputTax,
        input_tax:  inputTax,
        net_gst_payable: netTax,
      }
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// Outstanding Report
reportsRouter.get("/outstanding", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT party_name, party_gstin,
        COUNT(*) as invoice_count,
        SUM(total_amount) as total_billed,
        SUM(paid_amount) as total_paid,
        SUM(balance_due) as outstanding,
        MIN(due_date) as oldest_due
      FROM invoices
      WHERE user_id=$1 AND status IN ('unpaid','partial') AND invoice_type='SALES'
      GROUP BY party_name, party_gstin
      ORDER BY outstanding DESC
    `, [req.user.id]);
    const total = result.rows.reduce((a,r)=>a+parseFloat(r.outstanding||0),0);
    res.json({ success: true, parties: result.rows, total_outstanding: total });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// Profit & Loss
reportsRouter.get("/profit-loss", async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const params = [req.user.id];
    let dateFilter = "";
    if (from_date) { dateFilter += ` AND invoice_date>=$${params.length+1}`; params.push(from_date); }
    if (to_date)   { dateFilter += ` AND invoice_date<=$${params.length+1}`; params.push(to_date); }

    const salesQ    = await pool.query(`SELECT COALESCE(SUM(taxable_amount),0) as total FROM invoices WHERE user_id=$1 AND invoice_type='SALES'${dateFilter}`, params);
    const purchaseQ = await pool.query(`SELECT COALESCE(SUM(taxable_amount),0) as total FROM invoices WHERE user_id=$1 AND invoice_type='PURCHASE'${dateFilter}`, params);

    const totalSales     = parseFloat(salesQ.rows[0].total);
    const totalPurchases = parseFloat(purchaseQ.rows[0].total);
    const grossProfit    = totalSales - totalPurchases;

    res.json({
      success: true,
      pl: {
        income: { sales: totalSales, total: totalSales },
        expenses: { purchases: totalPurchases, total: totalPurchases },
        gross_profit: grossProfit,
        net_profit: grossProfit,
      }
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// Day Book
reportsRouter.get("/day-book", async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split("T")[0];
    const [invoices, payments] = await Promise.all([
      pool.query("SELECT * FROM invoices WHERE user_id=$1 AND invoice_date=$2 ORDER BY created_at ASC", [req.user.id, targetDate]),
      pool.query("SELECT * FROM payments WHERE user_id=$1 AND payment_date=$2 ORDER BY created_at ASC", [req.user.id, targetDate]),
    ]);
    const totalSales     = invoices.rows.filter(i=>i.invoice_type==="SALES").reduce((a,i)=>a+parseFloat(i.total_amount||0),0);
    const totalPurchases = invoices.rows.filter(i=>i.invoice_type==="PURCHASE").reduce((a,i)=>a+parseFloat(i.total_amount||0),0);
    const totalReceived  = payments.rows.filter(p=>p.type==="RECEIVED").reduce((a,p)=>a+parseFloat(p.amount||0),0);
    const totalPaid      = payments.rows.filter(p=>p.type==="PAID").reduce((a,p)=>a+parseFloat(p.amount||0),0);
    res.json({ success: true, date: targetDate, invoices: invoices.rows, payments: payments.rows, summary: { total_sales: totalSales, total_purchases: totalPurchases, total_received: totalReceived, total_paid: totalPaid } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports.reportsRouter = reportsRouter;