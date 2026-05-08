const express = require("express");
const { v4: uuid } = require("uuid");
const { body, validationResult } = require("express-validator");
const pool = require("../config/database");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

const VALID_TYPES = ["Manufacturer","Trader","Exporter","Importer","Service","Composition"];
const VALID_STATUSES = ["compliant","pending","notice","overdue"];

router.get("/", async (req, res) => {
  try {
    const { search, status, type } = req.query;
    let query = "SELECT c.*, (SELECT COUNT(*) FROM notices n WHERE n.client_id=c.id AND n.status NOT IN ('closed','replied')) as notice_count FROM clients c WHERE c.user_id=$1";
    const params = [req.user.id];
    if (search) { query += ` AND (c.name ILIKE $${params.length+1} OR c.gstin ILIKE $${params.length+2})`; params.push(`%${search}%`, `%${search}%`); }
    if (status) { query += ` AND c.status=$${params.length+1}`; params.push(status); }
    if (type)   { query += ` AND c.type=$${params.length+1}`;   params.push(type);   }
    query += " ORDER BY c.name ASC";
    const result = await pool.query(query, params);
    res.json({ success: true, count: result.rows.length, clients: result.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const c = await pool.query("SELECT * FROM clients WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!c.rows[0]) return res.status(404).json({ success: false, message: "Client not found" });
    const notices = await pool.query("SELECT * FROM notices WHERE client_id=$1 ORDER BY due_date ASC", [req.params.id]);
    const returns = await pool.query("SELECT * FROM returns WHERE client_id=$1 ORDER BY period DESC", [req.params.id]);
    res.json({ success: true, client: { ...c.rows[0], notices: notices.rows, returns: returns.rows } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post("/", [
  body("name").trim().notEmpty(),
  body("gstin").trim().isLength({ min:15, max:15 }).withMessage("GSTIN must be 15 characters"),
  body("state").trim().notEmpty(),
  body("type").isIn(VALID_TYPES),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { name, gstin, state, type, turnover, notes } = req.body;
    const exists = await pool.query("SELECT id FROM clients WHERE user_id=$1 AND gstin=$2", [req.user.id, gstin.toUpperCase()]);
    if (exists.rows[0]) return res.status(409).json({ success: false, message: "GSTIN already exists" });
    const id = uuid();
    await pool.query(
      "INSERT INTO clients (id,user_id,name,gstin,state,type,turnover,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, req.user.id, name, gstin.toUpperCase(), state, type, turnover||null, notes||null]
    );
    const client = await pool.query("SELECT * FROM clients WHERE id=$1", [id]);
    res.status(201).json({ success: true, message: "Client added", client: client.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put("/:id", [
  body("name").trim().notEmpty(),
  body("state").trim().notEmpty(),
  body("type").isIn(VALID_TYPES),
  body("status").isIn(VALID_STATUSES),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const c = await pool.query("SELECT id FROM clients WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!c.rows[0]) return res.status(404).json({ success: false, message: "Client not found" });
    const { name, state, type, status, turnover, notes } = req.body;
    await pool.query(
      "UPDATE clients SET name=$1,state=$2,type=$3,status=$4,turnover=$5,notes=$6,updated_at=NOW() WHERE id=$7",
      [name, state, type, status, turnover||null, notes||null, req.params.id]
    );
    const updated = await pool.query("SELECT * FROM clients WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Client updated", client: updated.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const c = await pool.query("SELECT id FROM clients WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!c.rows[0]) return res.status(404).json({ success: false, message: "Client not found" });
    await pool.query("DELETE FROM clients WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Client deleted" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;