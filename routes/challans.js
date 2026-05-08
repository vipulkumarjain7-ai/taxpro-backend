const express = require("express");
const { v4: uuid } = require("uuid");
const { body, validationResult } = require("express-validator");
const pool = require("../config/database");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// GET all challans
router.get("/", async (req, res) => {
  try {
    const { client_id, status } = req.query;
    let query = `SELECT ch.*, c.name as client_name, c.gstin FROM challans ch
                 JOIN clients c ON ch.client_id = c.id
                 WHERE ch.user_id = $1`;
    const params = [req.user.id];
    if (client_id) { query += ` AND ch.client_id = $${params.length+1}`; params.push(client_id); }
    if (status)    { query += ` AND ch.status = $${params.length+1}`;    params.push(status);    }
    query += " ORDER BY ch.created_at DESC";
    const result = await pool.query(query, params);
    res.json({ success: true, challans: result.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST create challans
router.post("/", [
  body("client_id").notEmpty().withMessage("Client is required"),
  body("challan_no").trim().notEmpty().withMessage("Challan number is required"),
  body("type").trim().notEmpty().withMessage("Type is required"),
  body("amount").isNumeric().withMessage("Amount must be a number"),
  body("payment_date").notEmpty().withMessage("Payment date is required"),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { client_id, challan_no, type, amount, period, payment_date, notes } = req.body;
    const client = await pool.query("SELECT id FROM clients WHERE id=$1 AND user_id=$2", [client_id, req.user.id]);
    if (!client.rows[0]) return res.status(404).json({ success: false, message: "Client not found" });
    const id = uuid();
    await pool.query(
      "INSERT INTO challans (id,user_id,client_id,challan_no,type,amount,period,payment_date,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'paid',$9)",
      [id, req.user.id, client_id, challan_no, type, amount, period||null, payment_date, notes||null]
    );
    const ch = await pool.query("SELECT * FROM challans WHERE id=$1", [id]);
    res.status(201).json({ success: true, message: "Challan added", challan: ch.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT update challans
router.put("/:id", async (req, res) => {
  try {
    const ch = await pool.query("SELECT id FROM challans WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!ch.rows[0]) return res.status(404).json({ success: false, message: "Challan not found" });
    const { challan_no, type, amount, period, payment_date, status, notes } = req.body;
    await pool.query(
      "UPDATE challans SET challan_no=$1,type=$2,amount=$3,period=$4,payment_date=$5,status=$6,notes=$7,updated_at=NOW() WHERE id=$8",
      [challan_no, type, amount, period||null, payment_date, status, notes||null, req.params.id]
    );
    const updated = await pool.query("SELECT * FROM challans WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Challan updated", challan: updated.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE challans
router.delete("/:id", async (req, res) => {
  try {
    const ch = await pool.query("SELECT id FROM challans WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!ch.rows[0]) return res.status(404).json({ success: false, message: "Challan not found" });
    await pool.query("DELETE FROM challans WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Challan deleted" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;