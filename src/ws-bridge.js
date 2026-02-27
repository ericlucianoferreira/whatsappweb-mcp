// ─── WEBSOCKET BRIDGE ────────────────────────────────────────────────────────
// Gerencia a conexão WebSocket entre o MCP server e a extensão Chrome/Edge.

import { WebSocketServer } from "ws";
import { WS_PORT, WS_PATH, PING_INTERVAL, COMMAND_TIMEOUT } from "./config.js";

let wss = null;
let extensionSocket = null;
let pendingRequests = new Map(); // id → { resolve, reject, timer }
let requestId = 0;
let pingTimer = null;

/**
 * Inicia o WebSocket server.
 */
export function startServer() {
  wss = new WebSocketServer({ port: WS_PORT, path: WS_PATH });

  wss.on("connection", (ws) => {
    console.error(`[WS Bridge] Extensão conectada`);
    extensionSocket = ws;

    // Keep-alive ping
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    }, PING_INTERVAL);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(msg);
      } catch (err) {
        console.error(`[WS Bridge] Erro ao parsear mensagem: ${err.message}`);
      }
    });

    ws.on("close", () => {
      console.error(`[WS Bridge] Extensão desconectada`);
      extensionSocket = null;
      clearInterval(pingTimer);
      // Rejeitar todos os requests pendentes
      for (const [id, req] of pendingRequests) {
        clearTimeout(req.timer);
        req.reject(new Error("Extensão desconectou durante a operação"));
      }
      pendingRequests.clear();
    });

    ws.on("error", (err) => {
      console.error(`[WS Bridge] Erro WebSocket: ${err.message}`);
    });
  });

  wss.on("error", (err) => {
    console.error(`[WS Bridge] Erro no servidor: ${err.message}`);
  });

  console.error(`[WS Bridge] WebSocket server iniciado em ws://localhost:${WS_PORT}${WS_PATH}`);
  return wss;
}

/**
 * Processa mensagem recebida da extensão.
 */
function handleMessage(msg) {
  const { id, type, result, error } = msg;

  // Resposta a um comando pendente
  if (id && pendingRequests.has(id)) {
    const req = pendingRequests.get(id);
    pendingRequests.delete(id);
    clearTimeout(req.timer);

    if (error) {
      req.reject(new Error(error));
    } else {
      req.resolve(result);
    }
    return;
  }

  // Evento push (ex: nova mensagem) — pode ser usado no futuro
  if (type === "event") {
    console.error(`[WS Bridge] Evento recebido: ${msg.event}`);
  }
}

/**
 * Envia comando para a extensão e aguarda resposta.
 * @param {string} type - Tipo do comando (ex: GET_CHATS, SEND_MESSAGE)
 * @param {object} payload - Dados do comando
 * @returns {Promise<any>} Resultado da extensão
 */
export function sendCommand(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== extensionSocket.OPEN) {
      reject(new Error(
        "Extensão WhatsApp não conectada. Verifique se:\n" +
        "1. A extensão está instalada no Chrome/Edge\n" +
        "2. O WhatsApp Web está aberto (web.whatsapp.com)\n" +
        "3. O popup da extensão mostra status verde"
      ));
      return;
    }

    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout aguardando resposta da extensão (${COMMAND_TIMEOUT}ms). Verifique se o WhatsApp Web está aberto.`));
    }, COMMAND_TIMEOUT);

    pendingRequests.set(id, { resolve, reject, timer });

    extensionSocket.send(JSON.stringify({ id, type, payload }));
  });
}

/**
 * Verifica se a extensão está conectada.
 */
export function isConnected() {
  return extensionSocket !== null && extensionSocket.readyState === extensionSocket.OPEN;
}

/**
 * Encerra o servidor WebSocket.
 */
export function stopServer() {
  clearInterval(pingTimer);
  if (wss) {
    wss.close();
    wss = null;
  }
}
