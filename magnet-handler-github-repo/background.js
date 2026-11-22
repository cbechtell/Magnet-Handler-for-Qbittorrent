// Magnet Handler for qBittorrent — background service worker.
// All talking to qBittorrent happens here so the CSRF header fix below applies.

export const DEFAULTS = {
  url: "http://localhost:8080",
  username: "admin",
  password: "",
  savepath: "",
  category: "",
  paused: false,
  sequential: false,
  firstLast: false,
  interceptMagnets: true,
  fetchTorrentFiles: true,
  notify: false,
};

const HEADER_RULE_ID = 1;
const CONTENT_SCRIPT_ID = "magnet-catcher";

async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  return { ...DEFAULTS, ...stored };
}

function baseUrl(s) {
  let u = (s.url || "").trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = "http://" + u;
  return u;
}

// qBittorrent rejects requests whose Origin/Referer don't match its own host
// ("CSRF protection"). Requests from an extension carry chrome-extension://…
// as the Origin, which is the #1 reason other extensions silently fail.
// This rule rewrites those headers for our own background requests only.
async function applyHeaderRule(base) {
  const origin = new URL(base).origin;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [HEADER_RULE_ID],
    addRules: [
      {
        id: HEADER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Origin", operation: "set", value: origin },
            { header: "Referer", operation: "set", value: base + "/" },
          ],
        },
        condition: {
          urlFilter: "|" + base + "/api/v2/",
          tabIds: [chrome.tabs.TAB_ID_NONE],
          resourceTypes: ["xmlhttprequest", "other"],
        },
      },
    ],
  });
}

class QbtError extends Error {}

async function rawFetch(url, init) {
  try {
    return await fetch(url, { credentials: "include", ...init });
  } catch (e) {
    throw new QbtError(
      "Can't reach qBittorrent at " + url.split("/api/")[0] +
      ". Is qBittorrent running with the Web UI enabled, and is the address right?"
    );
  }
}

async function login(s) {
  const base = baseUrl(s);
  const res = await rawFetch(base + "/api/v2/auth/login", {
    method: "POST",
    body: new URLSearchParams({ username: s.username, password: s.password }),
  });
  const text = (await res.text()).trim();
  if (res.status === 403)
    throw new QbtError("qBittorrent has temporarily banned this computer after too many failed logins. Wait a while or restart qBittorrent.");
  if (res.status === 401 || text === "Fails.")
    throw new QbtError("Login failed — check your username and password in the extension settings.");
  if (!res.ok) throw new QbtError(`Login failed (HTTP ${res.status}).`);
}

async function api(path, init = {}, allowRetry = true) {
  const s = await getSettings();
  const base = baseUrl(s);
  if (!base) throw new QbtError("Set your qBittorrent address in the extension settings first.");
  if (!(await chrome.permissions.contains({ origins: [new URL(base).origin + "/*"] })))
    throw new QbtError("Permission to contact qBittorrent hasn't been granted. Open settings and press Save.");
  await applyHeaderRule(base);
  const res = await rawFetch(base + "/api/v2/" + path, init);
  if ((res.status === 401 || res.status === 403) && allowRetry) {
    await login(s);
    return api(path, init, false);
  }
  if (res.status === 401 || res.status === 403)
    throw new QbtError("qBittorrent refused the request (HTTP " + res.status + ").");
  return res;
}

function filenameFrom(res, link) {
  const cd = res.headers.get("content-disposition") || "";
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  const last = new URL(link).pathname.split("/").pop();
  return last && last.endsWith(".torrent") ? decodeURIComponent(last) : "file.torrent";
}

// Normalise whatever the user gave us: magnet, http(s) link, or a bare info-hash.
function normaliseLink(text) {
  const t = (text || "").trim();
  const magnet = t.match(/magnet:\?[^\s"'<>]+/i);
  if (magnet) return magnet[0];
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-f0-9]{40}$/i.test(t) || /^[a-z2-7]{32}$/i.test(t)) return "magnet:?xt=urn:btih:" + t;
  return null;
}

