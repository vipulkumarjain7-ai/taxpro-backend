const express = require("express");
const multer  = require("multer");
const https   = require("https");
const { v4: uuid } = require("uuid");
const pool    = require("../config/database");
const auth    = require("../middleware/auth");

const router = express.Router();
router.use(auth);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Create bank_transactions table if not exists ───────────────────────────
const initBankTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_transactions (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        bank_name       TEXT,
        account_no      TEXT,
        statement_date  TEXT,
        txn_date        TEXT NOT NULL,
        description     TEXT NOT NULL,
        ref_no          TEXT,
        debit           REAL DEFAULT 0,
        credit          REAL DEFAULT 0,
        balance         REAL DEFAULT 0,
        category        TEXT DEFAULT 'Uncategorized',
        sub_category    TEXT,
        type            TEXT DEFAULT 'UNKNOWN',
        is_reconciled   BOOLEAN DEFAULT FALSE,
        notes           TEXT,
        import_id       TEXT,
        created_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS bank_imports (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        bank_name    TEXT,
        account_no   TEXT,
        from_date    TEXT,
        to_date      TEXT,
        total_txns   INTEGER DEFAULT 0,
        total_debit  REAL DEFAULT 0,
        total_credit REAL DEFAULT 0,
        filename     TEXT,
        created_at   TIMESTAMP DEFAULT NOW()
      );
    `);
  } catch(e) { console.error("Bank table init error:", e.message); }
};
initBankTable();

// ── Extract text from PDF ──────────────────────────────────────────────────
const extractPDFText = async (buffer) => {
  try {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    return data.text;
  } catch(e) {
    throw new Error("Could not read PDF. Please ensure it is a valid bank statement PDF.");
  }
};

// ── Parse bank transactions from raw text ─────────────────────────────────
const parseTransactions = (text) => {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const transactions = [];

  // Common date patterns used by Indian banks
  const datePatterns = [
    /(\d{2}[\/\-]\d{2}[\/\-]\d{4})/,   // DD/MM/YYYY or DD-MM-YYYY
    /(\d{2}[\/\-]\d{2}[\/\-]\d{2})/,    // DD/MM/YY
    /(\d{2}\s+[A-Za-z]{3}\s+\d{4})/,    // DD Mon YYYY
    /(\d{4}[\/\-]\d{2}[\/\-]\d{2})/,    // YYYY-MM-DD
  ];

  // Amount pattern
  const amountPattern = /[\d,]+\.?\d*/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Try to find date in line
    let dateMatch = null;
    for (const pattern of datePatterns) {
      const m = line.match(pattern);
      if (m) { dateMatch = m[1]; break; }
    }

    if (!dateMatch) continue;

    // Extract amounts - look for numbers that could be debit/credit/balance
    const amounts = [];
    const amountRegex = /(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;
    let m;
    while ((m = amountRegex.exec(line)) !== null) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (val > 0) amounts.push(val);
    }

    // Extract description (text between date and amounts)
    let description = line
      .replace(dateMatch, "")
      .replace(/\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!description || description.length < 3) {
      // Try next line for description
      if (i + 1 < lines.length) description = lines[i + 1].substring(0, 60);
    }

    if (amounts.length >= 2) {
      // Determine debit/credit based on position
      // Most bank statements: Date | Description | Debit | Credit | Balance
      const debit   = amounts.length >= 3 ? amounts[amounts.length - 3] : 0;
      const credit  = amounts.length >= 2 ? amounts[amounts.length - 2] : 0;
      const balance = amounts[amounts.length - 1] || 0;

      // Check for Dr/Cr keywords
      const isDebit  = line.includes("Dr") || line.includes("DR") || line.includes("Debit");
      const isCredit = line.includes("Cr") || line.includes("CR") || line.includes("Credit");

      if (description && description.length > 2) {
        transactions.push({
          txn_date:    normalizeDate(dateMatch),
          description: description.substring(0, 200),
          debit:       isCredit ? 0 : (debit > 0 ? debit : 0),
          credit:      isDebit  ? 0 : (credit > 0 ? credit : 0),
          balance:     balance,
          raw_line:    line,
        });
      }
    }
  }

  return transactions;
};

// ── Normalize date to YYYY-MM-DD ──────────────────────────────────────────
const normalizeDate = (dateStr) => {
  try {
    const parts = dateStr.split(/[\/\-\s]/);
    if (parts.length === 3) {
      if (parts[0].length === 4) return `${parts[0]}-${parts[1].padStart(2,"0")}-${parts[2].padStart(2,"0")}`;
      const months = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
      const month = months[parts[1].toLowerCase()] || parts[1].padStart(2,"0");
      const year  = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      return `${year}-${month}-${parts[0].padStart(2,"0")}`;
    }
  } catch(e) {}
  return new Date().toISOString().split("T")[0];
};

// ── AI Categorization using Groq ──────────────────────────────────────────
const categorizeWithAI = (transactions) => {
  return new Promise((resolve) => {
    if (!process.env.GROQ_API_KEY || transactions.length === 0) {
      resolve(transactions.map(t => ({ ...t, category: guessCategory(t.description), type: t.debit > 0 ? "DEBIT" : "CREDIT" })));
      return;
    }

    const txnList = transactions.slice(0, 50).map((t, i) =>
      `${i+1}. ${t.debit > 0 ? "DEBIT" : "CREDIT"} Rs.${t.debit || t.credit} — "${t.description}"`
    ).join("\n");

    const postData = JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "system",
        content: `You are an Indian accounting expert. Categorize bank transactions for a business.
Return ONLY a JSON array with objects: { "index": number, "category": string, "sub_category": string, "type": string }

Categories to use:
- INCOME: Sales Receipt, Service Income, Interest Income, Other Income
- EXPENSE: Rent, Salary, Utilities, Office Supplies, Travel, Marketing, Maintenance, Professional Fees
- PURCHASE: Raw Material Purchase, Stock Purchase, Equipment Purchase
- TAX: GST Payment, TDS Payment, Income Tax, Other Tax
- BANK: Bank Charges, Processing Fee, EMI Payment, Loan Repayment
- TRANSFER: Fund Transfer, Internal Transfer
- UNKNOWN: Anything unclear

Type should be: INCOME, EXPENSE, PURCHASE, TAX, BANK, TRANSFER, UNKNOWN`
      }, {
        role: "user",
        content: `Categorize these Indian bank transactions:\n${txnList}\n\nReturn ONLY valid JSON array.`
      }],
      max_tokens: 2000
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
          const content = parsed.choices?.[0]?.message?.content || "[]";
          // Extract JSON from response
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const categories = JSON.parse(jsonMatch[0]);
            const categorized = transactions.map((t, i) => {
              const cat = categories.find(c => c.index === i + 1);
              return {
                ...t,
                category:     cat?.category     || guessCategory(t.description),
                sub_category: cat?.sub_category || "",
                type:         cat?.type         || (t.debit > 0 ? "EXPENSE" : "INCOME"),
              };
            });
            resolve(categorized);
          } else {
            resolve(transactions.map(t => ({ ...t, category: guessCategory(t.description), type: t.debit > 0 ? "EXPENSE" : "INCOME" })));
          }
        } catch(e) {
          resolve(transactions.map(t => ({ ...t, category: guessCategory(t.description), type: t.debit > 0 ? "EXPENSE" : "INCOME" })));
        }
      });
    });

    req.on("error", () => {
      resolve(transactions.map(t => ({ ...t, category: guessCategory(t.description), type: t.debit > 0 ? "EXPENSE" : "INCOME" })));
    });

    req.setTimeout(30000, () => {
      req.destroy();
      resolve(transactions.map(t => ({ ...t, category: guessCategory(t.description), type: t.debit > 0 ? "EXPENSE" : "INCOME" })));
    });

    req.write(postData);
    req.end();
  });
};

// ── Rule-based fallback categorization ────────────────────────────────────
const guessCategory = (desc) => {
  const d = desc.toLowerCase();
  if (d.includes("salary") || d.includes("payroll") || d.includes("wages"))     return "Salary";
  if (d.includes("rent"))                                                          return "Rent";
  if (d.includes("gst") || d.includes("tax") || d.includes("tds"))               return "Tax Payment";
  if (d.includes("electricity") || d.includes("water") || d.includes("utility")) return "Utilities";
  if (d.includes("neft") || d.includes("rtgs") || d.includes("imps"))            return "Fund Transfer";
  if (d.includes("atm") || d.includes("cash withdrawal"))                         return "Cash Withdrawal";
  if (d.includes("emi") || d.includes("loan") || d.includes("repay"))            return "Loan Payment";
  if (d.includes("interest") || d.includes("int."))                              return "Interest";
  if (d.includes("charges") || d.includes("fee") || d.includes("commission"))   return "Bank Charges";
  if (d.includes("insurance") || d.includes("premium"))                          return "Insurance";
  if (d.includes("purchase") || d.includes("vendor") || d.includes("supplier")) return "Purchase";
  if (d.includes("sale") || d.includes("receipt") || d.includes("payment rcvd"))return "Sales Receipt";
  if (d.includes("dividend") || d.includes("mutual fund") || d.includes("sip")) return "Investment";
  if (d.includes("swiggy") || d.includes("zomato") || d.includes("food"))       return "Food & Dining";
  if (d.includes("amazon") || d.includes("flipkart") || d.includes("online"))   return "Online Purchase";
  if (d.includes("petrol") || d.includes("fuel") || d.includes("diesel"))       return "Fuel";
  if (d.includes("travel") || d.includes("flight") || d.includes("hotel"))      return "Travel";
  if (d.includes("medical") || d.includes("hospital") || d.includes("pharma"))  return "Medical";
  return "Uncategorized";
};

// ── POST /api/bank/upload — Upload & parse PDF ────────────────────────────
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "PDF file required" });

    const { bank_name, account_no } = req.body;
    let text = "";

    if (req.file.mimetype === "application/pdf" || req.file.originalname.endsWith(".pdf")) {
      text = await extractPDFText(req.file.buffer);
    } else {
      return res.status(400).json({ success: false, message: "Only PDF files supported" });
    }

    if (!text || text.length < 50) {
      return res.status(400).json({ success: false, message: "Could not extract text from PDF. Try a text-based (non-scanned) PDF." });
    }

    // Parse transactions
    let transactions = parseTransactions(text);

    if (transactions.length === 0) {
      return res.status(400).json({ success: false, message: "No transactions found. Please ensure this is a bank statement PDF." });
    }

    // Categorize with AI
    transactions = await categorizeWithAI(transactions);

    // Calculate summary
    const totalDebit  = transactions.reduce((a, t) => a + (t.debit  || 0), 0);
    const totalCredit = transactions.reduce((a, t) => a + (t.credit || 0), 0);

    res.json({
      success: true,
      message: `Found ${transactions.length} transactions`,
      preview: {
        bank_name:    bank_name || "Unknown Bank",
        account_no:   account_no || "",
        total_txns:   transactions.length,
        total_debit:  totalDebit,
        total_credit: totalCredit,
        transactions: transactions.slice(0, 200), // Max 200 preview
      }
    });

  } catch(e) {
    console.error("Bank upload error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/bank/import — Save transactions to DB ───────────────────────
router.post("/import", async (req, res) => {
  try {
    const { bank_name, account_no, transactions } = req.body;

    if (!transactions || transactions.length === 0) {
      return res.status(400).json({ success: false, message: "No transactions to import" });
    }

    const importId = uuid();
    const totalDebit  = transactions.reduce((a, t) => a + (t.debit  || 0), 0);
    const totalCredit = transactions.reduce((a, t) => a + (t.credit || 0), 0);

    const dates = transactions.map(t => t.txn_date).filter(Boolean).sort();

    // Save import record
    await pool.query(`
      INSERT INTO bank_imports (id, user_id, bank_name, account_no, from_date, to_date, total_txns, total_debit, total_credit, filename)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [importId, req.user.id, bank_name||"Unknown", account_no||"", dates[0]||"", dates[dates.length-1]||"", transactions.length, totalDebit, totalCredit, `statement_${Date.now()}.pdf`]);

    // Save transactions
    let saved = 0;
    for (const txn of transactions) {
      await pool.query(`
        INSERT INTO bank_transactions
        (id, user_id, bank_name, account_no, txn_date, description, ref_no, debit, credit, balance, category, sub_category, type, import_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      `, [
        uuid(), req.user.id, bank_name||"Unknown", account_no||"",
        txn.txn_date, txn.description, txn.ref_no||null,
        txn.debit||0, txn.credit||0, txn.balance||0,
        txn.category||"Uncategorized", txn.sub_category||null,
        txn.type||"UNKNOWN", importId
      ]);
      saved++;
    }

    res.json({ success: true, message: `${saved} transactions imported successfully!`, import_id: importId });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/bank/transactions — Get all transactions ─────────────────────
