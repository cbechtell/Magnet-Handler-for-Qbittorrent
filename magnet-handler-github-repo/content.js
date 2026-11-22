// Catches normal left-clicks on magnet: links and sends them to qBittorrent
// instead of letting the OS open a desktop app.
document.addEventListener(
  "click",
  (e) => {
    if (e.button !== 0 || e.defaultPrevented) return;
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || !/^magnet:/i.test(a.getAttribute("href") || "")) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      chrome.runtime.sendMessage({ type: "add", url: a.href, fromPage: true });
    } catch {
      // Extension was reloaded; let the browser handle the link normally.
      location.href = a.href;
    }
  },
  true
);
