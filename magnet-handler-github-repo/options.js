const DEFAULTS = {
  url: "http://localhost:8080", username: "admin", password: "", savepath: "", category: "",
  paused: false, sequential: false, firstLast: false,
  interceptMagnets: true, fetchTorrentFiles: true, notify: false,
};
const ALL_SITES = ["http://*/*", "https://*/*"];
const $ = (id) => document.getElementById(id);
const status = $("status");

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = "status " + kind;
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const el = $(k);
    if (typeof v === "boolean") el.checked = !!s[k];
    else el.value = s[k] ?? "";
  }
}

function read() {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const el = $(k);
    out[k] = typeof v === "boolean" ? el.checked : el.value.trim();
  }
  if (out.url && !/^https?:\/\//i.test(out.url)) out.url = "http://" + out.url;
  out.url = out.url.replace(/\/+$/, "");
  return out;
}

async function save() {
  const s = read();
  let origin;
  try { origin = new URL(s.url).origin + "/*"; }
  catch { setStatus("That Web UI address isn't valid.", "err"); return false; }

  // Must be requested straight from the click (no await before it).
  const wantAll = s.interceptMagnets || s.fetchTorrentFiles;
  const granted = await chrome.permissions.request({ origins: wantAll ? ALL_SITES : [origin] });
  if (!granted) {
    setStatus("Chrome permission was declined — the extension can't reach qBittorrent without it.", "err");
    return false;
  }
  await chrome.storage.local.set(s);
  await chrome.runtime.sendMessage({ type: "settingsChanged" });
  return true;
}

async function test() {
  setStatus("Connecting…");
  const r = await chrome.runtime.sendMessage({ type: "test" });
  if (r.ok) setStatus(`Connected — qBittorrent ${r.version}`, "ok");
  else setStatus(r.error, "err");
}

$("save").addEventListener("click", async () => {
  $("save").disabled = true;
  try {
    if (await save()) {
      setStatus("Saved. Testing…", "ok");
      await test();
    }
  } finally {
    $("save").disabled = false;
  }
});

$("test").addEventListener("click", async () => {
  if (await save()) await test();
});

load();
