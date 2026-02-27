// ─── SERVICE WORKER (BACKGROUND) ─────────────────────────────────────────────
// Mantém WebSocket com o MCP server e retransmite comandos para o content script.

const WS_URL = "ws://localhost:3847/whatsapp-bridge";
const PING_INTERVAL = 20000;

// Exponential backoff para reconexão
const BACKOFF_BASE = 1000;   // 1s inicial
const BACKOFF_MAX = 30000;   // 30s máximo
let reconnectAttempt = 0;

let ws = null;
let contentPort = null;
let pingTimer = null;
let reconnectTimer = null;
let isConnecting = false;

// ─── KEEP-ALIVE (Manifest V3) ──────────────────────────────────────────────
// chrome.alarms é mais confiável que setInterval em Manifest V3
// Service workers morrem após 30s de inatividade — alarm a cada ~24s mantém vivo

chrome.alarms.create("keep-alive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keep-alive") {
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
    reconnectAttempt = 0; // Reset backoff on success
    clearTimeout(reconnectTimer);
    updateStatus("ws_connected", true);

    // Keep-alive ping
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

      // Ignorar respostas de identity (probe do server)
      if (msg.type === "identity") return;

      // Retransmitir comando do MCP server para o content script
      if (contentPort) {
        contentPort.postMessage(msg);
      } else {
        // Content script não conectado — responder erro
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
  // Exponential backoff com jitter
  const jitter = Math.random() * 500;
  const delay = Math.min(BACKOFF_BASE * Math.pow(2, reconnectAttempt) + jitter, BACKOFF_MAX);
  reconnectAttempt++;
  console.log(`[SW] Reconexão em ${Math.round(delay / 1000)}s (tentativa ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => connectWebSocket(), delay);
}

// ─── CONTENT SCRIPT CONNECTION ───────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "whatsapp-mcp-bridge") return;

  console.log("[SW] Content script conectado");
  contentPort = port;
  updateStatus("wa_connected", true);

  port.onMessage.addListener((msg) => {
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
    reconnectAttempt = 0; // Reset backoff on manual reconnect
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
