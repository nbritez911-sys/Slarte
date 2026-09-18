const state = {
  me: null,
  conversations: [],
  active: null,
  messages: [],
  ws: null,
  typingUsers: new Map(),
  searchTimer: null
};

const $ = id => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "include", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function initials(user) {
  return (user?.name || user?.username || "S").trim().slice(0, 1).toUpperCase();
}

function setAvatar(element, user) {
  element.textContent = "";
  if (user?.avatar_url) element.style.backgroundImage = `url("${CSS.escape(user.avatar_url)}")`;
  else { element.style.backgroundImage = ""; element.textContent = initials(user); }
}

function switchAuthTab(tab) {
  document.querySelectorAll("[data-auth-tab]").forEach(button => button.classList.toggle("active", button.dataset.authTab === tab));
  $("loginForm").classList.toggle("hidden", tab !== "login");
  $("registerForm").classList.toggle("hidden", tab !== "register");
  $("authError").textContent = "";
}

document.querySelectorAll("[data-auth-tab]").forEach(button => button.addEventListener("click", () => switchAuthTab(button.dataset.authTab)));

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const data = await api("/api/auth/login", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(Object.fromEntries(form)) });
    await enterApp(data.user);
  } catch (error) { $("authError").textContent = error.message; }
});

$("registerForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form);
  try {
    const data = await api("/api/auth/register", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload) });
    await enterApp(data.user);
  } catch (error) { $("authError").textContent = error.message; }
});

async function enterApp(user) {
  state.me = user;
  $("authView").classList.add("hidden");
  $("chatView").classList.remove("hidden");
  $("meName").textContent = user.name;
  $("meUsername").textContent = `@${user.username}`;
  setAvatar($("meAvatar"), user);
  connectSocket();
  await loadConversations();
}

async function bootstrap() {
  try {
    const data = await api("/api/me");
    await enterApp(data.user);
  } catch (_) {}
}
bootstrap();

async function loadConversations() {
  const data = await api("/api/chats");
  state.conversations = data.conversations;
  renderConversations();
}

function renderConversations() {
  const list = $("conversationList");
  list.innerHTML = "";
  for (const conversation of state.conversations) {
    const button = document.createElement("button");
    button.className = `conversation-item${state.active?.id === conversation.id ? " active" : ""}`;
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("strong");
    title.textContent = conversation.type === "group" ? (conversation.title || "Group") : "Private conversation";
    const preview = document.createElement("span");
    preview.textContent = conversation.last_message || "No messages yet";
    meta.append(title, preview);
    avatar.textContent = conversation.type === "group" ? "G" : "P";
    button.append(avatar, meta);
    button.addEventListener("click", () => openConversation(conversation));
    list.append(button);
  }
}

async function openConversation(conversation) {
  state.active = conversation;
  $("emptyConversation").classList.add("hidden");
  $("activeConversation").classList.remove("hidden");
  $("groupInfoButton").classList.toggle("hidden", conversation.type !== "group");
  $("groupPanel").classList.add("hidden");
  $("messageList").innerHTML = "";
  $("typingIndicator").textContent = "";
  renderConversations();

  if (conversation.type === "group") {
    $("conversationName").textContent = conversation.title || "Group";
    $("conversationStatus").textContent = "Group conversation";
    $("conversationStatus").classList.remove("online");
  } else {
    $("conversationName").textContent = "Private conversation";
    $("conversationStatus").textContent = "Loading...";
  }

  const data = await api(`/api/chats/${conversation.id}/messages?limit=100`);
  state.messages = data.messages;
  renderMessages();

  if (conversation.type === "private") {
    const search = await api(`/api/users/search?q=${encodeURIComponent("")}`).catch(() => null);
    void search;
  }
}

function renderMessages() {
  const list = $("messageList");
  list.innerHTML = "";
  for (const message of state.messages) {
    const bubble = document.createElement("div");
    bubble.className = `message${message.sender_id === state.me.id ? " mine" : ""}`;
    bubble.textContent = message.text;
    const time = document.createElement("div");
    time.className = "message-time";
    time.textContent = new Date(message.created_at.replace(" ", "T") + "Z").toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
    bubble.appendChild(time);
    list.appendChild(bubble);
  }
  list.scrollTop = list.scrollHeight;
}

