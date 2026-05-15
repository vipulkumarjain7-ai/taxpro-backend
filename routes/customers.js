constexpress=require('express');
constrouter=express.Router();
const db = require("../config/database");
router.get('/',async(req,res)=>{constresult=awaitdb.query('SELECT * FROM customers ORDER BY id DESC');res.json(result.rows);
});
router.post('/',async(req,res)=>{const{company_id,name,gstin,phone,address}=req.body;constresult=awaitdb.query(`INSERT INTO customers (company_id, name, gstin, phone, address)
VALUES ($1, $2, $3, $4, $5)
RETURNING *`,[company_id,name,gstin,phone,address]);res.json(result.rows[0]);
});
module.exports=router;