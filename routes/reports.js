const express = require("express");
const pool = require("../config/database");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// GET compliance report
router.get("/compliance", async (req, res) => {
  try {
    const { period } = req.query;
    const uid = req.user.id;

    const clients = await pool.query("SELECT * FROM clients WHERE user_id=$1 ORDER BY name", [uid]);

    const report = await Promise.all(clients.rows.map(async (c) => {
      const notices = await pool.query(
        "SELECT COUNT(*) as cnt FROM notices WHERE client_id=$1 AND status NOT IN ('closed','replied')", [c.id]
      );
      const returns = period ? await pool.query(
        "SELECT * FROM returns WHERE client_id=$1 AND period=$2", [c.id, period]
      ) : { rows: [] };

      const reco = await pool.query(
        "SELECT COUNT(*) as total, SUM(CASE WHEN status='mismatch' THEN 1 ELSE 0 END) as mismatches, SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END) as missing FROM reconciliation WHERE client_id=$1",
        [c.id]
      );

      return {
        client: c,
        open_notices: parseInt(notices.rows[0].cnt),
        returns: returns.rows[0] || null,
        reconciliation: reco.rows[0],
      };
    }));

    res.json({ success: true, period: period || "All", report });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET ITC summary report
router.get("/itc-summary", async (req, res) => {
  try {
    const { period } = req.query;
    const uid = req.user.id;

    const result = await pool.query(`
      SELECT c.name, c.gstin,
        SUM(r.gstr2b_amount) as total_gstr2b,
        SUM(r.books_amount) as total_books,
        SUM(r.difference) as total_diff,
        COUNT(CASE WHEN r.status='mismatch' THEN 1 END) as mismatches,
        COUNT(CASE WHEN r.status='missing' THEN 1 END) as missing
      FROM reconciliation r
      JOIN clients c ON r.client_id = c.id
      WHERE r.user_id=$1 ${period ? "AND r.period=$2" : ""}
      GROUP BY c.id, c.name, c.gstin
      ORDER BY ABS(SUM(r.difference)) DESC
    `, period ? [uid, period] : [uid]);

    res.json({ success: true, summary: result.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET notice summary report
router.get("/notices-summary", async (req, res) => {
  try {
    const uid = req.user.id;
    const result = await pool.query(`
      SELECT c.name, c.gstin,
        COUNT(*) as total_notices,
        SUM(amount) as total_amount,
        COUNT(CASE WHEN status='pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status='overdue' THEN 1 END) as overdue,
        COUNT(CASE WHEN status='closed' THEN 1 END) as closed
      FROM notices n
      JOIN clients c ON n.client_id = c.id
      WHERE n.user_id=$1
      GROUP BY c.id, c.name, c.gstin
      ORDER BY total_notices DESC
    `, [uid]);
    res.json({ success: true, summary: result.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET challan summary
router.get("/challan-summary", async (req, res) => {
  try {
    const uid = req.user.id;
    const result = await pool.query(`
      SELECT c.name, c.gstin,
        COUNT(ch.*) as total_challans,
        SUM(ch.amount) as total_paid,
        ch.period
      FROM challans ch
      JOIN clients c ON ch.client_id = c.id
      WHERE ch.user_id=$1
      GROUP BY c.id, c.name, c.gstin, ch.period
      ORDER BY c.name
    `, [uid]);
    res.json({ success: true, summary: result.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;