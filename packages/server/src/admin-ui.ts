// The script below uses string concatenation instead of template literals
// deliberately — this whole file is itself a TS template string, and nested
// backticks/${} would collide with the outer one.
export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Admin — Multiplayer Markdown</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #8888; padding-bottom: .25rem; }
  table { width: 100%; border-collapse: collapse; margin: .5rem 0; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #8884; font-size: .9rem; }
  form.inline { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: .5rem 0 1rem; }
  input, select { padding: .3rem .4rem; }
  button { padding: .35rem .7rem; cursor: pointer; }
  button.danger { color: #b00020; }
  .badge { background: #2563eb; color: white; border-radius: 4px; padding: 0 .4rem; font-size: .75rem; }
  .error { color: #b00020; font-weight: 600; }
  .hidden { display: none; }
  #room-members-panel { border: 1px solid #8888; padding: 1rem; margin-top: .5rem; border-radius: 6px; }
</style>
</head>
<body>

<div id="login-view">
  <h1>Admin sign in</h1>
  <p id="login-error" class="error hidden"></p>
  <form id="login-form" class="inline">
    <input type="text" id="login-username" placeholder="username" autocomplete="username" required>
    <input type="password" id="login-password" placeholder="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</div>

<div id="dashboard-view" class="hidden">
  <h1>Admin — <span id="whoami"></span> <button id="logout-btn">Log out</button></h1>
  <p id="dashboard-error" class="error hidden"></p>

  <h2>Users</h2>
  <table id="users-table">
    <thead><tr><th>Username</th><th>Admin</th><th>Created</th><th></th></tr></thead>
    <tbody></tbody>
  </table>
  <form id="add-user-form" class="inline">
    <input type="text" id="new-username" placeholder="username" required>
    <input type="password" id="new-password" placeholder="password" required>
    <label><input type="checkbox" id="new-is-admin"> admin</label>
    <button type="submit">Add user</button>
  </form>

  <h2>Rooms</h2>
  <table id="rooms-table">
    <thead><tr><th>Room ID</th><th>Label</th><th>Created</th><th></th></tr></thead>
    <tbody></tbody>
  </table>
  <form id="add-room-form" class="inline">
    <input type="text" id="new-room-id" placeholder="room id" required>
    <input type="text" id="new-room-label" placeholder="label (optional)">
    <button type="submit">Create room</button>
  </form>

  <div id="room-members-panel" class="hidden">
    <h3>Members of <span id="room-members-room-id"></span></h3>
    <table id="room-members-table">
      <thead><tr><th>Username</th><th>Role</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
    <form id="grant-form" class="inline">
      <input type="text" id="grant-username" placeholder="username" required>
      <select id="grant-role">
        <option value="viewer">viewer</option>
        <option value="editor">editor</option>
      </select>
      <button type="submit">Grant access</button>
    </form>
    <button id="close-members-btn">Close</button>
  </div>
</div>

<script>
(function () {
  var TOKEN_KEY = "mm_admin_token";
  var USERNAME_KEY = "mm_admin_username";

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setSession(token, username) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USERNAME_KEY, username);
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
  }

  function authFetch(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    headers["Authorization"] = "Bearer " + getToken();
    if (opts.body) headers["Content-Type"] = "application/json";
    opts.headers = headers;
    return fetch(path, opts);
  }

  function showError(el, message) { el.textContent = message; el.classList.remove("hidden"); }
  function hideError(el) { el.textContent = ""; el.classList.add("hidden"); }
  function showLoginView() {
    document.getElementById("login-view").classList.remove("hidden");
    document.getElementById("dashboard-view").classList.add("hidden");
  }
  function showDashboardView() {
    document.getElementById("login-view").classList.add("hidden");
    document.getElementById("dashboard-view").classList.remove("hidden");
  }
  function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function cell(text) { var td = document.createElement("td"); td.textContent = text; return td; }

  // ---- Users ----
  function renderUsers(users) {
    var tbody = document.querySelector("#users-table tbody");
    clearChildren(tbody);
    users.forEach(function (u) {
      var tr = document.createElement("tr");
      tr.appendChild(cell(u.username));
      var adminCell = document.createElement("td");
      if (u.isAdmin) {
        var badge = document.createElement("span");
        badge.className = "badge"; badge.textContent = "admin";
        adminCell.appendChild(badge);
      }
      tr.appendChild(adminCell);
      tr.appendChild(cell(u.createdAt));
      var actionsCell = document.createElement("td");
      var revokeBtn = document.createElement("button");
      revokeBtn.textContent = "Revoke sessions";
      revokeBtn.addEventListener("click", function () { revokeUser(u.username); });
      var deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete"; deleteBtn.className = "danger";
      deleteBtn.addEventListener("click", function () { deleteUser(u.username); });
      actionsCell.appendChild(revokeBtn); actionsCell.appendChild(deleteBtn);
      tr.appendChild(actionsCell);
      tbody.appendChild(tr);
    });
  }

  function loadUsers() {
    return authFetch("/api/admin/users").then(function (res) {
      if (res.status === 403) throw new Error("FORBIDDEN");
      if (!res.ok) throw new Error("Failed to load users");
      return res.json();
    }).then(function (data) { renderUsers(data.users); });
  }

  function revokeUser(username) {
    authFetch("/api/admin/users/" + encodeURIComponent(username) + "/revoke", { method: "POST" })
      .then(function (res) { if (!res.ok) throw new Error("Failed to revoke sessions"); return loadUsers(); })
      .catch(function (err) { showError(document.getElementById("dashboard-error"), err.message); });
  }

  function deleteUser(username) {
    if (!confirm("Delete user " + username + "? This cannot be undone.")) return;
    authFetch("/api/admin/users/" + encodeURIComponent(username), { method: "DELETE" })
      .then(function (res) { if (!res.ok) throw new Error("Failed to delete user"); return loadUsers(); })
      .catch(function (err) { showError(document.getElementById("dashboard-error"), err.message); });
  }

  document.getElementById("add-user-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var username = document.getElementById("new-username").value;
    var password = document.getElementById("new-password").value;
    var isAdmin = document.getElementById("new-is-admin").checked;
    authFetch("/api/admin/users", { method: "POST", body: JSON.stringify({ username: username, password: password, isAdmin: isAdmin }) })
      .then(function (res) { return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "Failed to add user");
        document.getElementById("add-user-form").reset();
        return loadUsers();
      }); })
      .catch(function (err) { showError(document.getElementById("dashboard-error"), err.message); });
  });

  // ---- Rooms ----
  function renderRooms(rooms) {
    var tbody = document.querySelector("#rooms-table tbody");
    clearChildren(tbody);
    rooms.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.appendChild(cell(r.id)); tr.appendChild(cell(r.label)); tr.appendChild(cell(r.created_at));
      var actionsCell = document.createElement("td");
      var manageBtn = document.createElement("button");
      manageBtn.textContent = "Manage members";
      manageBtn.addEventListener("click", function () { openRoomMembers(r.id); });
      actionsCell.appendChild(manageBtn);
      tr.appendChild(actionsCell);
      tbody.appendChild(tr);
    });
  }

  function loadRooms() {
    return authFetch("/api/admin/rooms").then(function (res) {
      if (res.status === 403) throw new Error("FORBIDDEN");
      if (!res.ok) throw new Error("Failed to load rooms");
      return res.json();
    }).then(function (data) { renderRooms(data.rooms); });
  }

  document.getElementById("add-room-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var roomId = document.getElementById("new-room-id").value;
    var label = document.getElementById("new-room-label").value;
    authFetch("/api/admin/rooms", { method: "POST", body: JSON.stringify({ roomId: roomId, label: label }) })
      .then(function (res) { return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "Failed to create room");
        document.getElementById("add-room-form").reset();
        return loadRooms();
      }); })
      .catch(function (err) { showError(document.getElementById("dashboard-error"), err.message); });
  });

  // ---- Room members ----
  var currentRoomId = null;

  function openRoomMembers(roomId) {
    currentRoomId = roomId;
    document.getElementById("room-members-room-id").textContent = roomId;
    document.getElementById("room-members-panel").classList.remove("hidden");
    loadRoomMembers();
  }

  function loadRoomMembers() {
    authFetch("/api/admin/rooms/" + encodeURIComponent(currentRoomId) + "/members")
      .then(function (res) { if (!res.ok) throw new Error("Failed to load members"); return res.json(); })
      .then(function (data) { renderRoomMembers(data.members); })
      .catch(function (err) { showError(document.getElementById("dashboard-error"), err.message); });
  }

  function renderRoomMembers(members) {
    var tbody = document.querySelector("#room-members-table tbody");
    clearChildren(tbody);
    members.forEach(function (m) {
      var tr = document.createElement("tr");
      tr.appendChild(cell(m.username)); tr.appendChild(cell(m.role));
      var actionsCell = document.createElement("td");
      var revokeBtn = document.createElement("button");
      revokeBtn.textContent = "Revoke access"; revokeBtn.className = "danger";
      revokeBtn.addEventListener("click", function () { revokeMember(m.username); });
      actionsCell.appendChild(revokeBtn);
      tr.appendChild(actionsCell);
      tbody.appendChild(tr);
    });
  }

  function revokeMember(username) {
    authFetch("/api/admin/rooms/" + encodeURIComponent(currentRoomId) + "/members/" + encodeURIComponent(username), { method: "DELETE" })
      .then(function (res) { if (!res.ok) throw new Error("Failed to revoke member access"); return loadRoomMembers(); })
      .catch(function (err) { showError(document.getElementById("dashboard-error"), err.message); });
  }

  document.getElementById("grant-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var username = document.getElementById("grant-username").value;
    var role = document.getElementById("grant-role").value;
    authFetch("/api/admin/rooms/" + encodeURIComponent(currentRoomId) + "/members", { method: "POST", body: JSON.stringify({ username: username, role: role }) })
      .then(function (res) { return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "Failed to grant access");
        document.getElementById("grant-form").reset();
        return loadRoomMembers();
      }); })
      .catch(function (err) { showError(document.getElementById("dashboard-error"), err.message); });
  });

  document.getElementById("close-members-btn").addEventListener("click", function () {
    currentRoomId = null;
    document.getElementById("room-members-panel").classList.add("hidden");
  });

  // ---- Login / dashboard bootstrap ----
  document.getElementById("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var username = document.getElementById("login-username").value;
    var password = document.getElementById("login-password").value;
    hideError(document.getElementById("login-error"));
    fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: username, password: password }) })
      .then(function (res) { return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || "Login failed");
        setSession(data.token, data.username);
        loadDashboard();
      }); })
      .catch(function (err) { showError(document.getElementById("login-error"), err.message); });
  });

  document.getElementById("logout-btn").addEventListener("click", function () {
    clearSession();
    showLoginView();
  });

  function loadDashboard() {
    hideError(document.getElementById("dashboard-error"));
    document.getElementById("whoami").textContent = localStorage.getItem(USERNAME_KEY) || "";
    Promise.all([loadUsers(), loadRooms()]).then(function () {
      showDashboardView();
    }).catch(function (err) {
      if (err.message === "FORBIDDEN") {
        showDashboardView();
        showError(document.getElementById("dashboard-error"), "This account is signed in but is not an admin. Ask an existing admin to grant admin access.");
      } else {
        clearSession();
        showLoginView();
        showError(document.getElementById("login-error"), "Session expired or invalid — please sign in again.");
      }
    });
  }

  if (getToken()) { loadDashboard(); } else { showLoginView(); }
})();
</script>
</body>
</html>
`;
