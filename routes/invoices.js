const { generateInvoicePDF } = require("../utils/pdfGenerator");
const express = require('express');
const router = express.Router();
const db = require("../config/database");

router.post('/', async (req, res) => {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const {
      company_id,
      customer_id,
      invoice_number,
      invoice_date,
      subtotal,
      gst_amount,
      total_amount,
      items
    } = req.body;

    const invoiceResult = await client.query(
      `INSERT INTO invoices
      (company_id, customer_id, invoice_number, invoice_date,
       subtotal, gst_amount, total_amount, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'POSTED') RETURNING *`,
      [
        company_id,
        customer_id,
        invoice_number,
        invoice_date,
        subtotal,
        gst_amount,
        total_amount
      ]
    );

    const invoice = invoiceResult.rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO invoice_items
        (invoice_id, item_id, quantity, rate,
         taxable_value, gst_rate, gst_amount, total)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          invoice.id,
          item.item_id,
          item.quantity,
          item.rate,
          item.taxable_value,
          item.gst_rate,
          item.gst_amount,
          item.total
        ]
      );

      await client.query(
        `INSERT INTO stock_transactions
        (company_id, item_id, txn_type, quantity_out, reference_no)
        VALUES ($1,$2,'SALE',$3,$4)`,
        [company_id, item.item_id, item.quantity, invoice_number]
      );
    }

    // Accounting entries
    await client.query(
      `INSERT INTO journal_entries
      (company_id, account_name, debit, reference_no)
      VALUES ($1,'Accounts Receivable',$2,$3)`,
      [company_id, total_amount, invoice_number]
    );

    await client.query(
      `INSERT INTO journal_entries
      (company_id, account_name, credit, reference_no)
      VALUES ($1,'Sales',$2,$3)`,
      [company_id, subtotal, invoice_number]
    );

    if (gst_amount > 0) {
      await client.query(
        `INSERT INTO journal_entries
        (company_id, account_name, credit, reference_no)
        VALUES ($1,'GST Payable',$2,$3)`,
        [company_id, gst_amount, invoice_number]
      );
    }

    await client.query('COMMIT');
    res.json(invoice);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});
router.get("/:id/pdf", async (req, res) => {
  try {
    const { id } = req.params;

    const invoiceResult = await db.query(
      "SELECT * FROM invoices WHERE id = $1",
      [id]
    );

    if (invoiceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    const itemsResult = await db.query(
      "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY name",
      [id]
    );

    const invoice = invoiceResult.rows[0];
    const items = itemsResult.rows;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=${invoice.invoice_no}.pdf`
    );

    const doc = generateInvoicePDF(invoice, items);
    doc.pipe(res);
    doc.end();
  } catch (err) {
    console.error("PDF Error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

module.exports = router;