router.get("/transactions", async (req, res) => {
  try {
    const { category, type, from_date, to_date, import_id, search } = req.query;
    let query = "SELECT * FROM bank_transactions WHERE user_id=$1";
    const params = [req.user.id];
    if (category)  { query += ` AND category=$${params.length+1}`;                                   params.push(category); }
    if (type)      { query += ` AND type=$${params.length+1}`;                                        params.push(type); }
    if (from_date) { query += ` AND txn_date>=$${params.length+1}`;                                   params.push(from_date); }
    if (to_date)   { query += ` AND txn_date<=$${params.length+1}`;                                   params.push(to_date); }
    if (import_id) { query += ` AND import_id=$${params.length+1}`;                                   params.push(import_id); }
    if (search)    { query += ` AND description ILIKE $${params.length+1}`;                           params.push(`%${search}%`); }
    query += " ORDER BY txn_date DESC, created_at DESC";
    const result = await pool.query(query, params);

    const totalDebit  = result.rows.reduce((a, t) => a + parseFloat(t.debit  || 0), 0);
    const totalCredit = result.rows.reduce((a, t) => a + parseFloat(t.credit || 0), 0);

    // Category summary
    const catSummary = {};
    result.rows.forEach(t => {
      if (!catSummary[t.category]) catSummary[t.category] = { debit:0, credit:0, count:0 };
      catSummary[t.category].debit  += parseFloat(t.debit  || 0);
      catSummary[t.category].credit += parseFloat(t.credit || 0);
      catSummary[t.category].count++;
    });

    res.json({ success:true, count:result.rows.length, transactions:result.rows, summary:{ total_debit:totalDebit, total_credit:totalCredit, net:totalCredit-totalDebit, categories:catSummary } });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── GET /api/bank/imports — List all imports ──────────────────────────────
router.get("/imports", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM bank_imports WHERE user_id=$1 ORDER BY created_at DESC", [req.user.id]);
    res.json({ success:true, imports:result.rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── PATCH /api/bank/transactions/:id — Update category ───────────────────
router.patch("/transactions/:id", async (req, res) => {
  try {
    const { category, sub_category, type, notes } = req.body;
    await pool.query(
      "UPDATE bank_transactions SET category=$1, sub_category=$2, type=$3, notes=$4 WHERE id=$5 AND user_id=$6",
      [category, sub_category||null, type||null, notes||null, req.params.id, req.user.id]
    );
    res.json({ success:true, message:"Updated" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── GET /api/bank/summary — Category-wise summary ─────────────────────────
router.get("/summary", async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    let query = "SELECT category, type, SUM(debit) as total_debit, SUM(credit) as total_credit, COUNT(*) as count FROM bank_transactions WHERE user_id=$1";
    const params = [req.user.id];
    if (from_date) { query += ` AND txn_date>=$${params.length+1}`; params.push(from_date); }
    if (to_date)   { query += ` AND txn_date<=$${params.length+1}`; params.push(to_date); }
    query += " GROUP BY category, type ORDER BY total_debit DESC";
    const result = await pool.query(query, params);

    // Head-wise grouping
    const heads = {};
    result.rows.forEach(r => {
      const head = r.type || "UNKNOWN";
      if (!heads[head]) heads[head] = { total_debit:0, total_credit:0, count:0, categories:[] };
      heads[head].total_debit  += parseFloat(r.total_debit  || 0);
      heads[head].total_credit += parseFloat(r.total_credit || 0);
      heads[head].count        += parseInt(r.count);
      heads[head].categories.push({ category:r.category, debit:parseFloat(r.total_debit||0), credit:parseFloat(r.total_credit||0), count:parseInt(r.count) });
    });

    res.json({ success:true, heads, rows:result.rows });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

// ── DELETE /api/bank/imports/:id — Delete import ─────────────────────────
router.delete("/imports/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM bank_transactions WHERE import_id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    await pool.query("DELETE FROM bank_imports WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    res.json({ success:true, message:"Import deleted" });
  } catch(e) { res.status(500).json({ success:false, message:e.message }); }
});

module.exports = router;