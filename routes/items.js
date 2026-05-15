constexpress=require('express');
constrouter=express.Router();
const db = require("../config/database");
router.get('/',async(req,res)=>{constresult=awaitdb.query('SELECT * FROM items ORDER BY id DESC');res.json(result.rows);
});
router.post('/',async(req,res)=>{const{company_id,item_name,hsn_code,unit,rate,gst_rate,opening_stock}=req.body;constresult=awaitdb.query(`INSERT INTO items
(company_id, item_name, hsn_code, unit, rate, gst_rate, opening_stock)
VALUES ($1,$2,$3,$4,$5,$6,$7)
RETURNING *`,[company_id,item_name,hsn_code,unit,rate,gst_rate,opening_stock]);res.json(result.rows[0]);
});
module.exports=router;