require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

// Initialize database (this also runs initDB() from config/database.js)
require("./config/database");

const app = express();

/* -------------------------------------------------------
   BASIC CONFIGURATION
------------------------------------------------------- */

// CORS
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

// Body Parsers
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Static files (logos, uploads, generated PDFs, etc.)
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* -------------------------------------------------------
   EXISTING ROUTES
------------------------------------------------------- */

const authRoutes = require("./routes/auth");
const clientsRoutes = require("./routes/clients");
const dashboardRoutes = require("./routes/dashboard");
const gstinRoutes = require("./routes/gstin");
const gstr2ARoutes = require("./routes/gstr2A");
const returnsRoutes = require("./routes/returns");
const reconciliationRoutes = require("./routes/reconciliation");
const challansRoutes = require("./routes/challans");
const reportsRoutes = require("./routes/reports");
const noticesRoutes = require("./routes/notices");
const staffRoutes = require("./routes/staff");
const whatsappRoutes = require("./routes/whatsapp");
const aiRoutes = require("./routes/ai");

/* -------------------------------------------------------
   NEW ERP ROUTES
------------------------------------------------------- */

const productsRoutes = require("./routes/products");
const invoicesRoutes = require("./routes/invoices");
const paymentsRoutes = require("./routes/payments");
const inventoryRoutes = require("./routes/inventory");
const accountingRoutes = require("./routes/accounting");

/* -------------------------------------------------------
   HEALTH CHECK
------------------------------------------------------- */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "TaxPro ERP API is running successfully",
    version: "2.0.0",
    modules: [
      "Authentication",
      "Clients",
      "GSTIN Verification",
      "GSTR-2A",
      "Returns",
      "Reconciliation",
      "Challans",
      "Reports",
      "Notices",
      "Staff Management",
      "WhatsApp",
      "AI Assistant",
      "Products & Inventory",
      "Invoice & Billing",
      "Payments",
      "Accounting",
    ],
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "OK",
    serverTime: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

/* -------------------------------------------------------
   REGISTER API ROUTES
------------------------------------------------------- */

// Existing modules
app.use("/api/auth", authRoutes);
app.use("/api/clients", clientsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/gstin", gstinRoutes);
app.use("/api/gstr2a", gstr2ARoutes);
app.use("/api/returns", returnsRoutes);
app.use("/api/reconciliation", reconciliationRoutes);
app.use("/api/challans", challansRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/notices", noticesRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/ai", aiRoutes);

// New ERP modules
app.use("/api/products", productsRoutes);
app.use("/api/invoices", invoicesRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/accounting", accountingRoutes);
app.use("/api/suppliers", suppliersRoutes);

/* -------------------------------------------------------
   404 HANDLER
------------------------------------------------------- */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found",
    path: req.originalUrl,
  });
});

/* -------------------------------------------------------
   GLOBAL ERROR HANDLER
------------------------------------------------------- */

app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err);

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
    ...(process.env.NODE_ENV !== "production" && {
      stack: err.stack,
    }),
  });
});

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("🚀 TaxPro ERP Server Started");
  console.log(`🌐 Server URL: http://localhost:${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log("✅ Modules Loaded Successfully");
});