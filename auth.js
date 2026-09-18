const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = Date.now() + SESSION_MS;

  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(tokenHash, userId, expiresAt);

  return token;
}

function getUserFromSession(token) {
  const tokenHash = hashToken(token);
  const row = db.prepare(`
    SELECT s.user_id
    FROM sessions s
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(tokenHash, Date.now());

  if (!row) return null;
  return db.getUserById(row.user_id);
}

function deleteSession(token) {
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getUserFromSession,
  deleteSession
};
