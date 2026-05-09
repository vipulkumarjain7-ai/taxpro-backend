const express = require("express");
const https = require("https");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// State codes
const STATES = {
  "01":"Jammu & Kashmir","02":"Himachal Pradesh",
  "03":"Punjab","04":"Chandigarh","05":"Uttarakhand",
  "06":"Haryana","07":"Delhi","08":"Rajasthan",
  "09":"Uttar Pradesh","10":"Bihar","11":"Sikkim",
  "12":"Arunachal Pradesh","13":"Nagaland","14":"Manipur",
  "15":"Mizoram","16":"Tripura","17":"Meghalaya",
  "18":"Assam","19":"West Bengal","20":"Jharkhand",
  "21":"Odisha","22":"Chhattisgarh","23":"Madhya Pradesh",
  "24":"Gujarat","27":"Maharashtra","28":"Andhra Pradesh",
  "29":"Karnataka","30":"Goa","32":"Kerala",
  "33":"Tamil Nadu","34":"Puducherry","36":"Telangana",
  "37":"Andhra Pradesh (New)","38":"Ladakh"
};

// Validate GSTIN format
const isValidFormat = (gstin) => {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin);
};

// GET /api/gstin/validate/:gstin — Format check (offline)
router.get("/validate/:gstin", (req, res) => {
  const gstin = req.params.gstin.toUpperCase().trim();
  if (!isValidFormat(gstin)) {
    return res.json({
      success: true, valid: false,
      message: "Invalid GSTIN format",
      details: null
    });
  }
  res.json({
    success: true, valid: true,
    message: "Valid GSTIN format",
    details: {
      gstin,
      state_code: gstin.substring(0,2),
      state: STATES[gstin.substring(0,2)] || "Unknown",
      pan: gstin.substring(2,12),
      entity_no: gstin.substring(12,13),
      type: gstin.substring(12,13)==="1"?"Regular Taxpayer":"Other",
    }
  });
});

// GET /api/gstin/search/:gstin — Live search from GST portal
router.get("/search/:gstin", async (req, res) => {
  const gstin = req.params.gstin.toUpperCase().trim();

  if (!isValidFormat(gstin)) {
    return res.json({ success: false, valid: false, message: "Invalid GSTIN format" });
  }

  try {
    // Use GST portal public search API
    const options = {
      hostname: "api.gst.gov.in",
      path: `/commonapi/v1.1/search?action=TP&gstin=${gstin}`,
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      }
    };

    const request = https.request(options, (response) => {
      let data = "";
      response.on("data", chunk => { data += chunk; });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.taxpayerInfo) {
            const info = parsed.taxpayerInfo;
            res.json({
              success: true, valid: true, online: true,
              message: "GSTIN verified from GST Portal",
              details: {
                gstin: gstin,
                legal_name: info.lgnm || "",
                trade_name: info.tradeNam || "",
                state: info.pradr?.addr?.stcd || STATES[gstin.substring(0,2)] || "",
                state_code: gstin.substring(0,2),
                pan: gstin.substring(2,12),
                status: info.sts || "",
                registration_date: info.rgdt || "",
                taxpayer_type: info.dty || "",
                address: [
                  info.pradr?.addr?.bnm,
                  info.pradr?.addr?.st,
                  info.pradr?.addr?.loc,
                  info.pradr?.addr?.dst,
                  info.pradr?.addr?.stcd,
                  info.pradr?.addr?.pncd
                ].filter(Boolean).join(", "),
                business_nature: (info.nba || []).join(", "),
                last_updated: info.lstupdt || "",
              }
            });
          } else {
            // Fallback to format validation
            res.json({
              success: true, valid: true, online: false,
              message: "Format valid. GST Portal search unavailable.",
              details: {
                gstin,
                state: STATES[gstin.substring(0,2)] || "Unknown",
                state_code: gstin.substring(0,2),
                pan: gstin.substring(2,12),
              }
            });
          }
        } catch(e) {
          res.json({
            success: true, valid: true, online: false,
            message: "Format valid. Could not fetch live data.",
            details: {
              gstin,
              state: STATES[gstin.substring(0,2)] || "Unknown",
              pan: gstin.substring(2,12),
            }
          });
        }
      });
    });

    request.on("error", () => {
      res.json({
        success: true, valid: true, online: false,
        message: "Format valid. Live search unavailable.",
        details: {
          gstin,
          state: STATES[gstin.substring(0,2)] || "Unknown",
          pan: gstin.substring(2,12),
        }
      });
    });

    request.setTimeout(5000, () => {
      request.destroy();
    });

    request.end();
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;