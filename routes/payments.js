const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../config/database');

const router = express.Router(); 

router.post('/', async (req, res) => {
  const client = await db.connect(); 

  try {
    await client.query('BEGIN');

    const {
      user_id, invoice_id, party_id, party_name,
      amount, method = 'CASH', reference_no,
      payment_date, notes
    } = req.body;

    const id = randomUUID(); 

    await client.query(
      `INSERT INTO payments (
        id, user_id, invoice_id, party_id, party_name,
        amount, method, reference_no, payment_date, notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, 
      [
         id, user_id, invoice_id, party_id, party_name,
        amount, method, reference_no, payment_date, notes
      ]
    );

    if (invoice_id) {
      await client.query(
        `UPDATE invoices
         SET paid_amount = paid_amount + $1,
             balance_due = GREATEST(balance_due - $1, 0),
             status = CASE
               WHEN GREATEST(balance_due - $1, 0) = 0 THEN 'paid'
               ELSE 'partial'
             END,
             updated_at = NOW()
         WHERE id = $2`, 
        [amount, invoice_id]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, id }); 
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message }); 
  } finally {
        client.release(); 
  }
}); 

module.exports = router;