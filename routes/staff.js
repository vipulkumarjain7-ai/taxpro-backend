const express = require("express");
const { v4: uuid } = require("uuid");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
const pool = require("../config/database");
const auth = require("../middleware/auth");

const router = express.Router();
router.use(auth);

// Only CA (admin) can manage staff
const isAdmin = (req, res, next) => {
  if (req.user.role !== "ca") return res.status(403).json({ success: false, message: "Only CAs can manage staff" });
  next();
};

// GET all staff
router.get("/", isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email, role, firm_name, created_at FROM users WHERE parent_id = $1 ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json({ success: true, staff: result.rows });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST add staff member
router.post("/", isAdmin, [
  body("name").trim().notEmpty().withMessage("Name is required"),
  body("email").isEmail().normalizeEmail().withMessage("Valid email required"),
  body("password").isLength({ min: 6 }).withMessage("Password min 6 chars"),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  try {
    const { name, email, password } = req.body;
    const exists = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (exists.rows[0]) return res.status(409).json({ success: false, message: "Email already exists" });
    const hashed = await bcrypt.hash(password, 12);
    const id = uuid();
    await pool.query(
      "INSERT INTO users (id,name,email,password,firm_name,role,parent_id) VALUES($1,$2,$3,$4,$5,'staff',$6)",
      [id, name, email, hashed, req.user.firm_name, req.user.id]
    );
    res.status(201).json({ success: true, message: "Staff member added", staff: { id, name, email, role: "staff" } });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE staff member
router.delete("/:id", isAdmin, async (req, res) => {
  try {
    const staff = await pool.query("SELECT id FROM users WHERE id=$1 AND parent_id=$2", [req.params.id, req.user.id]);
    if (!staff.rows[0]) return res.status(404).json({ success: false, message: "Staff not found" });
    await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
    res.json({ success: true, message: "Staff removed" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT reset staff password
router.put("/:id/password", isAdmin, async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ success: false, message: "Password min 6 chars" });
    const staff = await pool.query("SELECT id FROM users WHERE id=$1 AND parent_id=$2", [req.params.id, req.user.id]);
    if (!staff.rows[0]) return res.status(404).json({ success: false, message: "Staff not found" });
    const hashed = await bcrypt.hash(new_password, 12);
    await pool.query("UPDATE users SET password=$1 WHERE id=$2", [hashed, req.params.id]);
    res.json({ success: true, message: "Password updated" });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;