async function addTorrent(input, overrides = {}) {
  const link = normaliseLink(input);
  if (!link) throw new QbtError("That doesn't look like a magnet link, torrent URL or info-hash.");
  const s = { ...(await getSettings()), ...overrides };
  const form = new FormData();
  let sentAsFile = false;

  // For .torrent links, download the file with the browser (so sites that need
  // you to be logged in work) and upload it. Fall back to giving qBittorrent the URL.
  if (!link.startsWith("magnet:") && s.fetchTorrentFiles) {
    try {
      const r = await fetch(link, { credentials: "include" });
      if (r.ok) {
        const buf = await r.arrayBuffer();
        const first = new Uint8Array(buf, 0, Math.min(1, buf.byteLength))[0];
        if (first === 0x64 /* 'd' = bencoded dict */ && buf.byteLength < 50 * 1024 * 1024) {
          form.append("torrents", new Blob([buf], { type: "application/x-bittorrent" }), filenameFrom(r, link));
          sentAsFile = true;
        }
      }
    } catch { /* fall back to URL */ }
  }
  if (!sentAsFile) form.append("urls", link);

  if (s.savepath) form.append("savepath", s.savepath);
  if (s.category) form.append("category", s.category);
  if (s.paused) {
    form.append("paused", "true");   // qBittorrent 4.x
    form.append("stopped", "true");  // qBittorrent 5.x
  }
  if (s.sequential) form.append("sequentialDownload", "true");
  if (s.firstLast) form.append("firstLastPiecePrio", "true");

  const res = await api("torrents/add", { method: "POST", body: form });
  const text = (await res.text()).trim();
  if (res.status === 415) throw new QbtError("qBittorrent says the torrent file is not valid.");
  if (!res.ok || text === "Fails.")
    throw new QbtError("qBittorrent didn't accept it — it may already be in your list, or the link is broken.");
  return { link, sentAsFile };
}

function shortName(link) {
  const dn = link.match(/[?&]dn=([^&]+)/i);
  if (dn) {
    try { return decodeURIComponent(dn[1].replace(/\+/g, " ")); } catch { return dn[1]; }
  }
  if (link.startsWith("magnet:")) return "Magnet link";
  try { return decodeURIComponent(new URL(link).pathname.split("/").pop()) || link; } catch { return link; }
}

async function feedback(ok, message) {
  chrome.action.setBadgeBackgroundColor({ color: ok ? "#2e9e44" : "#d93025" });
  chrome.action.setBadgeText({ text: ok ? "✓" : "!" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
  const s = await getSettings();
  if (s.notify || !ok) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: ok ? "Sent to qBittorrent" : "Couldn't send to qBittorrent",
      message,
    });
  }
}

// Injected into the web page: a small toast in the bottom-right corner.
// Lives in a shadow root so the site's own CSS can't mess with it.
function pageToast(ok, title, detail) {
  const ID = "send-to-qbittorrent-toast";
  document.getElementById(ID)?.remove();
  const host = document.createElement("div");
  host.id = ID;
  host.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  const color = ok ? "#2e9e44" : "#d93025";
  root.innerHTML = `
    <style>
      .t { display:flex; gap:10px; align-items:flex-start; max-width:340px; padding:12px 14px;
           background:#1f232b; color:#fff; border-left:4px solid ${color}; border-radius:8px;
           box-shadow:0 6px 24px rgba(0,0,0,.35); font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
           opacity:0; transform:translateY(10px); transition:opacity .2s, transform .2s; cursor:pointer; }
      .t.show { opacity:1; transform:none; }
      .i { flex:none; width:20px; height:20px; border-radius:50%; background:${color};
           display:grid; place-items:center; font-weight:700; font-size:13px; }
      b { display:block; }
      span.d { display:block; color:#c4cad4; font-size:12.5px; margin-top:2px; word-break:break-word; }
    </style>
    <div class="t"><div class="i">${ok ? "✓" : "!"}</div><div><b></b><span class="d"></span></div></div>`;
  root.querySelector("b").textContent = title;
  root.querySelector(".d").textContent = detail || "";
  const t = root.querySelector(".t");
  (document.body || document.documentElement).appendChild(host);
  requestAnimationFrame(() => t.classList.add("show"));
  const close = () => { t.classList.remove("show"); setTimeout(() => host.remove(), 250); };
  t.addEventListener("click", close);
  setTimeout(close, ok ? 3500 : 7000);
}

