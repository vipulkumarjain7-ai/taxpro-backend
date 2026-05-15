const express = require("express");
const router = express.Router();
const pool = require("../config/database");

// GET /api/dashboard
router.get("/", async (req, res) => {
  try {
    const clients = await pool.query("SELECT COUNT(*) FROM clients");
    const products = await pool.query("SELECT COUNT(*) FROM products");
    const invoices = await pool.query("SELECT COUNT(*) FROM invoices");
    const payments = await pool.query("SELECT COUNT(*) FROM payments");

    res.json({
      success: true,
      summary: {
        totalClients: Number(clients.rows[0].count),
        totalProducts: Number(products.rows[0].count),
        totalInvoices: Number(invoices.rows[0].count),
        totalPayments: Number(payments.rows[0].count),
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Dashboard Error:", error);
    res.status(500).json({
      success: false,
      message: "Dashboard API failed",
      error: error.message,
    });
  }
});

module.exports = router;