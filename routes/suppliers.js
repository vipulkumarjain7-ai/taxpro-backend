// routes/suppliers.js
const express = require("express");
const { randomUUID } = require("crypto");
const db = require("../config/database");

const router = express.Router();

/* =====================================================
   GET ALL SUPPLIERS
   GET /api/suppliers?user_id=...
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
      FROM clients
      WHERE user_id = $1
        AND type = 'Supplier'
      ORDER BY name
      `,
      [user_id]
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error("Suppliers GET Error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/* =====================================================
   GET SINGLE SUPPLIER
   GET /api/suppliers/:id
===================================================== */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `
      SELECT *
      FROM clients
      WHERE id = $1
        AND type = 'Supplier'
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Supplier not found",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (err) {
    console.error("Supplier GET Error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/* =====================================================
   CREATE SUPPLIER
   POST /api/suppliers
===================================================== */
router.post("/", async (req, res) => {
  try {
    const {
      user_id,
      name,
      gstin,
      state,
      turnover,
      status = "compliant",
      notes,
      phone,
      email,
      address,
      city,
      pincode,
      pan,
      credit_limit = 0,
    } = req.body;

    if (!user_id || !name) {
      return res.status(400).json({
        success: false,
        message: "user_id and name are required",
      });
    }

    const id = randomUUID();

    const result = await db.query(
      `
      INSERT INTO clients (
        id,
        user_id,
        name,
        gstin,
        state,
        type,
        turnover,
        status,
        notes,
        phone,
        email,
        address,
        city,
        pincode,
        pan,
        credit_limit
      )
      VALUES (
        $1,$2,$3,$4,$5,'Supplier',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
      )
      RETURNING *
      `,
      [
        id,
        user_id,
        name,
        gstin,
        state,
        turnover,
        status,
        notes,
        phone,
        email,
        address,
        city,
        pincode,
        pan,
        credit_limit,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Supplier created successfully",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("Supplier CREATE Error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/* =====================================================
   UPDATE SUPPLIER
   PUT /api/suppliers/:id
===================================================== */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      gstin,
      state,
      turnover,
      status,
      notes,
      phone,
      email,
      address,
      city,
      pincode,
      pan,
      credit_limit,
    } = req.body;

    const result = await db.query(
      `
      UPDATE clients
      SET
        name = COALESCE($1, name),
        gstin = COALESCE($2, gstin),
        state = COALESCE($3, state),
        turnover = COALESCE($4, turnover),
        status = COALESCE($5, status),
        notes = COALESCE($6, notes),
        phone = COALESCE($7, phone),
        email = COALESCE($8, email),
        address = COALESCE($9, address),
        city = COALESCE($10, city),
        pincode = COALESCE($11, pincode),
        pan = COALESCE($12, pan),
        credit_limit = COALESCE($13, credit_limit),
        updated_at = NOW()
      WHERE id = $14
        AND type = 'Supplier'
      RETURNING *
      `,
      [
        name,
        gstin,
        state,
        turnover,
        status,
        notes,
        phone,
        email,
        address,
        city,
        pincode,
        pan,
        credit_limit,
        id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Supplier not found",
      });
    }

    res.json({
      success: true,
      message: "Supplier updated successfully",
      data: result.rows[0],
    });
  } catch (err) {
    console.error("Supplier UPDATE Error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/* =====================================================
   DELETE SUPPLIER
   DELETE /api/suppliers/:id
===================================================== */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `
      DELETE FROM clients
      WHERE id = $1
        AND type = 'Supplier'
      RETURNING id
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Supplier not found",
      });
    }

    res.json({
      success: true,
      message: "Supplier deleted successfully",
    });
  } catch (err) {
    console.error("Supplier DELETE Error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

module.exports = router;