const express = require("express");
const { v4: uuid } = require("uuid");
const { body, validationResult } = require("express-validator");
const pool = require("../config/database");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

router.get("/", async (req, res) => {
  try {
    const { period, client_id } = req.query;
    let query = "SELECT r.*, c.name as client_name, c.gstin FROM returns r JOIN clients c ON r.client_id=c.id WHERE r.user_id=$1";
    const params = [req.user.id];
    if (period)    { query += ` AND r.period=$${params.length+1}`;    params.push(period);    }
    if (client_id) { query += ` AND r.client_id=$${params.length+1}`; params.push(client_id); }
    query += " ORDER BY c.name ASC, r.period DESC";
    const result = await pool.query(query, params);
    res.json({ success: true, count: result.rows.length, returns: result.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get("/summary", async (req, res) => {
  try {
    const { period } = req.query;
    if (!period) return res.status(400).json({ success: false, message: "Period required" });
    const count = async (field, status) => {
      const r = await pool.query(`SELECT COUNT(*) as cnt FROM returns WHERE user_id=$1 AND period=$2 AND ${field}=$3`, [req.user.id, period, status]);
      return parseInt(r.rows[0].cnt);
    };
    res.json({
      success: true, period,
      summary: {
        gstr1:  { filed: await count("gstr1_status","filed"),  pending: await count("gstr1_status","pending"),  not_filed: await count("gstr1_status","not-filed")  },
        gstr3b: { filed: await count("gstr3b_status","filed"), pending: await count("gstr3b_status","pending"), not_filed: await count("gstr3b_status","not-filed") },
        gstr9:  { filed: await count("gstr9_status","filed"),  pending: await count("gstr9_status","pending"),  not_filed: await count("gstr9_status","not-filed")  },
      }
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post("/", [
  body("client_id").notEmpty(),
  body("period").trim().notEmpty(),
  body("gstr1_status").isIn(["filed","pending","not-filed"]),
  body("gstr3b_status").isIn(["filed","pending","not-filed"]),
  body("gstr9_status").isIn(["filed","pending","not-filed"]),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { client_id, period, gstr1_status, gstr3b_status, gstr9_status, gstr1_date, gstr3b_date, gstr9_date, notes } = req.body;
    const client = await pool.query("SELECT id FROM clients WHERE id=$1 AND user_id=$2", [client_id, req.user.id]);
    if (!client.rows[0]) return res.status(404).json({ success: false, message: "Client not found" });
    const exists = await pool.query("SELECT id FROM returns WHERE user_id=$1 AND client_id=$2 AND period=$3", [req.user.id, client_id, period]);
    if (exists.rows[0]) return res.status(409).json({ success: false, message: "Record already exists for this period" });
    const id = uuid();
    await pool.query(
      "INSERT INTO returns (id,user_id,client_id,period,gstr1_status,gstr3b_status,gstr9_status,gstr1_date,gstr3b_date,gstr9_date,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [id, req.user.id, client_id, period, gstr1_status, gstr3b_status, gstr9_status, gstr1_date||null, gstr3b_date||null, gstr9_date||null, notes||null]
    );
    const rec = await pool.query("SELECT * FROM returns WHERE id=$1", [id]);
    res.status(201).json({ success: true, message: "Return record created", return: rec.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put("/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT id FROM returns WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: "Record not found" });
    const { gstr1_status, gstr3b_status, gstr9_status, gstr1_date, gstr3b_date, gstr9_date, notes } = req.body;
    await pool.query(
      "UPDATE returns SET gstr1_status=$1,gstr3b_status=$2,gstr9_status=$3,gstr1_date=$4,gstr3b_date=$5,gstr9_date=$6,notes=$7,updated_at=NOW() WHERE id=$8",
      [gstr1_status, gstr3b_status, gstr9_status, gstr1_date||null, gstr3b_date||null, gstr9_date||null, notes||null, req.params.id]
    );
    const updated = await pool.query("SELECT * FROM returns WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Return updated", return: updated.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT id FROM returns WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: "Record not found" });
    await pool.query("DELETE FROM returns WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Record deleted" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;