    require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

// ── Init DB first ──────────────────────────────────────────────────────────
require("./config/database");

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Security & Middleware ──────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: "https://taxpro-frontend-six.vercel.app",
 methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
}));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
// Rate limiter — 100 requests per 15 minutes per IP
app.use("/api/", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: "Too many requests. Please try again later." },
}));

// Stricter limiter for auth endpoints
app.use("/api/auth/login", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Too many login attempts. Try again after 15 minutes." },
}));

// ── Routes ─────────────────────────────────────────────────────────────────
app.set("trust proxy", 1);
app.use("/api/auth", require("./routes/auth"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/clients", require("./routes/clients"));
app.use("/api/notices", require("./routes/notices"));
app.use("/api/returns", require("./routes/returns"));
app.use("/api/reconciliation", require("./routes/reconciliation"));
app.use("/api/ai", require("./routes/ai"));
app.use("/api/import", require("./routes/import"));
// ── Health check ───────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ success: true, message: "TaxPro GST API is running.", timestamp: new Date().toISOString() });
});

// ── 404 Handler ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.url} not found.` });
});

// ── Global Error Handler ───────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === "production" ? "Internal server error." : err.message,
  });
});

// ── Start Server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 TaxPro GST Backend running on http://localhost:${PORT}`);
  console.log(`📋 Environment : ${process.env.NODE_ENV || "development"}`);
  console.log(`🗄️  Database   : ${process.env.DB_PATH || "./taxpro.db"}`);
  console.log(`\n📌 Endpoints:`);
  console.log(`   POST   /api/auth/register`);
  console.log(`   POST   /api/auth/login`);
  console.log(`   GET    /api/dashboard`);
  console.log(`   CRUD   /api/clients`);
  console.log(`   CRUD   /api/notices`);
  console.log(`   CRUD   /api/returns`);
  console.log(`   CRUD   /api/reconciliation\n`);
});

module.exports = app;

    

