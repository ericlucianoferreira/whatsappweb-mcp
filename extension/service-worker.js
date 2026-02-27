// ─── SERVICE WORKER (BACKGROUND) ─────────────────────────────────────────────
// Mantém WebSocket com o MCP server e retransmite comandos para o content script.

const WS_URL = "ws://localhost:3847/whatsapp-bridge";
const RECONNECT_DELAY = 5000;
// Manifest V3: service workers morrem após 30s de inatividade.
// Ping a cada 20s mantém o worker vivo enquanto o WebSocket estiver ativo.
const PING_INTERVAL = 20000;

let ws = null;
let contentPort = null;
let pingTimer = null;
let reconnectTimer = null;
let isConnecting = false;

// Manter o service worker vivo enquanto houver conexão ativa
// chrome.alarms é mais confiável que setInterval em Manifest V3
chrome.alarms.create("keep-alive", { periodInMinutes: 0.4 }); // ~24s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keep-alive") {
    // O simples fato de receber o alarm já reativa o service worker
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
  }
});

// ─── WEBSOCKET ───────────────────────────────────────────────────────────────

function connectWebSocket() {
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  isConnecting = true;

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.error("[SW] Erro ao criar WebSocket:", err);
    isConnecting = false;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[SW] WebSocket conectado ao MCP server");
    isConnecting = false;
    clearTimeout(reconnectTimer);
    updateStatus("ws_connected", true);

    // Keep-alive
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      // Retransmitir comando do MCP server para o content script
      if (contentPort) {
        contentPort.postMessage(msg);
      } else {
        // Extensão não conectada ao WhatsApp Web
        if (msg.id) {
          ws.send(JSON.stringify({
            id: msg.id,
            error: "WhatsApp Web não está aberto ou a extensão não foi carregada na página."
          }));
        }
      }
    } catch (err) {
      console.error("[SW] Erro ao processar mensagem:", err);
    }
  };

  ws.onclose = () => {
    console.log("[SW] WebSocket desconectado");
    isConnecting = false;
    clearInterval(pingTimer);
    updateStatus("ws_connected", false);
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error("[SW] Erro WebSocket:", err);
    isConnecting = false;
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log("[SW] Tentando reconectar...");
    connectWebSocket();
  }, RECONNECT_DELAY);
}

// ─── CONTENT SCRIPT CONNECTION ───────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "whatsapp-mcp-bridge") return;

  console.log("[SW] Content script conectado");
  contentPort = port;
  updateStatus("wa_connected", true);

  port.onMessage.addListener((msg) => {
    // Retransmitir resposta do content script para o MCP server via WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  });

  port.onDisconnect.addListener(() => {
    console.log("[SW] Content script desconectado");
    contentPort = null;
    updateStatus("wa_connected", false);
  });
});

// ─── STATUS ──────────────────────────────────────────────────────────────────

async function updateStatus(key, value) {
  try {
    const data = await chrome.storage.local.get("status");
    const status = data.status || {};
    status[key] = value;
    status.lastUpdate = Date.now();
    await chrome.storage.local.set({ status });
  } catch (err) {
    console.error("[SW] Erro ao salvar status:", err);
  }
}

// ─── MENSAGENS DO POPUP ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "reconnect") {
    if (ws) {
      ws.close();
    }
    setTimeout(connectWebSocket, 500);
    sendResponse({ ok: true });
  }
  return true;
});

// ─── INICIAR ─────────────────────────────────────────────────────────────────

connectWebSocket();
