// ─── WHATSAPP WS DAEMON ───────────────────────────────────────────────────────
// Processo independente que mantém o WebSocket server (porta 3847) e uma API
// HTTP local (porta 3848) para os clientes MCP stdio se comunicarem.
//
// Uso:
//   node src/ws-daemon.js           (direto)
//   pm2 start src/ws-daemon.js --name whatsapp-ws-daemon  (recomendado)
//
// Com o daemon rodando, múltiplas sessões do Claude Code podem coexistir —
// cada uma se conecta ao daemon via HTTP em vez de subir seu próprio WS server.

import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { WS_PORT, WS_PATH, PING_INTERVAL, COMMAND_TIMEOUT } from "./config.js";
import fs from "fs";
import os from "os";
import path from "path";

const DAEMON_HTTP_PORT = 3848;
const IDENTITY_TOKEN   = "whatsapp-mcp-v1";
const LOCK_FILE        = path.join(os.tmpdir(), "whatsapp-mcp-daemon.lock");
const MAX_BODY_BYTES   = 20 * 1024 * 1024; // 20MB — suporta envio de arquivos em base64

// ─── ESTADO ──────────────────────────────────────────────────────────────────

let extensionSocket = null;
let pendingRequests  = new Map();
let requestId        = 0;
let pingTimer        = null;

// ─── LOCK FILE ───────────────────────────────────────────────────────────────

function writeLock() {
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: WS_PORT, httpPort: DAEMON_HTTP_PORT, startTime: Date.now() }));
  } catch {}
}

function clearLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (lock?.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

// ─── WEBSOCKET SERVER (porta 3847) ───────────────────────────────────────────
// Mesma porta de sempre — a extensão Chrome não precisa de nenhuma alteração.

const wss = new WebSocketServer({ port: WS_PORT, path: WS_PATH });

wss.on("listening", () => {
  console.log(`[Daemon] WebSocket server ativo em ws://localhost:${WS_PORT}${WS_PATH}`);
  writeLock();
});

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[Daemon] ERRO: Porta ${WS_PORT} já está em uso.`);
    console.error(`[Daemon] Certifique-se de que o MCP server (index.js) não está rodando em modo standalone.`);
    console.error(`[Daemon] Se o daemon já está rodando: pm2 list | pm2 restart whatsapp-ws-daemon`);
  } else {
    console.error(`[Daemon] Erro no WebSocket server:`, err.message);
  }
  process.exit(1);
});

wss.on("connection", (socket) => {
  console.log("[Daemon] Extensão conectada");
  extensionSocket = socket;

  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, PING_INTERVAL);

  socket.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Probe de identidade
      if (msg.type === "identify") {
        socket.send(JSON.stringify({ type: "identity", token: IDENTITY_TOKEN }));
        return;
      }

      // Ping do service worker
      if (msg.type === "ping") return;

      // Resposta a comando pendente
      if (msg.id && pendingRequests.has(msg.id)) {
        const req = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        clearTimeout(req.timer);
        msg.error ? req.reject(msg.error) : req.resolve(msg.result);
      }
    } catch (err) {
      console.error("[Daemon] Erro ao parsear mensagem:", err.message);
    }
  });

  socket.on("close", () => {
    console.log("[Daemon] Extensão desconectada");
    extensionSocket = null;
    clearInterval(pingTimer);
    rejectAllPending("Extensão desconectou durante a operação");
  });

  socket.on("error", (err) => {
    console.error("[Daemon] Erro WebSocket da extensão:", err.message);
  });
});

// ─── HTTP API (porta 3848) ────────────────────────────────────────────────────
// Usada pelos clientes MCP stdio para enviar comandos e receber respostas.
// Interface simples: POST /command { type, payload } → { result } | { error }

const httpServer = http.createServer((req, res) => {
  // Helper — protege contra resposta em stream já encerrado (cliente abortou)
  const setJson = (status, body) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    return setJson(200, {
      status: "ok",
      extensionConnected: extensionSocket !== null && extensionSocket.readyState === WebSocket.OPEN,
      pendingRequests: pendingRequests.size,
    });
  }

  // Enviar comando para a extensão
  if (req.method === "POST" && req.url === "/command") {
    let body = "";
    let bodyBytes = 0;

    req.on("data", (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        req.destroy();
        setJson(413, { error: "Payload muito grande (máx 64KB)" });
        return;
      }
      body += chunk;
    });

    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return setJson(400, { error: "JSON inválido" });
      }

      const { type, payload = {} } = parsed;

      if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
        return setJson(503, {
          error:
            "Extensão WhatsApp não conectada. Verifique se:\n" +
            "1. A extensão está instalada no Chrome/Edge\n" +
            "2. O WhatsApp Web está aberto (web.whatsapp.com)\n" +
            "3. O popup da extensão mostra status verde\n" +
            "4. Se necessário, recarregue a página do WhatsApp Web (F5)",
        });
      }

      const id = ++requestId;
      const timer = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          setJson(504, { error: `Timeout aguardando resposta da extensão (${COMMAND_TIMEOUT}ms).` });
        }
      }, COMMAND_TIMEOUT);

      pendingRequests.set(id, {
        resolve: (result) => setJson(200, { result }),
        reject:  (error)  => setJson(500, { error: String(error) }),
        timer,
      });

      // Envolver o send em try/catch — socket pode cair entre o check e o envio
      try {
        extensionSocket.send(JSON.stringify({ id, type, payload }));
      } catch (err) {
        pendingRequests.delete(id);
        clearTimeout(timer);
        setJson(503, { error: `Erro ao enviar para a extensão: ${err.message}` });
      }
    });

    req.on("error", () => {
      // Cliente abortou — não há nada a fazer, setJson protege contra stream fechado
    });

    return;
  }

  setJson(404, { error: "Not found" });
});

httpServer.listen(DAEMON_HTTP_PORT, "127.0.0.1", () => {
  console.log(`[Daemon] HTTP API ativa em http://localhost:${DAEMON_HTTP_PORT}`);
  console.log(`[Daemon] Pronto. Múltiplas sessões do Claude Code podem se conectar.`);
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function rejectAllPending(reason) {
  for (const [, req] of pendingRequests) {
    clearTimeout(req.timer);
    req.reject(reason);
  }
  pendingRequests.clear();
}

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────────
// Aguarda callbacks de fechamento do WS e HTTP antes de sair.

function shutdown() {
  console.log("[Daemon] Encerrando...");
  clearInterval(pingTimer);
  rejectAllPending("Daemon encerrando");
  if (extensionSocket) extensionSocket.terminate();
  clearLock();

  let wsReady = false;
  let httpReady = false;

  const tryExit = () => {
    if (wsReady && httpReady) process.exit(0);
  };

  wss.close(() => { wsReady = true; tryExit(); });
  httpServer.close(() => { httpReady = true; tryExit(); });

  // Fallback: forçar saída após 3s se callbacks não chegarem
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);
process.on("exit",    clearLock);
