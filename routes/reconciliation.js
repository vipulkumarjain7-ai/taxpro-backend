const recoRouter = express.Router();
recoRouter.use(auth);
 
recoRouter.get("/", async (req, res) => {
  try {
    const { client_id, period, status } = req.query;
    if (!client_id || !period) return res.status(400).json({ success: false, message: "client_id and period required" });
    let query = "SELECT * FROM reconciliation WHERE user_id=$1 AND client_id=$2 AND period=$3";
    const params = [req.user.id, client_id, period];
    if (status) { query += ` AND status=$${params.length+1}`; params.push(status); }
    query += " ORDER BY vendor_name ASC";
    const rows = await pool.query(query, params);
    const matched  = rows.rows.filter(r=>r.status==="matched").length;
    const mismatch = rows.rows.filter(r=>r.status==="mismatch").length;
    const missing  = rows.rows.filter(r=>r.status==="missing").length;
    const totalRisk = rows.rows.reduce((a,r)=>a+parseFloat(r.difference||0),0);
    res.json({ success: true, count: rows.rows.length, summary: { matched, mismatch, missing, total_itc_risk: totalRisk }, rows: rows.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
 
recoRouter.post("/", async (req, res) => {
  try {
    const { client_id, period, vendor_name, vendor_gstin, invoice_count, gstr2a_amount, gstr2b_amount, books_amount, remarks } = req.body;
    const client = await pool.query("SELECT id FROM clients WHERE id=$1 AND user_id=$2", [client_id, req.user.id]);
    if (!client.rows[0]) return res.status(404).json({ success: false, message: "Client not found" });
    const g2a = parseFloat(gstr2a_amount)||0, g2b = parseFloat(gstr2b_amount)||0, bks = parseFloat(books_amount)||0;
    const diff = g2b - bks;
    let status = "matched";
    if (g2b===0 && bks>0) status = "missing";
    else if (Math.abs(diff)>0) status = "mismatch";
    const id = uuid();
    await pool.query(
      "INSERT INTO reconciliation (id,user_id,client_id,period,vendor_name,vendor_gstin,invoice_count,gstr2a_amount,gstr2b_amount,books_amount,difference,status,remarks) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [id, req.user.id, client_id, period, vendor_name, (vendor_gstin||"").toUpperCase(), invoice_count||0, g2a, g2b, bks, diff, status, remarks||null]
    );
    const row = await pool.query("SELECT * FROM reconciliation WHERE id=$1", [id]);
    res.status(201).json({ success: true, message: "Entry added", row: row.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
 
recoRouter.delete("/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT id FROM reconciliation WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: "Entry not found" });
    await pool.query("DELETE FROM reconciliation WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Entry deleted" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
 
module.exports.recoRouter = recoRouter;