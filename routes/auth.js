const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
const db = require("../config/database");

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "taxpro-super-secret-key";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

/* =====================================================
   HELPER: REMOVE PASSWORD FROM USER OBJECT
===================================================== */
function sanitizeUser(user) {
  if (!user) return null;
  const { password, ...safeUser } = user;
  return safeUser;
}

/* =====================================================
   REGISTER
   POST /api/auth/register
===================================================== */
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required",
      });
    }

    // Check if user already exists
    const existing = await db.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER($1)",
      [email.trim()]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    const id = randomUUID();

    // Insert user (minimal fields)
    const result = await db.query(
      `
      INSERT INTO users (id, name, email, password)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [id, name.trim(), email.trim().toLowerCase(), hashedPassword]
    );

    const user = result.rows[0];

    // Generate token
    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.status(201).json({
      success: true,
      message: "Registration successful",
      token,
      user: sanitizeUser(user),
    });
  } catch (err) {
    console.error("Register Error:", err.stack || err);
    res.status(500).json({
      success: false,
      message: "Registration failed: " + err.message,
    });
  }
});

/* =====================================================
   LOGIN
   POST /api/auth/login
===================================================== */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const result = await db.query(
      "SELECT * FROM users WHERE LOWER(email) = LOWER($1)",
      [email.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      message: "Login successful",
      token,
      user: sanitizeUser(user),
    });
  } catch (err) {
    console.error("Login Error:", err.stack || err);
    res.status(500).json({
      success: false,
      message: "Login failed: " + err.message,
    });
  }
});

/* =====================================================
   GET CURRENT USER
   GET /api/auth/me
===================================================== */
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authorization token required" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await db.query("SELECT * FROM users WHERE id = $1", [decoded.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({ success: true, user: sanitizeUser(result.rows[0]) });
  } catch (err) {
    console.error("Auth Me Error:", err.stack || err);
    res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
});

module.exports = router;