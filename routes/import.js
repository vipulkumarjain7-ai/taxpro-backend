const multer = require("multer");
const XLSX = require("xlsx");
const importRouter = express.Router();
importRouter.use(auth);
const upload = multer({ storage: multer.memoryStorage() });
 
importRouter.post("/clients", upload.single("file"), async (req, res) => {
  try {
    const workbook = XLSX.read(req.file.buffer, { type:"buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    let imported = 0, skipped = 0;
    for (const row of rows) {
      const gstin = (row["GSTIN"]||row["gstin"]||"").toString().trim().toUpperCase();
      const name  = (row["Name"] ||row["name"] ||row["Trade Name"]||"").toString().trim();
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