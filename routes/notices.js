const express = require("express");
const { v4: uuid } = require("uuid");
const { body, validationResult } = require("express-validator");
const pool = require("../config/database");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

router.get("/", async (req, res) => {
  try {
    const { status, priority, client_id } = req.query;
    let query = "SELECT n.*, c.name as client_name, c.gstin FROM notices n JOIN clients c ON n.client_id=c.id WHERE n.user_id=$1";
    const params = [req.user.id];
    if (status)    { query += ` AND n.status=$${params.length+1}`;    params.push(status);    }
    if (priority)  { query += ` AND n.priority=$${params.length+1}`;  params.push(priority);  }
    if (client_id) { query += ` AND n.client_id=$${params.length+1}`; params.push(client_id); }
    query += " ORDER BY n.due_date ASC";
    const result = await pool.query(query, params);
    res.json({ success: true, count: result.rows.length, notices: result.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post("/", [
  body("client_id").notEmpty(),
  body("ref_no").trim().notEmpty(),
  body("type").trim().notEmpty(),
  body("issued_date").notEmpty(),
  body("due_date").notEmpty(),
  body("amount").isNumeric(),
  body("priority").isIn(["critical","high","medium","low"]),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { client_id, ref_no, type, issued_date, due_date, amount, priority, description } = req.body;
    const client = await pool.query("SELECT id FROM clients WHERE id=$1 AND user_id=$2", [client_id, req.user.id]);
    if (!client.rows[0]) return res.status(404).json({ success: false, message: "Client not found" });
    const today = new Date().toISOString().split("T")[0];
    const status = new Date(due_date) < new Date(today) ? "overdue" : "pending";
    const id = uuid();
    await pool.query(
      "INSERT INTO notices (id,user_id,client_id,ref_no,type,issued_date,due_date,amount,status,priority,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [id, req.user.id, client_id, ref_no, type, issued_date, due_date, amount, status, priority, description||null]
    );
    const notice = await pool.query("SELECT * FROM notices WHERE id=$1", [id]);
    res.status(201).json({ success: true, message: "Notice added", notice: notice.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put("/:id", async (req, res) => {
  try {
    const n = await pool.query("SELECT id FROM notices WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!n.rows[0]) return res.status(404).json({ success: false, message: "Notice not found" });
    const { type, issued_date, due_date, amount, status, priority, description, reply_text } = req.body;
    await pool.query(
      "UPDATE notices SET type=$1,issued_date=$2,due_date=$3,amount=$4,status=$5,priority=$6,description=$7,reply_text=$8,updated_at=NOW() WHERE id=$9",
      [type, issued_date, due_date, amount, status, priority, description||null, reply_text||null, req.params.id]
    );
    const updated = await pool.query("SELECT * FROM notices WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Notice updated", notice: updated.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const n = await pool.query("SELECT id FROM notices WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!n.rows[0]) return res.status(404).json({ success: false, message: "Notice not found" });
    await pool.query("UPDATE notices SET status=$1,updated_at=NOW() WHERE id=$2", [status, req.params.id]);
    res.json({ success: true, message: "Status updated" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const n = await pool.query("SELECT id FROM notices WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!n.rows[0]) return res.status(404).json({ success: false, message: "Notice not found" });
    await pool.query("DELETE FROM notices WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Notice deleted" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;