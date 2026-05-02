const express = require("express");
const auth = require("../middleware/auth");
const https = require("https");
const router = express.Router();
router.use(auth);

router.post("/chat", async (req, res) => {
  const { messages } = req.body;
  
  const postData = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: "You are an expert Indian GST consultant for a Chartered Accountant. Deep expertise in CGST/IGST Acts, ITC Sections 16-18, GSTR returns, GST notices DRC-01 ASMT-10 SCN, reconciliation, e-invoicing, RCM. Be concise and cite sections when relevant.",
    messages: messages
  });

  const options = {
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Length": Buffer.byteLength(postData)
    }
  };

  const request = https.request(options, (response) => {
    let data = "";
    response.on("data", (chunk) => { data += chunk; });
    response.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        const reply = parsed.content?.[0]?.text || "Sorry, could not process.";
        res.json({ success: true, reply });
      } catch(e) {
        res.status(500).json({ success: false, message: "Parse error" });
      }
    });
  });

  request.on("error", (err) => {
    res.status(500).json({ success: false, message: err.message });
  });

  request.write(postData);
  request.end();
});

module.exports = router;