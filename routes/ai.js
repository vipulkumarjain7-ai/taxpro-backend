const express = require("express");
const auth = require("../middleware/auth");
const https = require("https");
const router = express.Router();
router.use(auth);

const callGroq = (messages, systemPrompt) => {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages
      ],
      max_tokens: 1500
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

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const reply = parsed.choices?.[0]?.message?.content || "Sorry, could not process.";
          resolve(reply);
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
};

// General GST chat
router.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    const reply = await callGroq(messages,
      "You are an expert Indian GST consultant for a Chartered Accountant. Deep expertise in CGST/IGST Acts, ITC Sections 16-18, GSTR returns, GST notices DRC-01 ASMT-10 SCN, reconciliation, e-invoicing, RCM. Be concise and cite sections when relevant. Use Rs. for rupees."
    );
    res.json({ success: true, reply });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// Notice reply generator
router.post("/generate-reply", async (req, res) => {
  try {
    const { notice_type, ref_no, amount, client_name, gstin, description } = req.body;

    const prompt = `Generate a professional GST notice reply for the following:
    
Client: ${client_name}
GSTIN: ${gstin}
Notice Type: ${notice_type}
Reference No: ${ref_no}
Amount: Rs.${amount}
Description: ${description || "Not provided"}

Write a formal, professional reply to this GST notice. Include:
1. Proper salutation to the Tax Officer
2. Reference to the notice
3. Explanation/justification
4. Supporting points under relevant GST sections
5. Request for dropping the notice
6. Proper closing

Make it ready to submit to the GST department.`;

    const reply = await callGroq(
      [{ role: "user", content: prompt }],
      "You are an expert Indian GST lawyer and consultant helping a CA draft formal notice replies. Write professional, legally sound responses to GST notices. Use proper legal language and cite relevant sections of CGST Act."
    );
    res.json({ success: true, reply });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;