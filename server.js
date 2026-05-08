require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const dashboardRouter = require("./routes/dashboard");

require("./config/database");

const app = express();
const PORT = process.env.PORT || 5000;

app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: "*", methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api/", rateLimit({ windowMs: 15*60*1000, max: 200 }));

// ── Routes ─────────────────────────────────────────────────────────────────
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
app.use("/api/reports",        require("./routes/reports"));
app.use("/api/whatsapp",       require("./routes/whatsapp"));

app.get("/health", (req, res) => {
  res.json({ success: true, message: "TaxPro GST API running", version: "2.0.0" });
});

app.use((req, res) => res.status(404).json({ success: false, message: `Route ${req.method} ${req.url} not found` }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: process.env.NODE_ENV === "production" ? "Server error" : err.message });
});

app.listen(PORT, () => {
  console.log(`\n🚀 TaxPro GST Backend v2.0 running on port ${PORT}`);
  console.log(`📋 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`\n📌 All Endpoints:`);
  console.log(`   AUTH:           /api/auth`);
  console.log(`   DASHBOARD:      /api/dashboard`);
  console.log(`   CLIENTS:        /api/clients`);
  console.log(`   NOTICES:        /api/notices`);
  console.log(`   RETURNS:        /api/returns`);
  console.log(`   RECONCILIATION: /api/reconciliation`);
  console.log(`   CHALLANS:       /api/challans`);
  console.log(`   AI:             /api/ai`);
  console.log(`   IMPORT:         /api/import`);
  console.log(`   STAFF:          /api/staff`);
  console.log(`   REPORTS:        /api/reports`);
  console.log(`   WHATSAPP:       /api/whatsapp\n`);
});

module.exports = app;