const express = require("express");
const auth = require("../middleware/auth");
const multer = require("multer");
const XLSX = require("xlsx");
const { v4: uuid } = require("uuid");
const db = require("../config/database");
const router = express.Router();
router.use(auth);

const upload = multer({ storage: multer.memoryStorage() });

// ── Import Clients from Excel ──────────────────────────────────────────────
router.post("/clients", upload.single("file"), (req, res) => {
  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    let imported = 0;
    let skipped = 0;

    for (const row of rows) {
      const gstin = (row["GSTIN"] || row["gstin"] || "").toString().trim().toUpperCase();
      const name  = (row["Name"] || row["name"] || row["Trade Name"] || "").toString().trim();

      if (!gstin || !name) { skipped++; continue; }

      const exists = db.prepare("SELECT id FROM clients WHERE user_id=? AND gstin=?").get(req.user.id, gstin);
      if (exists) { skipped++; continue; }

      db.prepare(`
        INSERT INTO clients (id, user_id, name, gstin, state, type, turnover, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(), req.user.id, name, gstin,
        (row["State"] || row["state"] || "").toString().trim(),
        (row["Type"] || row["type"] || "Trader").toString().trim(),
        (row["Turnover"] || row["turnover"] || "").toString().trim(),
        "compliant"
      );
      imported++;
    }

    res.json({ success:true, message:`${imported} clients imported, ${skipped} skipped.` });
  } catch(e) {
    res.status(500).json({ success:false, message:"Import failed: " + e.message });
  }
});

// ── Import GSTR Returns from Excel ────────────────────────────────────────
router.post("/returns", upload.single("file"), (req, res) => {
  try {
    const { client_id, period } = req.body;
    const workbook = XLSX.read(req.file.buffer, { type:"buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    let imported = 0;

    for (const row of rows) {
      const gstin = (row["GSTIN"] || row["gstin"] || "").toString().trim().toUpperCase();
      if (!gstin) continue;

      const client = db.prepare("SELECT id FROM clients WHERE user_id=? AND gstin=?").get(req.user.id, gstin);
      if (!client) continue;

      const gstr1  = (row["GSTR1"]  || row["gstr1"]  || "not-filed").toString().trim().toLowerCase();
      const gstr3b = (row["GSTR3B"] || row["gstr3b"] || "not-filed").toString().trim().toLowerCase();
      const gstr9  = (row["GSTR9"]  || row["gstr9"]  || "not-filed").toString().trim().toLowerCase();

      const exists = db.prepare("SELECT id FROM returns WHERE user_id=? AND client_id=? AND period=?").get(req.user.id, client.id, period);

      if (exists) {
        db.prepare(`UPDATE returns SET gstr1_status=?, gstr3b_status=?, gstr9_status=?, updated_at=datetime('now') WHERE id=?`)
          .run(gstr1, gstr3b, gstr9, exists.id);
      } else {
        db.prepare(`INSERT INTO returns (id, user_id, client_id, period, gstr1_status, gstr3b_status, gstr9_status) VALUES (?,?,?,?,?,?,?)`)
          .run(uuid(), req.user.id, client.id, period, gstr1, gstr3b, gstr9);
      }
      imported++;
    }

    res.json({ success:true, message:`${imported} return records imported.` });
  } catch(e) {
    res.status(500).json({ success:false, message:"Import failed: " + e.message });
  }
});

// ── Import Reconciliation from Excel ──────────────────────────────────────
router.post("/reconciliation", upload.single("file"), (req, res) => {
  try {
    const { client_id, period } = req.body;
    const workbook = XLSX.read(req.file.buffer, { type:"buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    let imported = 0;

    for (const row of rows) {
      const vendor_gstin = (row["Vendor GSTIN"] || row["vendor_gstin"] || "").toString().trim().toUpperCase();
      const vendor_name  = (row["Vendor Name"]  || row["vendor_name"]  || "").toString().trim();
      if (!vendor_gstin || !vendor_name) continue;

      const g2a  = parseFloat(row["GSTR2A"]       || row["gstr2a"]       || 0);
      const g2b  = parseFloat(row["GSTR2B"]       || row["gstr2b"]       || 0);
      const bks  = parseFloat(row["Books Amount"] || row["books_amount"] || 0);
      const diff = g2b - bks;

      let status = "matched";
      if (g2b === 0 && bks > 0) status = "missing";
      else if (Math.abs(diff) > 0) status = "mismatch";

      db.prepare(`
        INSERT INTO reconciliation (id, user_id, client_id, period, vendor_name, vendor_gstin, gstr2a_amount, gstr2b_amount, books_amount, difference, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(uuid(), req.user.id, client_id, period, vendor_name, vendor_gstin, g2a, g2b, bks, diff, status);
      imported++;
    }

    res.json({ success:true, message:`${imported} reconciliation entries imported.` });
  } catch(e) {
    res.status(500).json({ success:false, message:"Import failed: " + e.message });
  }
});

module.exports = router;