require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const morgan  = require("morgan");
const rateLimit = require("express-rate-limit");

require("./config/database");

const app  = express();
const PORT = process.env.PORT || 5000;

app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: "*", methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/api/", rateLimit({ windowMs: 15*60*1000, max: 500 }));

// ── Import Routes ──────────────────────────────────────────────────────────
const { partiesRouter, paymentsRouter, reportsRouter } = require("./routes/parties-payments-reports");

app.use("/api/auth",           require("./routes/auth"));
app.use("/api/dashboard",      require("./routes/dashboard"));
app.use("/api/clients",        require("./routes/clients"));
app.use("/api/notices",        require("./routes/notices"));
app.use("/api/returns",        require("./routes/returns"));
app.use("/api/reconciliation", require("./routes/reconciliation"));
app.use("/api/challans",       require("./routes/challans"));
app.use("/api/ai",             require("./routes/ai"));
app.use("/api/import",         require("./routes/import"));
app.use("/api/staff",          require("./routes/staff"));
app.use("/api/gstin",          require("./routes/gstin"));
app.use("/api/gstr2A",         require("./routes/gstr2A"));

// ── Accounting Routes ──────────────────────────────────────────────────────
app.use("/api/products",       require("./routes/products"));
app.use("/api/invoices",       require("./routes/invoices"));
app.use("/api/parties",        partiesRouter);
app.use("/api/payments",       paymentsRouter);
app.use("/api/reports",        reportsRouter);
app.use("/api/bank",         require("./routes/bank"));

app.get("/health", (req, res) => {
  res.json({ success: true, message: "TaxPro Complete API running", version: "3.0.0" });
});

app.use((req, res) => res.status(404).json({ success: false, message: `Route ${req.method} ${req.url} not found` }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: process.env.NODE_ENV === "production" ? "Server error" : err.message });
});

app.listen(PORT, () => {
  console.log(`\n🚀 TaxPro Complete v3.0 running on port ${PORT}`);
  console.log(`\n📌 Accounting:`);
  console.log(`   /api/products  /api/invoices  /api/parties  /api/payments  /api/reports`);
  console.log(`\n📌 GST:`);
  console.log(`   /api/clients  /api/notices  /api/returns  /api/reconciliation  /api/gstr2a`);
  console.log(`\n📌 Other:`);
  console.log(`   /api/auth  /api/ai  /api/gstin  /api/staff  /api/challans\n`);
});

module.exports = app;