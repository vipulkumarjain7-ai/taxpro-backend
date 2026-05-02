const express = require("express");
const auth = require("../middleware/auth");
const https = require("https");
const router = express.Router();
router.use(auth);

router.post("/chat", async (req, res) => {
  const { messages } = req.body;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ success:false, message:"API key not configured" });
  }

  const lastMessage = messages[messages.length - 1].content;
  const history = messages.slice(0, -1).map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));

  const postData = JSON.stringify({
    system_instruction: {
      parts: [{ text: "You are an expert Indian GST consultant for a Chartered Accountant. Deep expertise in CGST/IGST Acts, ITC Sections 16-18, GSTR returns, GST notices DRC-01 ASMT-10 SCN, reconciliation, e-invoicing, RCM. Be concise and cite sections when relevant. Use Rs. for rupees." }]
    },
    contents: [
      ...history,
      { role:"user", parts:[{ text: lastMessage }] }
    ]
  });

  const options = {
    hostname: "generativelanguage.googleapis.com",
    path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData)
    }
  };

  const request = https.request(options, (response) => {
    let data = "";
    response.on("data", chunk => { data += chunk; });
    response.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) {
          console.log("Gemini error:", parsed.error.message);
          return res.status(500).json({ success:false, message: parsed.error.message });
        }
        const reply = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, could not process.";
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