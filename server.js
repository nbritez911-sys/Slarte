const http = require("http");
const express = require("express");
const crypto = require("crypto");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const db = require("./src/db");
const {
  hashPassword,
  verifyPassword,
  createSession,
  getUserFromSession,
  deleteSession
} = require("./src/auth");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(require("path").join(__dirname, "Público")));

const PORT = Number(process.env.PORT || 10000);
const SESSION_COOKIE = "slarte_session";
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const socketsByUser = new Map();

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map(v => v.trim()).filter(Boolean).map(v => {
      const i = v.indexOf("=");
      return i === -1 ? [v, ""] : [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
    })
  );
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${secure}`
  );
}

function requireUser(req, res, next) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const user = token ? getUserFromSession(token) : null;
  if (!user) return res.status(401).json({ error: "Authentication required" });
  req.user = user;
  req.sessionToken = token;
  next();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatar_url: user.avatar_url,
    description: user.description,
    online: socketsByUser.has(user.id)
  };
}

function decorateConversation(conversation, userId) {
  if (conversation.type !== "private") return conversation;
  const peerId = db.getConversationMemberIds(conversation.id).find(id => id !== userId);
  const peer = peerId ? db.getUserById(peerId) : null;
  return {
    ...conversation,
    peer: peer ? publicUser(peer) : null
  };
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastToUser(userId, payload) {
  const sockets = socketsByUser.get(userId);
  if (!sockets) return;
  for (const ws of sockets) sendJson(ws, payload);
}

function broadcastPresence(userId) {
  const user = db.getUserById(userId);
  if (!user) return;
  const payload = {
    type: "presence",
    user: publicUser(user)
  };
  for (const sockets of socketsByUser.values()) {
    for (const ws of sockets) sendJson(ws, payload);
  }
}

function validateUsername(username) {
  return typeof username === "string" && /^[a-zA-Z0-9_]{3,30}$/.test(username);
}

function validateText(value, max = 4000) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "slarte-chat" });
});

app.post("/api/auth/register", async (req, res) => {
  const { username, password, name, avatar_url = null, description = "" } = req.body || {};

  if (!validateUsername(username)) {
    return res.status(400).json({ error: "Username must contain 3-30 letters, numbers or underscores." });
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: "Password must be 8-128 characters." });
  }
  if (!validateText(name, 80)) {
    return res.status(400).json({ error: "Name is required and must be at most 80 characters." });
  }
  if (description && typeof description !== "string") {
    return res.status(400).json({ error: "Invalid description." });
  }

  if (db.getUserByUsername(username.toLowerCase())) {
    return res.status(409).json({ error: "Username already exists." });
  }

  const passwordHash = await hashPassword(password);
  const user = db.createUser({
    username: username.toLowerCase(),
    name: name.trim(),
    passwordHash,
    avatarUrl: avatar_url,
    description: String(description).slice(0, 300)
  });

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.status(201).json({ user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const user = db.getUserByUsername(username.toLowerCase());
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", requireUser, (req, res) => {
  deleteSession(req.sessionToken);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});

app.get("/api/me", requireUser, (req, res) => {
  res.json({ user: publicUser(db.getUserById(req.user.id)) });
});

app.patch("/api/me", requireUser, (req, res) => {
  const { name, avatar_url, description } = req.body || {};
  if (name !== undefined && !validateText(name, 80)) {
    return res.status(400).json({ error: "Invalid name." });
  }
  if (avatar_url !== undefined && avatar_url !== null && typeof avatar_url !== "string") {
    return res.status(400).json({ error: "Invalid avatar URL." });
  }
  if (description !== undefined && typeof description !== "string") {
    return res.status(400).json({ error: "Invalid description." });
  }

  const user = db.updateUser(req.user.id, {
    name: name === undefined ? undefined : name.trim(),
    avatarUrl: avatar_url,
    description: description === undefined ? undefined : description.slice(0, 300)
  });
  res.json({ user: publicUser(user) });
});

app.get("/api/users/search", requireUser, (req, res) => {
  const q = String(req.query.q || "").trim().replace(/^@/, "");
  if (q.length < 1) return res.json({ users: [] });
  res.json({
    users: db.searchUsers(q, req.user.id).map(publicUser)
  });
});

app.post("/api/chats/private", requireUser, (req, res) => {
  const targetId = Number(req.body?.user_id);
  if (!Number.isInteger(targetId) || targetId === req.user.id) {
    return res.status(400).json({ error: "Invalid target user." });
  }
  const target = db.getUserById(targetId);
  if (!target) return res.status(404).json({ error: "User not found." });

  const conversation = db.getOrCreatePrivateConversation(req.user.id, targetId);
  res.status(201).json({ conversation: decorateConversation(conversation, req.user.id) });
});

app.get("/api/chats", requireUser, (req, res) => {
  res.json({
    conversations: db.listConversations(req.user.id).map(conversation =>
      decorateConversation(conversation, req.user.id)
    )
  });
});

app.get("/api/chats/:conversationId/messages", requireUser, (req, res) => {
  const conversationId = Number(req.params.conversationId);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = req.query.before ? Number(req.query.before) : null;

  if (!db.isConversationMember(conversationId, req.user.id)) {
    return res.status(403).json({ error: "Not a conversation member." });
  }
  res.json({ messages: db.getMessages(conversationId, limit, before) });
});

app.post("/api/groups", requireUser, (req, res) => {
  const { name, avatar_url = null, member_ids = [] } = req.body || {};
  if (!validateText(name, 100)) return res.status(400).json({ error: "Group name is required." });
  if (!Array.isArray(member_ids) || member_ids.some(id => !Number.isInteger(Number(id)))) {
    return res.status(400).json({ error: "member_ids must be an array of user IDs." });
  }

  const ids = [...new Set([req.user.id, ...member_ids.map(Number)])];
  const existing = ids.map(db.getUserById).filter(Boolean);
  if (existing.length !== ids.length) return res.status(404).json({ error: "One or more users were not found." });

  const group = db.createGroup(name.trim(), avatar_url, req.user.id, ids);
  res.status(201).json({ group });
});

app.get("/api/groups/:groupId", requireUser, (req, res) => {
  const groupId = Number(req.params.groupId);
  if (!db.isGroupMember(groupId, req.user.id)) {
    return res.status(403).json({ error: "Not a group member." });
  }
  const group = db.getGroup(groupId);
  res.json({
    group: {
      ...group,
      members: group.members.map(publicUser)
    }
  });
});

app.post("/api/groups/:groupId/members", requireUser, (req, res) => {
  const groupId = Number(req.params.groupId);
  const userId = Number(req.body?.user_id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: "Invalid user_id." });
  if (!db.isGroupMember(groupId, req.user.id)) return res.status(403).json({ error: "Not a group member." });
  if (!db.getUserById(userId)) return res.status(404).json({ error: "User not found." });

  const group = db.addGroupMember(groupId, userId);
  if (!group) return res.status(404).json({ error: "Group not found." });
  res.json({ group });
});

app.post("/api/chats/:conversationId/messages", requireUser, (req, res) => {
  const conversationId = Number(req.params.conversationId);
  const { text } = req.body || {};
  if (!validateText(text)) return res.status(400).json({ error: "Message text is required." });
  if (!db.isConversationMember(conversationId, req.user.id)) {
    return res.status(403).json({ error: "Not a conversation member." });
  }

  const message = db.createMessage(conversationId, req.user.id, text.trim());
  const members = db.getConversationMemberIds(conversationId);
  for (const memberId of members) broadcastToUser(memberId, { type: "message", message });
  res.status(201).json({ message });
});

wss.on("connection", (ws, req) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = cookies[SESSION_COOKIE] ? getUserFromSession(cookies[SESSION_COOKIE]) : null;
  if (!user) {
    ws.close(1008, "Authentication required");
    return;
  }

  let sockets = socketsByUser.get(user.id);
  if (!sockets) {
    sockets = new Set();
    socketsByUser.set(user.id, sockets);
  }
  const wasOffline = sockets.size === 0;
  sockets.add(ws);
  if (wasOffline) broadcastPresence(user.id);

  sendJson(ws, { type: "ready", user: publicUser(db.getUserById(user.id)) });

  ws.on("message", raw => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return sendJson(ws, { type: "error", error: "Invalid JSON." });
    }

    if (event.type === "typing") {
      const conversationId = Number(event.conversation_id);
      if (!db.isConversationMember(conversationId, user.id)) return;
      for (const memberId of db.getConversationMemberIds(conversationId)) {
        if (memberId !== user.id) {
          broadcastToUser(memberId, {
            type: "typing",
            conversation_id: conversationId,
            user: publicUser(db.getUserById(user.id)),
            active: Boolean(event.active)
          });
        }
      }
    }
  });

  ws.on("close", () => {
    sockets.delete(ws);
    if (sockets.size === 0) {
      socketsByUser.delete(user.id);
      broadcastPresence(user.id);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Slarte server listening on port ${PORT}`);
});
