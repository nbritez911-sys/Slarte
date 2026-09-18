const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(process.env.DATABASE_PATH || path.join(__dirname, "..", "slarte.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('private', 'group')),
    title TEXT,
    avatar_url TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_id
    ON messages(conversation_id, id DESC);

  CREATE INDEX IF NOT EXISTS idx_members_user_id
    ON conversation_members(user_id);
`);

function getUserById(id) {
  return db.prepare(`
    SELECT id, username, name, password_hash, avatar_url, description, created_at
    FROM users WHERE id = ?
  `).get(id);
}

function getUserByUsername(username) {
  return db.prepare(`
    SELECT id, username, name, password_hash, avatar_url, description, created_at
    FROM users WHERE username = ? COLLATE NOCASE
  `).get(username);
}

function createUser({ username, name, passwordHash, avatarUrl, description }) {
  const result = db.prepare(`
    INSERT INTO users (username, name, password_hash, avatar_url, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, name, passwordHash, avatarUrl, description);
  return getUserById(result.lastInsertRowid);
}

function updateUser(id, { name, avatarUrl, description }) {
  const current = getUserById(id);
  db.prepare(`
    UPDATE users
    SET name = COALESCE(?, name),
        avatar_url = CASE WHEN ? IS NULL THEN avatar_url ELSE ? END,
        description = COALESCE(?, description)
    WHERE id = ?
  `).run(
    name ?? null,
    avatarUrl === undefined ? null : "__provided__",
    avatarUrl === undefined ? null : avatarUrl,
    description ?? null,
    id
  );
  return getUserById(id) || current;
}

function searchUsers(q, excludeId) {
  const pattern = `%${q}%`;
  return db.prepare(`
    SELECT id, username, name, password_hash, avatar_url, description, created_at
    FROM users
    WHERE id != ?
      AND (username LIKE ? OR name LIKE ?)
    ORDER BY username COLLATE NOCASE
    LIMIT 20
  `).all(excludeId, pattern, pattern);
}

function getOrCreatePrivateConversation(a, b) {
  const existing = db.prepare(`
    SELECT c.id, c.type, c.title, c.avatar_url, c.created_by, c.created_at
    FROM conversations c
    JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
    JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
    WHERE c.type = 'private'
      AND (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) = 2
    LIMIT 1
  `).get(a, b);

  if (existing) return existing;

  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO conversations (type, created_by) VALUES ('private', ?)
    `).run(a);
    const id = result.lastInsertRowid;
    const add = db.prepare(`
      INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)
    `);
    add.run(id, a);
    add.run(id, b);
    return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
  });
  return tx();
}

function listConversations(userId) {
  return db.prepare(`
    SELECT
      c.id,
      c.type,
      c.title,
      c.avatar_url,
      c.created_at,
      (
        SELECT m.text
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.id DESC LIMIT 1
      ) AS last_message,
      (
        SELECT m.created_at
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.id DESC LIMIT 1
      ) AS last_message_at
    FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id = c.id
    WHERE cm.user_id = ?
    ORDER BY COALESCE(last_message_at, c.created_at) DESC
  `).all(userId);
}

function isConversationMember(conversationId, userId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM conversation_members
    WHERE conversation_id = ? AND user_id = ?
  `).get(conversationId, userId));
}

function getConversationMemberIds(conversationId) {
  return db.prepare(`
    SELECT user_id FROM conversation_members WHERE conversation_id = ?
  `).all(conversationId).map(row => row.user_id);
}

function getMessages(conversationId, limit, beforeId) {
  const rows = beforeId
    ? db.prepare(`
        SELECT m.id, m.conversation_id, m.sender_id, m.text, m.created_at,
               u.username, u.name, u.avatar_url
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ? AND m.id < ?
        ORDER BY m.id DESC LIMIT ?
      `).all(conversationId, beforeId, limit)
    : db.prepare(`
        SELECT m.id, m.conversation_id, m.sender_id, m.text, m.created_at,
               u.username, u.name, u.avatar_url
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ?
        ORDER BY m.id DESC LIMIT ?
      `).all(conversationId, limit);

  return rows.reverse();
}

function createMessage(conversationId, senderId, text) {
  const result = db.prepare(`
    INSERT INTO messages (conversation_id, sender_id, text)
    VALUES (?, ?, ?)
  `).run(conversationId, senderId, text);

  return db.prepare(`
    SELECT m.id, m.conversation_id, m.sender_id, m.text, m.created_at,
           u.username, u.name, u.avatar_url
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(result.lastInsertRowid);
}

function createGroup(name, avatarUrl, creatorId, memberIds) {
  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO conversations (type, title, avatar_url, created_by)
      VALUES ('group', ?, ?, ?)
    `).run(name, avatarUrl, creatorId);
    const id = result.lastInsertRowid;
    const add = db.prepare(`
      INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)
    `);
    for (const userId of memberIds) add.run(id, userId);
    return getGroup(id);
  });
  return tx();
}

function isGroupMember(groupId, userId) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM conversation_members cm
    JOIN conversations c ON c.id = cm.conversation_id
    WHERE cm.conversation_id = ? AND cm.user_id = ? AND c.type = 'group'
  `).get(groupId, userId));
}

function addGroupMember(groupId, userId) {
  const group = db.prepare(`
    SELECT * FROM conversations WHERE id = ? AND type = 'group'
  `).get(groupId);
  if (!group) return null;

  db.prepare(`
    INSERT OR IGNORE INTO conversation_members (conversation_id, user_id)
    VALUES (?, ?)
  `).run(groupId, userId);

  return getGroup(groupId);
}

function getGroup(groupId) {
  const group = db.prepare(`
    SELECT * FROM conversations WHERE id = ? AND type = 'group'
  `).get(groupId);
  if (!group) return null;

  const members = db.prepare(`
    SELECT u.id, u.username, u.name, u.password_hash, u.avatar_url, u.description, u.created_at
    FROM users u
    JOIN conversation_members cm ON cm.user_id = u.id
    WHERE cm.conversation_id = ?
    ORDER BY u.username COLLATE NOCASE
  `).all(groupId);

  return { ...group, members };
}

module.exports = {
  getUserById,
  getUserByUsername,
  createUser,
  updateUser,
  searchUsers,
  getOrCreatePrivateConversation,
  listConversations,
  isConversationMember,
  getConversationMemberIds,
  getMessages,
  createMessage,
  createGroup,
  isGroupMember,
  addGroupMember,
  getGroup
};
