const express = require("express");
const auth = require("../middleware/auth");
const https = require("https");
const router = express.Router();
router.use(auth);

router.post("/chat", async (req, res) => {
  const { messages } = req.body;

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ success:false, message:"API key not configured" });
  }

  const postData = JSON.stringify({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: "You are an expert Indian GST consultant for a Chartered Accountant. Deep expertise in CGST/IGST Acts, ITC Sections 16-18, GSTR returns, GST notices DRC-01 ASMT-10 SCN, reconciliation, e-invoicing, RCM. Be concise and cite sections when relevant. Use Rs. for rupees."
      },
      ...messages
    ],
    max_tokens: 1000
  });

  const options = {
    hostname: "api.groq.com",
    path: "/openai/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Length": Buffer.byteLength(postData)
    }
  };

  const request = https.request(options, (response) => {
    let data = "";
    response.on("data", chunk => { data += chunk; });
    response.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        console.log("Groq response:", JSON.stringify(parsed));
        if (parsed.error) {
          return res.status(500).json({ success:false, message: parsed.error.message });
        }
        const reply = parsed.choices?.[0]?.message?.content || "Sorry, could not process.";
        res.json({ success:true, reply });
      } catch(e) {
        console.log("Parse error:", e.message);
        res.status(500).json({ success:false, message:"Parse error" });
      }
    });
  });

  request.on("error", err => {
    console.log("Request error:", err.message);
    res.status(500).json({ success:false, message: err.message });
  });

  request.write(postData);
  request.end();
});

module.exports = router;