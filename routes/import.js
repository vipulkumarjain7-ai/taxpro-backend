const express = require("express");
const { v4: uuid } = require("uuid");
const multer = require("multer");
const XLSX = require("xlsx");
const pool = require("../config/database");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);
const upload = multer({ storage: multer.memoryStorage() });

router.post("/clients", upload.single("file"), async (req, res) => {
  try {
    const workbook = XLSX.read(req.file.buffer, { type:"buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    let imported = 0, skipped = 0;
    for (const row of rows) {
      const gstin = (row["GSTIN"]||row["gstin"]||"").toString().trim().toUpperCase();
      const name  = (row["Name"]||row["name"]||row["Trade Name"]||"").toString().trim();
      if (!gstin||!name) { skipped++; continue; }
      const exists = await pool.query("SELECT id FROM clients WHERE user_id=$1 AND gstin=$2", [req.user.id, gstin]);
      if (exists.rows[0]) { skipped++; continue; }
      await pool.query(
        "INSERT INTO clients (id,user_id,name,gstin,state,type,turnover,status) VALUES($1,$2,$3,$4,$5,$6,$7,'compliant')",
        [uuid(), req.user.id, name, gstin, (row["State"]||row["state"]||"").toString().trim(), (row["Type"]||row["type"]||"Trader").toString().trim(), (row["Turnover"]||row["turnover"]||"").toString().trim()]
      );
      imported++;
    }
    res.json({ success: true, message: `${imported} clients imported, ${skipped} skipped` });
  } catch(e) { res.status(500).json({ success: false, message: "Import failed: "+e.message }); }
});

router.post("/returns", upload.single("file"), async (req, res) => {
  try {
    const { client_id, period } = req.body;
    const workbook = XLSX.read(req.file.buffer, { type:"buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    let imported = 0;
    for (const row of rows) {
      const gstin = (row["GSTIN"]||row["gstin"]||"").toString().trim().toUpperCase();
      if (!gstin) continue;
      const client = await pool.query("SELECT id FROM clients WHERE user_id=$1 AND gstin=$2", [req.user.id, gstin]);
      if (!client.rows[0]) continue;
      const gstr1  = (row["GSTR1"] ||row["gstr1"] ||"not-filed").toString().toLowerCase();
      const gstr3b = (row["GSTR3B"]||row["gstr3b"]||"not-filed").toString().toLowerCase();
      const gstr9  = (row["GSTR9"] ||row["gstr9"] ||"not-filed").toString().toLowerCase();
      const exists = await pool.query("SELECT id FROM returns WHERE user_id=$1 AND client_id=$2 AND period=$3", [req.user.id, client.rows[0].id, period]);
      if (exists.rows[0]) {
        await pool.query("UPDATE returns SET gstr1_status=$1,gstr3b_status=$2,gstr9_status=$3,updated_at=NOW() WHERE id=$4", [gstr1, gstr3b, gstr9, exists.rows[0].id]);
      } else {
        await pool.query("INSERT INTO returns (id,user_id,client_id,period,gstr1_status,gstr3b_status,gstr9_status) VALUES($1,$2,$3,$4,$5,$6,$7)", [uuid(), req.user.id, client.rows[0].id, period, gstr1, gstr3b, gstr9]);
      }
      imported++;
    }
    res.json({ success: true, message: `${imported} return records imported` });
  } catch(e) { res.status(500).json({ success: false, message: "Import failed: "+e.message }); }
});

module.exports = router;