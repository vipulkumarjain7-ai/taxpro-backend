const express = require("express");
const auth = require("../middleware/auth");
const router = express.Router();
router.use(auth);

router.post("/chat", async (req, res) => {
  const { messages } = req.body;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: "You are an expert Indian GST consultant for a Chartered Accountant. Deep expertise in CGST/IGST Acts, ITC Sections 16-18, GSTR returns, GST notices (DRC-01, ASMT-10, SCN), reconciliation, e-invoicing, RCM. Be concise and cite sections when relevant.",
        messages: messages
      })
    });
    const data = await response.json();
    res.json({ success: true, reply: data.content?.[0]?.text || "Sorry, could not process." });
  } catch(err) {
    res.status(500).json({ success: false, message: "AI error" });
  }
});

module.exports = router;