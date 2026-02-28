// ─── OFFSCREEN DOCUMENT — KEEPALIVE ──────────────────────────────────────────
// Roda em background permanente (não é service worker — não é suspenso).
// Envia mensagem keepalive a cada 25s para manter o service worker acordado,
// evitando que o Chrome o suspenda quando a janela do Edge é minimizada.

const KEEPALIVE_INTERVAL = 25000;

function sendKeepalive() {
  chrome.runtime.sendMessage({ type: "keepalive" }).catch(() => {
    // Service worker pode estar reiniciando — ignorar erro
  });
}

setInterval(sendKeepalive, KEEPALIVE_INTERVAL);
