// ─── CONTENT SCRIPT ──────────────────────────────────────────────────────────
// Ponte entre o injected.js (mundo MAIN) e o service worker (background).

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

// ─── CONEXÃO COM SERVICE WORKER ──────────────────────────────────────────────
// Reconecta automaticamente se o service worker morrer (Manifest V3 mata após 30s inativo)

let port = null;

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: "whatsapp-mcp-bridge" });

    // Mensagens do service worker → injected.js (mundo MAIN)
    port.onMessage.addListener((msg) => {
      window.postMessage({
        source: "whatsapp-mcp-content",
        payload: msg,
      }, "*");
    });

    // Reconectar se o service worker desconectar
    port.onDisconnect.addListener(() => {
      console.warn("[CS] Service worker desconectou — reconectando em 1s...");
      port = null;
      setTimeout(connectPort, 1000);
    });
  } catch (err) {
    console.error("[CS] Erro ao conectar port:", err);
    setTimeout(connectPort, 2000);
  }
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

  // Retransmitir para o service worker (se conectado)
  if (port) {
    try {
      port.postMessage(event.data.payload);
    } catch (err) {
      console.warn("[CS] Erro ao enviar para service worker:", err.message);
    }
  }
});

// ─── INICIAR ─────────────────────────────────────────────────────────────────

connectPort();
init();
