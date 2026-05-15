const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../config/database');

const router = express.Router(); 

router.get('/', async (req, res) => {
  try {
    const { user_id } = req.query;
    const result = await db.query(
      'SELECT * FROM products WHERE ($1::text IS NULL OR user_id = $1) ORDER BY created_at DESC',
      [user_id || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}); 
router.get('/low-stock', async (req, res) => {
  try {
    const { user_id } = req.query;
    const result = await db.query(
      'SELECT * FROM products WHERE user_id = $1 AND stock_qty <= min_stock ORDER BY name',
      [user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}); 

router.post('/', async (req, res) => {
  try {
    const {
      user_id, name, code, hsn_sac, unit = 'PCS', category,
      gst_rate = 18, purchase_price = 0, sale_price = 0,
      stock_qty = 0, min_stock = 0, description, is_service = false
    } = req.body;

    const id = randomUUID();
    const result = await db.query(
      `INSERT INTO products (
        id, user_id, name, code, hsn_sac, unit, category,
        gst_rate, purchase_price, sale_price, stock_qty,
        min_stock, description, is_service
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,$11,
        $12,$13,$14
      ) RETURNING *`, 
      [
        id, user_id, name, code, hsn_sac, unit, category,
        gst_rate, purchase_price, sale_price, stock_qty,
        min_stock, description, is_service
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}); 

module.exports = router;