// routes/purchases.js
const express = require("express");
const { randomUUID } = require("crypto");
const db = require("../config/database");

const router = express.Router();

/* =====================================================
   GET ALL PURCHASES
   GET /api/purchases?user_id=...
===================================================== */
router.get("/", async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "user_id is required",
      });
    }

    const result = await db.query(
      `
      SELECT *
      FROM invoices
      WHERE user_id = $1
        AND invoice_type = 'PURCHASE'
      ORDER BY invoice_date DESC, created_at DESC
      `,
      [user_id]
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error("Purchases GET Error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/* =====================================================
   GET SINGLE PURCHASE WITH ITEMS
   GET /api/purchases/:id
===================================================== */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const purchaseResult = await db.query(
      `
      SELECT *
      FROM invoices
      WHERE id = $1
        AND invoice_type = 'PURCHASE'
      `,
      [id]
    );

    if (purchaseResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Purchase not found",
      });
    }

    const itemsResult = await db.query(
      `
      SELECT *
      FROM invoice_items
      WHERE invoice_id = $1
      ORDER BY name
      `,
      [id]
    );

    res.json({
      success: true,
      data: {
        ...purchaseResult.rows[0],
        items: itemsResult.rows,
      },
    });
  } catch (err) {
    console.error("Purchase GET Error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/* =====================================================
   CREATE PURCHASE
   POST /api/purchases
===================================================== */
router.post("/", async (req, res) => {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const purchase = req.body;
    const purchaseId = randomUUID();

    // Insert purchase invoice
    await client.query(
      `
      INSERT INTO invoices (
        id,
        user_id,
        invoice_no,
        invoice_type,
        party_id,
        party_name,
        party_gstin,
        party_address,
        party_state,
        invoice_date,
        due_date,
        place_of_supply,
        is_igst,
        subtotal,
        discount,
        taxable_amount,
        igst_amount,
        cgst_amount,
        sgst_amount,
        cess_amount,
        total_tax,
        total_amount,
        paid_amount,
        balance_due,
        status,
        notes,
        terms
      )
      VALUES (
        $1,$2,$3,'PURCHASE',$4,$5,$6,$7,$8,
        $9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22,$23,$24,$25,$26
      )
      `,
      [
        purchaseId,
        purchase.user_id,
        purchase.invoice_no,
        purchase.party_id || null,
        purchase.party_name,
        purchase.party_gstin || null,
        purchase.party_address || null,
        purchase.party_state || null,
        purchase.invoice_date,
        purchase.due_date || null,
        purchase.place_of_supply || null,
        purchase.is_igst || false,
        purchase.subtotal || 0,
        purchase.discount || 0,
        purchase.taxable_amount || 0,
        purchase.igst_amount || 0,
        purchase.cgst_amount || 0,
        purchase.sgst_amount || 0,
        purchase.cess_amount || 0,
        purchase.total_tax || 0,
        purchase.total_amount || 0,
        purchase.paid_amount || 0,
        purchase.balance_due ??
          (purchase.total_amount || 0) - (purchase.paid_amount || 0),
        purchase.status ||
          ((purchase.total_amount || 0) - (purchase.paid_amount || 0) <= 0
            ? "paid"
            : "unpaid"),
        purchase.notes || null,
        purchase.terms || null,
      ]
    );

    // Insert items and increase stock
    for (const item of purchase.items || []) {
      await client.query(
        `
        INSERT INTO invoice_items (
          id,
          invoice_id,
          product_id,
          name,
          hsn_sac,
          unit,
          qty,
          rate,
          discount_pct,
          taxable_value,
          gst_rate,
          igst_amount,
          cgst_amount,
          sgst_amount,
          total_amount
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15
        )
        `,
        [
          randomUUID(),
          purchaseId,
          item.product_id || null,
          item.name,
          item.hsn_sac || null,
          item.unit || "PCS",
          item.qty || 1,
          item.rate || 0,
          item.discount_pct || 0,
          item.taxable_value || 0,
          item.gst_rate || 18,
          item.igst_amount || 0,
          item.cgst_amount || 0,
          item.sgst_amount || 0,
          item.total_amount || 0,
        ]
      );

      // Increase stock for products
      if (item.product_id) {
        await client.query(
          `
          UPDATE products
          SET stock_qty = stock_qty + $1,
              updated_at = NOW()
          WHERE id = $2
          `,
          [item.qty || 0, item.product_id]
        );

        // Stock movement
        await client.query(
          `
          INSERT INTO stock_movements (
            id,
            user_id,
            product_id,
            type,
            qty,
            rate,
            reference,
            invoice_id
          )
          VALUES (
            $1,$2,$3,'PURCHASE',$4,$5,$6,$7
          )
          `,
          [
            randomUUID(),
            purchase.user_id,
            item.product_id,
            item.qty || 0,
            item.rate || 0,
            purchase.invoice_no,
            purchaseId,
          ]
        );
      }
    }

    // Accounting entries
    const entryDate = purchase.invoice_date;
    const taxable = purchase.taxable_amount || 0;
    const tax = purchase.total_tax || 0;
    const total = purchase.total_amount || 0;

    // Purchases / Inventory Dr
    if (taxable > 0) {
      await client.query(
        `
        INSERT INTO journal_entries (
          id, user_id, entry_date, voucher_type,
          voucher_no, account_name, debit,
          reference_id, remarks
        )
        VALUES (
          $1,$2,$3,'Purchase',$4,
          'Purchases',$5,$6,$7
        )
        `,
        [
          randomUUID(),
          purchase.user_id,
          entryDate,
          purchase.invoice_no,
          taxable,
          purchaseId,
          `Purchase from ${purchase.party_name}`,
        ]
      );
    }

    // Input GST Credit Dr
    if (tax > 0) {
      await client.query(
        `
        INSERT INTO journal_entries (
          id, user_id, entry_date, voucher_type,
          voucher_no, account_name, debit,
          reference_id, remarks
        )
        VALUES (
          $1,$2,$3,'Purchase',$4,
          'Input GST Credit',$5,$6,$7
        )
        `,
        [
          randomUUID(),
          purchase.user_id,
          entryDate,
          purchase.invoice_no,
          tax,
          purchaseId,
          `GST input on purchase`,
        ]
      );
    }

    // Accounts Payable Cr
    if (total > 0) {
      await client.query(
        `
        INSERT INTO journal_entries (
          id, user_id, entry_date, voucher_type,
          voucher_no, account_name, credit,
          reference_id, remarks
        )
        VALUES (
          $1,$2,$3,'Purchase',$4,
          'Accounts Payable',$5,$6,$7
        )
        `,
        [
          randomUUID(),
          purchase.user_id,
          entryDate,
          purchase.invoice_no,
          total,
          purchaseId,
          `Payable to ${purchase.party_name}`,
        ]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Purchase created successfully",
      id: purchaseId,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Purchase CREATE Error:", err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;