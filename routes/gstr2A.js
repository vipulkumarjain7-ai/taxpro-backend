const express = require("express");
const multer  = require("multer");
const XLSX    = require("xlsx");
const { v4: uuid } = require("uuid");
const pool    = require("../config/database");
const auth    = require("../middleware/auth");

const router = express.Router();
router.use(auth);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Helper: Parse GSTR-2A Excel from GST Portal ───────────────────────────
const parseGSTR2A = (workbook) => {
  const invoices = [];

  // GST Portal GSTR-2A has multiple sheets
  // Main sheet is usually "B2B" for regular invoices
  const sheetNames = workbook.SheetNames;

  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    if (rows.length === 0) continue;

    for (const row of rows) {
      // Try different column name formats (GST portal changes column names)
      const gstin = (
        row["GSTIN of Supplier"] ||
        row["GSTIN"] ||
        row["Supplier GSTIN"] ||
        row["gstin_of_supplier"] ||
        row["ctin"] || ""
      ).toString().trim().toUpperCase();

      const supplierName = (
        row["Trade/Legal name of the Supplier"] ||
        row["Trade Name"] ||
        row["Supplier Name"] ||
        row["Legal Name"] ||
        row["trdnm"] || ""
      ).toString().trim();

      const invoiceNo = (
        row["Invoice Number"] ||
        row["Invoice No"] ||
        row["inum"] || ""
      ).toString().trim();

      const invoiceDate = (
        row["Invoice Date"] ||
        row["idt"] || ""
      ).toString().trim();

      const invoiceValue = parseFloat(
        row["Invoice Value"] ||
        row["val"] || 0
      ) || 0;

      const taxableValue = parseFloat(
        row["Taxable Value"] ||
        row["txval"] || 0
      ) || 0;

      const igst = parseFloat(
        row["Integrated Tax Amount"] ||
        row["IGST Amount"] ||
        row["iamt"] || 0
      ) || 0;

      const cgst = parseFloat(
        row["Central Tax Amount"] ||
        row["CGST Amount"] ||
        row["camt"] || 0
      ) || 0;

      const sgst = parseFloat(
        row["State/UT Tax Amount"] ||
        row["SGST Amount"] ||
        row["samt"] || 0
      ) || 0;

      const cess = parseFloat(
        row["Cess Amount"] ||
        row["csamt"] || 0
      ) || 0;

      const totalITC = igst + cgst + sgst + cess;
      const rate = parseFloat(row["Rate"] || row["rt"] || 0) || 0;

      // Skip rows without GSTIN
      if (!gstin || gstin.length < 15) continue;

      invoices.push({
        gstin,
        supplier_name: supplierName,
        invoice_no: invoiceNo,
        invoice_date: invoiceDate,
        invoice_value: invoiceValue,
        taxable_value: taxableValue,
        igst, cgst, sgst, cess,
        total_itc: totalITC,
        rate,
        sheet: sheetName,
      });
    }
  }

  return invoices;
};

// ── Helper: Parse GSTR-2A JSON from GST Portal ────────────────────────────
const parseGSTR2AJson = (jsonData) => {
  const invoices = [];

  try {
    const data = typeof jsonData === "string" ? JSON.parse(jsonData) : jsonData;

    // B2B invoices
    const b2b = data.b2b || data.B2B || [];
    for (const supplier of b2b) {
      const gstin = (supplier.ctin || supplier.CTIN || "").toUpperCase();
      const supplierName = supplier.trdnm || supplier.TRDNM || "";

      const invs = supplier.inv || supplier.INV || [];
      for (const inv of invs) {
        const items = inv.itms || inv.ITMS || [];
        for (const item of items) {
          const detail = item.itm_det || item.ITM_DET || {};
          invoices.push({
            gstin,
            supplier_name: supplierName,
            invoice_no: inv.inum || "",
            invoice_date: inv.idt || "",
            invoice_value: parseFloat(inv.val || 0),
            taxable_value: parseFloat(detail.txval || 0),
            igst:  parseFloat(detail.iamt || 0),
            cgst:  parseFloat(detail.camt || 0),
            sgst:  parseFloat(detail.samt || 0),
            cess:  parseFloat(detail.csamt || 0),
            total_itc: parseFloat(detail.iamt||0) + parseFloat(detail.camt||0) + parseFloat(detail.samt||0) + parseFloat(detail.csamt||0),
            rate: parseFloat(detail.rt || 0),
            sheet: "B2B",
          });
        }
      }
    }
  } catch(e) {
    console.error("JSON parse error:", e.message);
  }

  return invoices;
};