function connectSocket() {
  if (state.ws) state.ws.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.ws = new WebSocket(`${protocol}//${location.host}/ws`);
  state.ws.addEventListener("message", event => {
    const payload = JSON.parse(event.data);
    if (payload.type === "message") {
      if (state.active?.id === payload.message.conversation_id) {
        state.messages.push(payload.message);
        renderMessages();
      }
      loadConversations().catch(() => {});
    }
    if (payload.type === "typing") {
      if (state.active?.id !== payload.conversation_id) return;
      if (payload.active) state.typingUsers.set(payload.user.id, payload.user.name);
      else state.typingUsers.delete(payload.user.id);
      renderTyping();
    }
    if (payload.type === "presence") {
      updateConversationPresence(payload.user);
    }
  });
}

function renderTyping() {
  const names = [...state.typingUsers.values()];
  $("typingIndicator").textContent = names.length ? `${names.join(", ")} ${names.length === 1 ? "is" : "are"} typing...` : "";
}

function updateConversationPresence(user) {
  if (!state.active || state.active.type !== "private") return;
  $("conversationStatus").textContent = user.online ? "Online" : "Offline";
  $("conversationStatus").classList.toggle("online", user.online);
}

$("messageForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state.active) return;
  const input = $("messageInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "";
  try {
    await api(`/api/chats/${state.active.id}/messages`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ text })
    });
  } catch (error) {
    input.value = text;
    $("typingIndicator").textContent = error.message;
  }
});

let typingTimeout;
$("messageInput").addEventListener("input", () => {
  if (!state.active || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({type:"typing", conversation_id:state.active.id, active:true}));
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    if (state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({type:"typing", conversation_id:state.active.id, active:false}));
  }, 900);
});

$("messageInput").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("messageForm").requestSubmit();
  }
});

$("userSearch").addEventListener("input", event => {
  clearTimeout(state.searchTimer);
  const query = event.target.value.trim();
  if (!query) { $("searchResults").classList.add("hidden"); return; }
  state.searchTimer = setTimeout(() => searchUsers(query), 180);
});

async function searchUsers(query) {
  try {
    const data = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
    const box = $("searchResults");
    box.innerHTML = "";
    for (const user of data.users) {
      const button = document.createElement("button");
      button.className = "search-user";
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      setAvatar(avatar, user);
      const info = document.createElement("div");
      info.innerHTML = `<strong></strong><small></small>`;
      info.querySelector("strong").textContent = user.name;
      info.querySelector("small").textContent = `@${user.username}`;
      button.append(avatar, info);
      button.addEventListener("click", async () => {
        const data = await api("/api/chats/private", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({user_id:user.id})});
        $("searchResults").classList.add("hidden");
        $("userSearch").value = "";
        await loadConversations();
        const conversation = state.conversations.find(c => c.id === data.conversation.id) || data.conversation;
        await openConversation(conversation);
      });
      box.appendChild(button);
    }
    box.classList.toggle("hidden", data.users.length === 0);
  } catch (_) {}
}

$("newChatButton").addEventListener("click", () => $("userSearch").focus());

$("newGroupButton").addEventListener("click", async () => {
  const name = prompt("Group name");
  if (!name?.trim()) return;
  const usernames = prompt("Enter usernames separated by commas");
  const memberIds = [];
  for (const raw of (usernames || "").split(",")) {
    const username = raw.trim().replace(/^@/,"");
    if (!username) continue;
    const data = await api(`/api/users/search?q=${encodeURIComponent(username)}`).catch(() => ({users:[]}));
    const exact = data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (exact) memberIds.push(exact.id);
  }
  const data = await api("/api/groups", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.trim(),member_ids:memberIds})});
  await loadConversations();
  const conversation = state.conversations.find(c => c.id === data.group.id) || data.group;
  await openConversation(conversation);
});

$("groupInfoButton").addEventListener("click", async () => {
  if (!state.active || state.active.type !== "group") return;
  const data = await api(`/api/groups/${state.active.id}`);
  const box = $("groupMembers");
  box.innerHTML = "";
  for (const user of data.group.members) {
    const row = document.createElement("div");
    row.className = "member";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    setAvatar(avatar, user);
    const info = document.createElement("div");
    info.className = "member-info";
    const name = document.createElement("strong");
    name.textContent = user.name;
    const username = document.createElement("span");
    username.textContent = `@${user.username}${user.online ? " · Online" : ""}`;
    info.append(name, username);
    row.append(avatar, info);
    box.append(row);
  }
  $("groupPanel").classList.remove("hidden");
});

$("closeGroupPanel").addEventListener("click", () => $("groupPanel").classList.add("hidden"));

$("logoutButton").addEventListener("click", async () => {
  await api("/api/auth/logout", {method:"POST"}).catch(() => {});
  location.reload();
});
