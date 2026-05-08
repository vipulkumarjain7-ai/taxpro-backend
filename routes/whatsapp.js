const express = require("express");
const https = require("https");
const pool = require("../config/database");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// Send WhatsApp message via Twilio
const sendWhatsApp = (to, message) => {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const from       = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

    if (!accountSid || !authToken) {
      return reject(new Error("Twilio credentials not configured"));
    }

    const postData = new URLSearchParams({
      From: from,
      To: `whatsapp:${to}`,
      Body: message
    }).toString();

    const options = {
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        const parsed = JSON.parse(data);
        if (parsed.sid) resolve(parsed);
        else reject(new Error(parsed.message || "WhatsApp send failed"));
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
};

// POST send due date reminders
router.post("/send-reminders", async (req, res) => {
  try {
    const uid = req.user.id;
    const today = new Date();
    const in7Days = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const todayStr = today.toISOString().split("T")[0];

    // Get notices due in next 7 days
    const notices = await pool.query(`
      SELECT n.*, c.name as client_name, c.gstin
      FROM notices n JOIN clients c ON n.client_id = c.id
      WHERE n.user_id=$1 AND n.due_date BETWEEN $2 AND $3
      AND n.status NOT IN ('closed','replied')
    `, [uid, todayStr, in7Days]);

    if (notices.rows.length === 0) {
      return res.json({ success: true, message: "No upcoming notices to remind" });
    }

    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "Phone number required" });

    let message = `*TaxPro GST - Due Date Reminder*\n\nYou have ${notices.rows.length} notice(s) due in the next 7 days:\n\n`;

    notices.rows.forEach((n, i) => {
      message += `${i+1}. *${n.client_name}*\n   Type: ${n.type}\n   Due: ${n.due_date}\n   Amount: Rs.${n.amount}\n\n`;
    });

    message += `_Please take action immediately._`;

    await sendWhatsApp(phone, message);
    res.json({ success: true, message: `Reminder sent for ${notices.rows.length} notices` });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST send custom message
router.post("/send", async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ success: false, message: "Phone and message required" });
    await sendWhatsApp(phone, message);
    res.json({ success: true, message: "WhatsApp message sent!" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST send filing reminder to client
router.post("/filing-reminder", async (req, res) => {
  try {
    const { phone, client_name, returns_pending } = req.body;
    const message = `*TaxPro GST - Filing Reminder*\n\nDear ${client_name},\n\nThe following GST returns are pending:\n${returns_pending}\n\nPlease arrange for filing at the earliest to avoid penalties.\n\nRegards,\n${req.user.firm_name || req.user.name}`;
    await sendWhatsApp(phone, message);
    res.json({ success: true, message: "Filing reminder sent!" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;