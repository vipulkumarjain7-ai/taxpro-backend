const express = require("express");
const { v4: uuid } = require("uuid");
const pool = require("../config/database");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// Generate invoice number
const generateInvoiceNo = async (userId, type) => {
  const prefix = type === "SALES" ? "INV" : type === "PURCHASE" ? "PUR" : type === "CREDIT" ? "CN" : "DN";
  const year = new Date().getFullYear().toString().slice(-2);
  const month = String(new Date().getMonth() + 1).padStart(2, "0");
  const result = await pool.query(
    "SELECT COUNT(*) as cnt FROM invoices WHERE user_id=$1 AND invoice_type=$2",
    [userId, type]
  );
  const count = parseInt(result.rows[0].cnt) + 1;
  return `${prefix}/${year}-${month}/${String(count).padStart(4, "0")}`;
};

// GET all invoices
router.get("/", async (req, res) => {
  try {
    const { type, status, party_id, from_date, to_date, search } = req.query;
    let query = "SELECT * FROM invoices WHERE user_id=$1";
    const params = [req.user.id];
    if (type)      { query += ` AND invoice_type=$${params.length+1}`;  params.push(type); }
    if (status)    { query += ` AND status=$${params.length+1}`;        params.push(status); }
    if (party_id)  { query += ` AND party_id=$${params.length+1}`;      params.push(party_id); }
    if (from_date) { query += ` AND invoice_date>=$${params.length+1}`; params.push(from_date); }
    if (to_date)   { query += ` AND invoice_date<=$${params.length+1}`; params.push(to_date); }
    if (search)    { query += ` AND (party_name ILIKE $${params.length+1} OR invoice_no ILIKE $${params.length+2})`; params.push(`%${search}%`,`%${search}%`); }
    query += " ORDER BY created_at DESC";
    const result = await pool.query(query, params);
    const totalAmount      = result.rows.reduce((a,i) => a + parseFloat(i.total_amount||0), 0);
    const totalPaid        = result.rows.reduce((a,i) => a + parseFloat(i.paid_amount||0), 0);
    const totalOutstanding = result.rows.reduce((a,i) => a + parseFloat(i.balance_due||0), 0);
    res.json({ success: true, count: result.rows.length, invoices: result.rows, summary: { total_amount: totalAmount, total_paid: totalPaid, total_outstanding: totalOutstanding } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET single invoice with items
router.get("/:id", async (req, res) => {
  try {
    const inv = await pool.query("SELECT * FROM invoices WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!inv.rows[0]) return res.status(404).json({ success: false, message: "Invoice not found" });
    const items = await pool.query("SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY id", [req.params.id]);
    const payments = await pool.query("SELECT * FROM payments WHERE invoice_id=$1 ORDER BY payment_date DESC", [req.params.id]);
    res.json({ success: true, invoice: { ...inv.rows[0], items: items.rows, payments: payments.rows } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST create invoice
router.post("/", async (req, res) => {
  try {
    const {
      invoice_type, party_id, party_name, party_gstin, party_address, party_state,
      invoice_date, due_date, place_of_supply, is_igst, notes, terms, items = []
    } = req.body;

    if (!party_name)    return res.status(400).json({ success: false, message: "Party name required" });
    if (!invoice_date)  return res.status(400).json({ success: false, message: "Invoice date required" });
    if (items.length === 0) return res.status(400).json({ success: false, message: "At least one item required" });

    const invoice_no = await generateInvoiceNo(req.user.id, invoice_type || "SALES");

    // Calculate totals
    let subtotal = 0, totalIGST = 0, totalCGST = 0, totalSGST = 0, totalCess = 0;

    const processedItems = items.map(item => {
      const qty          = parseFloat(item.qty) || 0;
      const rate         = parseFloat(item.rate) || 0;
      const discountPct  = parseFloat(item.discount_pct) || 0;
      const gstRate      = parseFloat(item.gst_rate) || 0;
      const grossValue   = qty * rate;
      const discountAmt  = grossValue * discountPct / 100;
      const taxableValue = grossValue - discountAmt;
      let igst = 0, cgst = 0, sgst = 0;
      if (is_igst) {
        igst = taxableValue * gstRate / 100;
      } else {
        cgst = taxableValue * (gstRate / 2) / 100;
        sgst = taxableValue * (gstRate / 2) / 100;
      }
      const total = taxableValue + igst + cgst + sgst;
      subtotal   += grossValue;
      totalIGST  += igst;
      totalCGST  += cgst;
      totalSGST  += sgst;
      return { ...item, taxable_value: taxableValue, igst_amount: igst, cgst_amount: cgst, sgst_amount: sgst, total_amount: total };
    });

    const taxableAmount = subtotal;
    const totalTax      = totalIGST + totalCGST + totalSGST + totalCess;
    const totalAmount   = taxableAmount + totalTax;
    const id = uuid();

    await pool.query(`
      INSERT INTO invoices
      (id,user_id,invoice_no,invoice_type,party_id,party_name,party_gstin,party_address,party_state,
       invoice_date,due_date,place_of_supply,is_igst,subtotal,taxable_amount,igst_amount,cgst_amount,
       sgst_amount,cess_amount,total_tax,total_amount,paid_amount,balance_due,status,notes,terms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
    `, [
      id, req.user.id, invoice_no, invoice_type||"SALES",
      party_id||null, party_name, party_gstin||null, party_address||null, party_state||null,
      invoice_date, due_date||null, place_of_supply||null, is_igst||false,
      subtotal, taxableAmount, totalIGST, totalCGST, totalSGST, totalCess,
      totalTax, totalAmount, 0, totalAmount, "unpaid", notes||null, terms||null
    ]);

    // Insert items
    for (const item of processedItems) {
      await pool.query(`
        INSERT INTO invoice_items
        (id,invoice_id,product_id,name,hsn_sac,unit,qty,rate,discount_pct,taxable_value,gst_rate,igst_amount,cgst_amount,sgst_amount,total_amount)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `, [
        uuid(), id, item.product_id||null, item.name, item.hsn_sac||null,
        item.unit||"PCS", item.qty, item.rate, item.discount_pct||0,
        item.taxable_value, item.gst_rate||0, item.igst_amount, item.cgst_amount, item.sgst_amount, item.total_amount
      ]);

      // Update stock for sales/purchase
      if (item.product_id) {
        const stockChange = (invoice_type === "SALES") ? -parseFloat(item.qty) : parseFloat(item.qty);
        const stockType   = (invoice_type === "SALES") ? "OUT" : "IN";
        const product = await pool.query("SELECT stock_qty FROM products WHERE id=$1", [item.product_id]);
        if (product.rows[0]) {
          const newStock = parseFloat(product.rows[0].stock_qty) + stockChange;
          await pool.query("UPDATE products SET stock_qty=$1, updated_at=NOW() WHERE id=$2", [Math.max(0, newStock), item.product_id]);
          await pool.query(
            "INSERT INTO stock_movements (id,user_id,product_id,type,qty,rate,reference,invoice_id,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [uuid(), req.user.id, item.product_id, stockType, Math.abs(parseFloat(item.qty)), item.rate, invoice_no, id, `${invoice_type} Invoice: ${invoice_no}`]
          );
        }
      }
    }

    const invoice = await pool.query("SELECT * FROM invoices WHERE id=$1", [id]);
    const invItems = await pool.query("SELECT * FROM invoice_items WHERE invoice_id=$1", [id]);
    res.status(201).json({ success: true, message: "Invoice created", invoice: { ...invoice.rows[0], items: invItems.rows } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT update invoice status
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const inv = await pool.query("SELECT id FROM invoices WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!inv.rows[0]) return res.status(404).json({ success: false, message: "Invoice not found" });
    await pool.query("UPDATE invoices SET status=$1, updated_at=NOW() WHERE id=$2", [status, req.params.id]);
    res.json({ success: true, message: "Status updated" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST record payment
router.post("/:id/payment", async (req, res) => {
  try {
    const { amount, method, reference_no, payment_date, notes } = req.body;
    if (!amount || !payment_date) return res.status(400).json({ success: false, message: "Amount and date required" });
    const inv = await pool.query("SELECT * FROM invoices WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!inv.rows[0]) return res.status(404).json({ success: false, message: "Invoice not found" });
    const paidAmt   = parseFloat(inv.rows[0].paid_amount) + parseFloat(amount);
    const balanceDue = parseFloat(inv.rows[0].total_amount) - paidAmt;
    const status    = balanceDue <= 0 ? "paid" : "partial";
    await pool.query(
      "UPDATE invoices SET paid_amount=$1, balance_due=$2, status=$3, updated_at=NOW() WHERE id=$4",
      [paidAmt, Math.max(0, balanceDue), status, req.params.id]
    );
    await pool.query(
      "INSERT INTO payments (id,user_id,invoice_id,party_id,party_name,type,amount,method,reference_no,payment_date,notes) VALUES ($1,$2,$3,$4,$5,'RECEIVED',$6,$7,$8,$9,$10)",
      [uuid(), req.user.id, req.params.id, inv.rows[0].party_id, inv.rows[0].party_name, amount, method||"CASH", reference_no||null, payment_date, notes||null]
    );
    res.json({ success: true, message: "Payment recorded", paid_amount: paidAmt, balance_due: Math.max(0, balanceDue) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE invoice
router.delete("/:id", async (req, res) => {
  try {
    const inv = await pool.query("SELECT * FROM invoices WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!inv.rows[0]) return res.status(404).json({ success: false, message: "Invoice not found" });
    await pool.query("DELETE FROM invoice_items WHERE invoice_id=$1", [req.params.id]);
    await pool.query("DELETE FROM invoices WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Invoice deleted" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET dashboard stats
router.get("/stats/summary", async (req, res) => {
  try {
    const uid = req.user.id;
    const today = new Date().toISOString().split("T")[0];
    const month = today.substring(0, 7);
    const [sales, purchases, outstanding, overdue] = await Promise.all([
      pool.query("SELECT COALESCE(SUM(total_amount),0) as total FROM invoices WHERE user_id=$1 AND invoice_type='SALES' AND invoice_date LIKE $2", [uid, `${month}%`]),
      pool.query("SELECT COALESCE(SUM(total_amount),0) as total FROM invoices WHERE user_id=$1 AND invoice_type='PURCHASE' AND invoice_date LIKE $2", [uid, `${month}%`]),
      pool.query("SELECT COALESCE(SUM(balance_due),0) as total FROM invoices WHERE user_id=$1 AND status IN ('unpaid','partial')", [uid]),
      pool.query("SELECT COALESCE(SUM(balance_due),0) as total FROM invoices WHERE user_id=$1 AND status IN ('unpaid','partial') AND due_date < $2", [uid, today]),
    ]);
    res.json({
      success: true,
      stats: {
        monthly_sales:     parseFloat(sales.rows[0].total),
        monthly_purchases: parseFloat(purchases.rows[0].total),
        total_outstanding: parseFloat(outstanding.rows[0].total),
        overdue_amount:    parseFloat(overdue.rows[0].total),
      }
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;