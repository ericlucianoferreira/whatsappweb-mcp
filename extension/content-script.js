// ─── CONTENT SCRIPT ──────────────────────────────────────────────────────────
// Ponte entre o injected.js (mundo MAIN) e o service worker (background).

// Conectar ao service worker
const port = chrome.runtime.connect({ name: "whatsapp-mcp-bridge" });

// ─── INJETAR SCRIPTS NO MUNDO MAIN ──────────────────────────────────────────

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL(src);
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = (err) => {
      script.remove();
      reject(err);
    };
    (document.head || document.documentElement).appendChild(script);
  });
}

async function init() {
  try {
    // Injetar WA-JS primeiro, depois o script de comandos
    await injectScript("wppconnect-wa.js");
    await injectScript("injected.js");
    console.log("[CS] Scripts injetados com sucesso");
  } catch (err) {
    console.error("[CS] Erro ao injetar scripts:", err);
  }
}

// ─── PONTE: WINDOW ↔ SERVICE WORKER ─────────────────────────────────────────

// Mensagens do injected.js (mundo MAIN) → service worker
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== "whatsapp-mcp-injected") return;

  // Retransmitir para o service worker
  port.postMessage(event.data.payload);
});

// Mensagens do service worker → injected.js (mundo MAIN)
port.onMessage.addListener((msg) => {
  window.postMessage({
    source: "whatsapp-mcp-content",
    payload: msg,
  }, "*");
});

// ─── INICIAR ─────────────────────────────────────────────────────────────────

init();
