const express = require("express");
const { v4: uuid } = require("uuid");
const { body, validationResult } = require("express-validator");
const pool = require("../config/database");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// GET all products
router.get("/", async (req, res) => {
  try {
    const { search, category, low_stock } = req.query;
    let query = "SELECT * FROM products WHERE user_id=$1";
    const params = [req.user.id];
    if (search) { query += ` AND (name ILIKE $${params.length+1} OR code ILIKE $${params.length+2})`; params.push(`%${search}%`,`%${search}%`); }
    if (category) { query += ` AND category=$${params.length+1}`; params.push(category); }
    if (low_stock === "true") { query += ` AND stock_qty <= min_stock`; }
    query += " ORDER BY name ASC";
    const result = await pool.query(query, params);
    res.json({ success: true, count: result.rows.length, products: result.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET single product
router.get("/:id", async (req, res) => {
  try {
    const p = await pool.query("SELECT * FROM products WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!p.rows[0]) return res.status(404).json({ success: false, message: "Product not found" });
    const movements = await pool.query("SELECT * FROM stock_movements WHERE product_id=$1 ORDER BY created_at DESC LIMIT 20", [req.params.id]);
    res.json({ success: true, product: { ...p.rows[0], movements: movements.rows } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST create product
router.post("/", [
  body("name").trim().notEmpty().withMessage("Product name required"),
  body("gst_rate").isNumeric().withMessage("GST rate must be a number"),
  body("sale_price").isNumeric().withMessage("Sale price must be a number"),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { name, code, hsn_sac, unit, category, gst_rate, purchase_price, sale_price, stock_qty, min_stock, description, is_service } = req.body;
    const id = uuid();
    await pool.query(`
      INSERT INTO products (id,user_id,name,code,hsn_sac,unit,category,gst_rate,purchase_price,sale_price,stock_qty,min_stock,description,is_service)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [id, req.user.id, name, code||null, hsn_sac||null, unit||"PCS", category||null, gst_rate||18, purchase_price||0, sale_price||0, stock_qty||0, min_stock||0, description||null, is_service||false]);

    // Record opening stock movement
    if (parseFloat(stock_qty) > 0) {
      await pool.query(
        "INSERT INTO stock_movements (id,user_id,product_id,type,qty,rate,reference,notes) VALUES ($1,$2,$3,'OPENING',$4,$5,'Opening Stock','Opening stock entry')",
        [uuid(), req.user.id, id, stock_qty, purchase_price||0]
      );
    }
    const product = await pool.query("SELECT * FROM products WHERE id=$1", [id]);
    res.status(201).json({ success: true, message: "Product added", product: product.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT update product
router.put("/:id", async (req, res) => {
  try {
    const p = await pool.query("SELECT id FROM products WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!p.rows[0]) return res.status(404).json({ success: false, message: "Product not found" });
    const { name, code, hsn_sac, unit, category, gst_rate, purchase_price, sale_price, min_stock, description, is_service } = req.body;
    await pool.query(`
      UPDATE products SET name=$1,code=$2,hsn_sac=$3,unit=$4,category=$5,gst_rate=$6,
      purchase_price=$7,sale_price=$8,min_stock=$9,description=$10,is_service=$11,updated_at=NOW()
      WHERE id=$12
    `, [name, code||null, hsn_sac||null, unit||"PCS", category||null, gst_rate||18, purchase_price||0, sale_price||0, min_stock||0, description||null, is_service||false, req.params.id]);
    const updated = await pool.query("SELECT * FROM products WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Product updated", product: updated.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE product
router.delete("/:id", async (req, res) => {
  try {
    const p = await pool.query("SELECT id FROM products WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!p.rows[0]) return res.status(404).json({ success: false, message: "Product not found" });
    await pool.query("DELETE FROM products WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Product deleted" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST adjust stock
router.post("/:id/stock", async (req, res) => {
  try {
    const { type, qty, rate, notes, reference } = req.body;
    if (!qty || !type) return res.status(400).json({ success: false, message: "Type and qty required" });
    const p = await pool.query("SELECT * FROM products WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!p.rows[0]) return res.status(404).json({ success: false, message: "Product not found" });

    const adjustment = type === "IN" ? parseFloat(qty) : -parseFloat(qty);
    const newStock = parseFloat(p.rows[0].stock_qty) + adjustment;
    if (newStock < 0) return res.status(400).json({ success: false, message: "Insufficient stock" });

    await pool.query("UPDATE products SET stock_qty=$1, updated_at=NOW() WHERE id=$2", [newStock, req.params.id]);
    await pool.query(
      "INSERT INTO stock_movements (id,user_id,product_id,type,qty,rate,reference,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [uuid(), req.user.id, req.params.id, type, Math.abs(parseFloat(qty)), rate||0, reference||null, notes||null]
    );
    res.json({ success: true, message: "Stock adjusted", new_stock: newStock });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET stock report
router.get("/report/stock", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*,
        CASE WHEN p.stock_qty <= p.min_stock THEN true ELSE false END as is_low_stock,
        p.stock_qty * p.purchase_price as stock_value
      FROM products p
      WHERE p.user_id=$1
      ORDER BY p.name ASC
    `, [req.user.id]);
    const totalValue = result.rows.reduce((a,p) => a + parseFloat(p.stock_value||0), 0);
    const lowStock   = result.rows.filter(p => p.is_low_stock).length;
    res.json({ success: true, products: result.rows, summary: { total_items: result.rows.length, total_value: totalValue, low_stock_items: lowStock } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;