async function showToast(tabId, ok, detail) {
  if (tabId == null || tabId < 0) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: pageToast,
      args: [ok, ok ? "Sent to qBittorrent" : "Failed to send to qBittorrent", detail],
    });
  } catch { /* page doesn't allow scripts (e.g. chrome:// pages) — badge/notification still show */ }
}

async function sendWithFeedback(input, overrides, tabId) {
  try {
    const { link } = await addTorrent(input, overrides);
    await Promise.all([feedback(true, shortName(link)), showToast(tabId, true, shortName(link))]);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof QbtError ? e.message : "Unexpected error: " + e.message;
    await Promise.all([feedback(false, msg), showToast(tabId, false, msg)]);
    return { ok: false, error: msg };
  }
}

// ---------- Context menus ----------

async function buildMenus() {
  await chrome.contextMenus.removeAll();
  const contexts = ["link", "selection"];
  chrome.contextMenus.create({ id: "send", title: "Send to qBittorrent", contexts });
  chrome.contextMenus.create({ id: "send-paused", title: "Send to qBittorrent (paused)", contexts });

  let categories = [];
  try {
    const res = await api("torrents/categories", { method: "GET" });
    if (res.ok) categories = Object.keys(await res.json()).sort((a, b) => a.localeCompare(b));
  } catch { /* not configured / offline yet — fine */ }

  if (categories.length) {
    chrome.contextMenus.create({ id: "cat-parent", title: "Send to qBittorrent category", contexts });
    for (const c of categories)
      chrome.contextMenus.create({ id: "cat:" + c, parentId: "cat-parent", title: c, contexts });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const input = info.linkUrl || info.selectionText || "";
  const id = String(info.menuItemId);
  const tabId = tab?.id;
  if (id === "send") sendWithFeedback(input, {}, tabId);
  else if (id === "send-paused") sendWithFeedback(input, { paused: true }, tabId);
  else if (id.startsWith("cat:")) sendWithFeedback(input, { category: id.slice(4) }, tabId);
});

// ---------- Magnet click catcher ----------

async function syncContentScript() {
  const s = await getSettings();
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  const hasAll = await chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] });
  const want = s.interceptMagnets && hasAll;
  if (want && !registered.length) {
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      matches: ["http://*/*", "https://*/*"],
      js: ["content.js"],
      runAt: "document_start",
      allFrames: true,
    }]);
  } else if (!want && registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  }
}

// ---------- Messages from popup / options / content script ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg?.type) {
      case "add":
        // From a page click: toast in that tab. From the popup: it shows its own result.
        return sendWithFeedback(msg.url, {}, msg.fromPage ? sender.tab?.id : undefined);
      case "test": {
        try {
          const res = await api("app/version", { method: "GET" });
          if (!res.ok) throw new QbtError("Unexpected response (HTTP " + res.status + ").");
          const version = (await res.text()).trim();
          let speed = null;
          try {
            const t = await api("transfer/info", { method: "GET" });
            if (t.ok) speed = await t.json();
          } catch {}
          return { ok: true, version, speed };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      case "settingsChanged":
        await syncContentScript();
        await buildMenus();
        return { ok: true };
      case "webuiUrl":
        return { url: baseUrl(await getSettings()) };
    }
  })().then(reply, (e) => reply({ ok: false, error: e.message }));
  return true; // async reply
});

chrome.runtime.onInstalled.addListener((details) => {
  buildMenus();
  syncContentScript();
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => {
  buildMenus();
  syncContentScript();
});
