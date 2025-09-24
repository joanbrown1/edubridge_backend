const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("./models/user");
const History = require("./models/history");
require("dotenv").config();

const router = express.Router();
const SECRET = process.env.JWT_SECRET;

// Signup
router.post("/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  try {
    const exists = await User.findOne({ where: { email } });
    if (exists) return res.status(400).json({ error: "User already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, passwordHash });

    const token = jwt.sign({ id: user.id, email }, SECRET, { expiresIn: "7d" });
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: "Signup failed", details: err.message });
  }
});

// Login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ where: { email } });
  if (!user) return res.status(400).json({ error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(400).json({ error: "Invalid credentials" });

  const token = jwt.sign({ id: user.id, email }, SECRET, { expiresIn: "7d" });
  res.json({ success: true, token });
});

// Auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "No token" });
  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// Save history
router.post("/save-history", auth, async (req, res) => {
  const { summary, quiz, flashcards, originalText, level } = req.body;
  if (!summary || !quiz || !flashcards)
    return res.status(400).json({ error: "Missing fields" });

  try {
    const item = await History.create({
      summary,
      quiz,
      flashcards,
      originalText,
      level,
      userId: req.user.id,
    });
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: "Failed to save", details: err.message });
  }
});

// Fetch history
router.get("/history", auth, async (req, res) => {
  const items = await History.findAll({
    where: { userId: req.user.id },
    order: [["createdAt", "DESC"]],
  });
  res.json({ success: true, items });
});

module.exports = router;
