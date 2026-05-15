const express = require('express');
const db = require('../config/database');
const router = express.Router(); 

router.get('/trial-balance', async (req, res) => {
  try {
    const { user_id } = req.query;

    const result = await db.query(
      `SELECT
         account_name,
         SUM(debit) AS debit,
         SUM(credit) AS credit
       FROM journal_entries
       WHERE user_id = $1
       GROUP BY account_name
       ORDER BY account_name`, 
      [user_id]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message }); 
  }
}); 

module.exports = router;