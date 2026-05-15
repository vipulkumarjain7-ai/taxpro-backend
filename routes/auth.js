// routes/auth.js
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
    const {
      name,
      email,
      password,
      firm_name,
      frn,
      role = "ca",
      gstin,
      address,
      phone,
    } = req.body;

    // Basic validation
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

    // Create user
    const id = randomUUID();

    const result = await db.query(
      `
      INSERT INTO users (
        id,
        name,
        email,
        password,
        firm_name,
        frn,
        role,
        gstin,
        address,
        phone
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      )
      RETURNING *
      `,
      [
        id,
        name.trim(),
        email.trim().toLowerCase(),
        hashedPassword,
        firm_name || null,
        frn || null,
        role,
        gstin || null,
        address || null,
        phone || null,
      ]
    );

    const user = result.rows[0];

    // Generate token
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      JWT_SECRET,
      {
        expiresIn: JWT_EXPIRES_IN,
      }
    );

    res.status(201).json({
      success: true,
      message: "Registration successful",
      token,
      user: sanitizeUser(user),
    });
  } catch (err) {
    console.error("Register Error:", err);

    res.status(500).json({
      success: false,
      message: err.message,
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

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // Find user
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

    // Compare password
    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Generate token
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      JWT_SECRET,
      {
        expiresIn: JWT_EXPIRES_IN,
      }
    );

    res.json({
      success: true,
      message: "Login successful",
      token,
      user: sanitizeUser(user),
    });
  } catch (err) {
    console.error("Login Error:", err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/* =====================================================
   GET CURRENT USER
   GET /api/auth/me
   Authorization: Bearer <token>
===================================================== */
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorization token required",
      });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await db.query(
      "SELECT * FROM users WHERE id = $1",
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      user: sanitizeUser(result.rows[0]),
    });
  } catch (err) {
    console.error("Auth Me Error:", err);

    res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
});

/* =====================================================
   UPDATE PROFILE
   PUT /api/auth/profile
===================================================== */
router.put("/profile", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorization token required",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const {
      name,
      firm_name,
      frn,
      gstin,
      address,
      phone,
      logo_url,
    } = req.body;

    const result = await db.query(
      `
      UPDATE users
      SET
        name = COALESCE($1, name),
        firm_name = COALESCE($2, firm_name),
        frn = COALESCE($3, frn),
        gstin = COALESCE($4, gstin),
        address = COALESCE($5, address),
        phone = COALESCE($6, phone),
        logo_url = COALESCE($7, logo_url)
      WHERE id = $8
      RETURNING *
      `,
      [
        name,
        firm_name,
        frn,
        gstin,
        address,
        phone,
        logo_url,
        decoded.id,
      ]
    );

    res.json({
      success: true,
      message: "Profile updated successfully",
      user: sanitizeUser(result.rows[0]),
    });
  } catch (err) {
    console.error("Profile Update Error:", err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

/* =====================================================
   CHANGE PASSWORD
   PUT /api/auth/change-password
===================================================== */
router.put("/change-password", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorization token required",
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    const result = await db.query(
      "SELECT * FROM users WHERE id = $1",
      [decoded.id]
    );

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(
      currentPassword,
      user.password
    );

    if (!validPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await db.query(
      "UPDATE users SET password = $1 WHERE id = $2",
      [hashedPassword, decoded.id]
    );

    res.json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (err) {
    console.error("Change Password Error:", err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

module.exports = router;