// ── Helper: Group invoices by supplier GSTIN ──────────────────────────────
const groupBySupplier = (invoices) => {
  const grouped = {};

  for (const inv of invoices) {
    if (!grouped[inv.gstin]) {
      grouped[inv.gstin] = {
        gstin: inv.gstin,
        supplier_name: inv.supplier_name,
        invoice_count: 0,
        total_taxable: 0,
        total_igst: 0,
        total_cgst: 0,
        total_sgst: 0,
        total_cess: 0,
        total_itc: 0,
        invoices: [],
      };
    }

    grouped[inv.gstin].invoice_count++;
    grouped[inv.gstin].total_taxable += inv.taxable_value;
    grouped[inv.gstin].total_igst    += inv.igst;
    grouped[inv.gstin].total_cgst    += inv.cgst;
    grouped[inv.gstin].total_sgst    += inv.sgst;
    grouped[inv.gstin].total_cess    += inv.cess;
    grouped[inv.gstin].total_itc     += inv.total_itc;
    grouped[inv.gstin].invoices.push(inv);
  }

  return Object.values(grouped);
};

// ── POST /api/gstr2a/import ───────────────────────────────────────────────
router.post("/import", upload.single("file"), async (req, res) => {
  try {
    const { client_id, period, books_data } = req.body;

    if (!client_id) return res.status(400).json({ success: false, message: "client_id is required" });
    if (!period)    return res.status(400).json({ success: false, message: "period is required" });
    if (!req.file)  return res.status(400).json({ success: false, message: "File is required" });

    // Verify client belongs to user
    const clientQ = process.env.DATABASE_URL
      ? await pool.query("SELECT * FROM clients WHERE id=$1 AND user_id=$2", [client_id, req.user.id])
      : null;

    const db = require("../config/database");

    let invoices = [];

    // Parse file based on type
    if (req.file.originalname.endsWith(".json")) {
      const jsonData = JSON.parse(req.file.buffer.toString());
      invoices = parseGSTR2AJson(jsonData);
    } else {
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      invoices = parseGSTR2A(workbook);
    }

    if (invoices.length === 0) {
      return res.status(400).json({ success: false, message: "No valid invoice data found in file. Please check the file format." });
    }

    // Group by supplier
    const suppliers = groupBySupplier(invoices);

    // Parse books data if provided
    let booksMap = {};
    if (books_data) {
      try {
        const booksArr = JSON.parse(books_data);
        for (const b of booksArr) {
          booksMap[b.gstin?.toUpperCase()] = parseFloat(b.amount || 0);
        }
      } catch(e) {}
    }

    // Save to reconciliation table
    let saved = 0;
    let skipped = 0;

    for (const supplier of suppliers) {
      const booksAmount = booksMap[supplier.gstin] || 0;
      const diff = supplier.total_itc - booksAmount;

      let status = "matched";
      if (supplier.total_itc === 0 && booksAmount > 0) status = "missing";
      else if (Math.abs(diff) > 0.01) status = "mismatch";

      try {
        if (process.env.DATABASE_URL) {
          // PostgreSQL
          await pool.query(`
            INSERT INTO reconciliation
            (id, user_id, client_id, period, vendor_name, vendor_gstin, invoice_count,
             gstr2a_amount, gstr2b_amount, books_amount, difference, status, remarks)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            ON CONFLICT DO NOTHING
          `, [
            uuid(), req.user.id, client_id, period,
            supplier.supplier_name, supplier.gstin,
            supplier.invoice_count,
            supplier.total_itc,  // gstr2a
            supplier.total_itc,  // gstr2b (same for 2A import)
            booksAmount,
            diff, status,
            `Imported from GSTR-2A. Invoices: ${supplier.invoice_count}`
          ]);
        } else {
          // SQLite
          db.prepare(`
            INSERT OR IGNORE INTO reconciliation
            (id, user_id, client_id, period, vendor_name, vendor_gstin, invoice_count,
             gstr2a_amount, gstr2b_amount, books_amount, difference, status, remarks)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            uuid(), req.user.id, client_id, period,
            supplier.supplier_name, supplier.gstin,
            supplier.invoice_count,
            supplier.total_itc,
            supplier.total_itc,
            booksAmount,
            diff, status,
            `Imported from GSTR-2A. Invoices: ${supplier.invoice_count}`
          );
        }
        saved++;
      } catch(e) {
        skipped++;
      }
    }

    res.json({
      success: true,
      message: `GSTR-2A imported successfully! ${saved} suppliers saved, ${skipped} skipped.`,
      summary: {
        total_invoices: invoices.length,
        total_suppliers: suppliers.length,
        saved, skipped,
        total_itc: suppliers.reduce((a,s) => a + s.total_itc, 0),
        suppliers: suppliers.map(s => ({
          gstin: s.gstin,
          name:  s.supplier_name,
          invoices: s.invoice_count,
          itc: s.total_itc,
        }))
      }
    });

  } catch(e) {
    console.error("GSTR-2A import error:", e);
    res.status(500).json({ success: false, message: "Import failed: " + e.message });
  }
});

// ── POST /api/gstr2a/preview ─ Preview without saving ────────────────────
router.post("/preview", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "File is required" });

    let invoices = [];

    if (req.file.originalname.endsWith(".json")) {
      const jsonData = JSON.parse(req.file.buffer.toString());
      invoices = parseGSTR2AJson(jsonData);
    } else {
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      invoices = parseGSTR2A(workbook);
    }

    if (invoices.length === 0) {
      return res.status(400).json({ success: false, message: "No valid data found. Check file format." });
    }

    const suppliers = groupBySupplier(invoices);
    const totalITC  = suppliers.reduce((a,s) => a + s.total_itc, 0);
    const totalInv  = invoices.length;

    res.json({
      success: true,
      preview: {
        total_invoices: totalInv,
        total_suppliers: suppliers.length,
        total_itc: totalITC,
        suppliers: suppliers.slice(0, 50).map(s => ({
          gstin:    s.gstin,
          name:     s.supplier_name,
          invoices: s.invoice_count,
          taxable:  s.total_taxable,
          igst:     s.total_igst,
          cgst:     s.total_cgst,
          sgst:     s.total_sgst,
          itc:      s.total_itc,
        }))
      }
    });

  } catch(e) {
    res.status(500).json({ success: false, message: "Preview failed: " + e.message });
  }
});

// ── GET /api/gstr2a/template ─ Download sample Excel template ─────────────
router.get("/template", (req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    const data = [
      ["GSTIN of Supplier", "Trade/Legal name of the Supplier", "Invoice Number", "Invoice Date", "Invoice Value", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"],
      ["07AABCA1234B1Z5", "ABC Suppliers Pvt Ltd", "INV001", "01-04-2024", "118000", "100000", "0", "9000", "9000", "0"],
      ["27AABCM7890F1Z7", "Mehta & Company", "INV002", "05-04-2024", "59000", "50000", "9000", "0", "0", "0"],
      ["09AABCS3456E1Z9", "Singh Enterprises", "INV003", "10-04-2024", "35400", "30000", "0", "2700", "2700", "0"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = data[0].map(() => ({ wch: 25 }));
    XLSX.utils.book_append_sheet(wb, ws, "B2B");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Disposition", "attachment; filename=GSTR2A_Template.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buffer);
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;