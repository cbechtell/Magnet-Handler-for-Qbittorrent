const $ = (id) => document.getElementById(id);

function fmtSpeed(b) {
  if (b < 1024) return b + " B/s";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB/s";
  return (b / 1048576).toFixed(1) + " MB/s";
}

async function check() {
  const r = await chrome.runtime.sendMessage({ type: "test" });
  const conn = $("conn");
  if (r.ok) {
    conn.textContent = "● Connected to qBittorrent " + r.version;
    conn.className = "status ok";
    if (r.speed) $("speeds").textContent =
      `↓ ${fmtSpeed(r.speed.dl_info_speed)}   ↑ ${fmtSpeed(r.speed.up_info_speed)}`;
  } else {
    conn.textContent = "● " + r.error;
    conn.className = "status err";
  }
}

$("add").addEventListener("click", async () => {
  const url = $("link").value.trim();
  if (!url) return;
  $("add").disabled = true;
  $("result").textContent = "Sending…";
  $("result").className = "status";
  const r = await chrome.runtime.sendMessage({ type: "add", url });
  $("add").disabled = false;
  if (r.ok) {
    $("result").textContent = "Added ✓";
    $("result").className = "status ok";
    $("link").value = "";
  } else {
    $("result").textContent = r.error;
    $("result").className = "status err";
  }
});

$("webui").addEventListener("click", async () => {
  const { url } = await chrome.runtime.sendMessage({ type: "webuiUrl" });
  if (url) chrome.tabs.create({ url });
});
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

check();
