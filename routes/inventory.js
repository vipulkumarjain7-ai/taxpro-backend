const express = require('express');
const db = require('../config/database');
const router = express.Router(); 

router.get('/summary', async (req, res) => {
  try {
    const { user_id } = req.query;

    const result = await db.query(
      `SELECT
         id,
         name,
         code,
         unit,
         stock_qty,
         min_stock,
         sale_price,
         (stock_qty * sale_price) AS stock_value
       FROM products
       WHERE user_id = $1
       ORDER BY name`, 
      [user_id]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message }); 
  }
}); 
module.exports = router;