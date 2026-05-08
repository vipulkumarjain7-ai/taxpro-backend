const express = require("express");
const dashboardRouter = express.Router();
const auth = require("../middleware/auth");
dashboardRouter.use(auth);
 
dashboardRouter.get("/", async (req, res) => {
  try {
    const uid = req.user.id;
    const today = new Date().toISOString().split("T")[0];
    const in30 = new Date(Date.now()+30*24*60*60*1000).toISOString().split("T")[0];
 
    const [totalC, compliantC, pendingC, overdueC, openN, overdueN, dueSoonN, upcomingN, recentC, lastPeriod] = await Promise.all([
      pool.query("SELECT COUNT(*) as c FROM clients WHERE user_id=$1", [uid]),
      pool.query("SELECT COUNT(*) as c FROM clients WHERE user_id=$1 AND status='compliant'", [uid]),
      pool.query("SELECT COUNT(*) as c FROM clients WHERE user_id=$1 AND status='pending'", [uid]),
      pool.query("SELECT COUNT(*) as c FROM clients WHERE user_id=$1 AND status='overdue'", [uid]),
      pool.query("SELECT COUNT(*) as c FROM notices WHERE user_id=$1 AND status NOT IN ('closed','replied')", [uid]),
      pool.query("SELECT COUNT(*) as c FROM notices WHERE user_id=$1 AND status='overdue'", [uid]),
      pool.query("SELECT COUNT(*) as c FROM notices WHERE user_id=$1 AND due_date BETWEEN $2 AND $3 AND status NOT IN ('closed','replied')", [uid, today, in30]),
      pool.query("SELECT n.*, c.name as client_name FROM notices n JOIN clients c ON n.client_id=c.id WHERE n.user_id=$1 AND n.due_date BETWEEN $2 AND $3 AND n.status NOT IN ('closed','replied') ORDER BY n.due_date ASC LIMIT 5", [uid, today, in30]),
      pool.query("SELECT * FROM clients WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5", [uid]),
      pool.query("SELECT period FROM returns WHERE user_id=$1 ORDER BY period DESC LIMIT 1", [uid]),
    ]);
 
    let returnsSummary = null;
    if (lastPeriod.rows[0]) {
      const p = lastPeriod.rows[0].period;
      const count = async (field, status) => {
        const r = await pool.query(`SELECT COUNT(*) as c FROM returns WHERE user_id=$1 AND period=$2 AND ${field}=$3`, [uid, p, status]);
        return parseInt(r.rows[0].c);
      };
      returnsSummary = {
        period: p,
        gstr1:  { filed: await count("gstr1_status","filed"),  pending: await count("gstr1_status","pending"),  not_filed: await count("gstr1_status","not-filed")  },
        gstr3b: { filed: await count("gstr3b_status","filed"), pending: await count("gstr3b_status","pending"), not_filed: await count("gstr3b_status","not-filed") },
        gstr9:  { filed: await count("gstr9_status","filed"),  pending: await count("gstr9_status","pending"),  not_filed: await count("gstr9_status","not-filed")  },
      };
    }
 
    res.json({
      success: true,
      dashboard: {
        clients: { total: parseInt(totalC.rows[0].c), compliant: parseInt(compliantC.rows[0].c), pending: parseInt(pendingC.rows[0].c), overdue: parseInt(overdueC.rows[0].c) },
        notices: { open: parseInt(openN.rows[0].c), overdue: parseInt(overdueN.rows[0].c), due_in_30_days: parseInt(dueSoonN.rows[0].c) },
        upcoming_notices: upcomingN.rows,
        recent_clients: recentC.rows,
        returns_summary: returnsSummary,
      }
    });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});
 
module.exports.dashboardRouter = dashboardRouter;