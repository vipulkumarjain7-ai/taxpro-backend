const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuid } = require("uuid");
const { body, validationResult } = require("express-validator");
const pool = require("../config/database");
const auth = require("../middleware/auth");

const router = express.Router();

router.post("/register", [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
  body("password").isLength({ min: 6 }).withMessage("Password min 6 chars"),
  body("firm_name").trim().notEmpty().withMessage("Firm name is required"),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { name, email, password, firm_name, frn } = req.body;
    const exists = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (exists.rows[0]) return res.status(409).json({ success: false, message: "Email already registered" });
    const hashed = await bcrypt.hash(password, 12);
    const id = uuid();
    await pool.query(
      "INSERT INTO users (id,name,email,password,firm_name,frn,role) VALUES($1,$2,$3,$4,$5,$6,'ca')",
      [id, name, email, hashed, firm_name, frn||null]
    );
    const token = jwt.sign({ id, name, email, firm_name, role:"ca" }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN||"7d" });
    res.status(201).json({ success: true, token, user: { id, name, email, firm_name, frn, role:"ca" } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post("/login", [
  body("email").isEmail().normalizeEmail(),
  body("password").notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { email, password } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ success: false, message: "Invalid email or password" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: "Invalid email or password" });
    const token = jwt.sign({ id:user.id, name:user.name, email:user.email, firm_name:user.firm_name, role:user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN||"7d" });
    res.json({ success: true, token, user: { id:user.id, name:user.name, email:user.email, firm_name:user.firm_name, frn:user.frn, role:user.role } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get("/me", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT id,name,email,firm_name,frn,role,created_at FROM users WHERE id=$1", [req.user.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, user: result.rows[0] });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put("/profile", auth, async (req, res) => {
  try {
    const { name, firm_name, frn } = req.body;
    await pool.query("UPDATE users SET name=$1,firm_name=$2,frn=$3 WHERE id=$4", [name, firm_name, frn||null, req.user.id]);
    res.json({ success: true, message: "Profile updated" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post("/change-password", auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password || new_password.length < 6) return res.status(400).json({ success: false, message: "Invalid password data" });
    const result = await pool.query("SELECT password FROM users WHERE id=$1", [req.user.id]);
    const match = await bcrypt.compare(current_password, result.rows[0].password);
    if (!match) return res.status(401).json({ success: false, message: "Current password incorrect" });
    const hashed = await bcrypt.hash(new_password, 12);
    await pool.query("UPDATE users SET password=$1 WHERE id=$2", [hashed, req.user.id]);
    res.json({ success: true, message: "Password changed" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;