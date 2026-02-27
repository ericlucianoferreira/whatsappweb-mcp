// ─── POPUP ────────────────────────────────────────────────────────────────────

const wsDot = document.getElementById("ws-dot");
const wsText = document.getElementById("ws-text");
const waDot = document.getElementById("wa-dot");
const waText = document.getElementById("wa-text");
const reconnectBtn = document.getElementById("reconnect-btn");

function updateUI(status) {
  if (status.ws_connected) {
    wsDot.className = "status-dot dot-green";
    wsText.textContent = "Conectado";
  } else {
    wsDot.className = "status-dot dot-red";
    wsText.textContent = "Desconectado";
  }

  if (status.wa_connected) {
    waDot.className = "status-dot dot-green";
    waText.textContent = "Conectado";
  } else {
    waDot.className = "status-dot dot-red";
    waText.textContent = "Desconectado";
  }
}

function loadStatus() {
  chrome.storage.local.get("status", (data) => {
    updateUI(data.status || {});
  });
}

// Atualizar a cada 2s enquanto popup estiver aberto
loadStatus();
setInterval(loadStatus, 2000);

// Botão reconectar: envia mensagem para o service worker recarregar
reconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "reconnect" }, () => {
    wsText.textContent = "Reconectando...";
    wsDot.className = "status-dot dot-yellow";
    setTimeout(loadStatus, 3000);
  });
});
