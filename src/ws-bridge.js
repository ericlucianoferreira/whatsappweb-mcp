// ─── WEBSOCKET BRIDGE ────────────────────────────────────────────────────────
// Gerencia a conexão entre o MCP server e a extensão Chrome/Edge.
//
// Dois modos de operação:
//
// MODO DAEMON (recomendado — múltiplas sessões):
//   Se ws-daemon.js estiver rodando (detectado via GET /health na porta 3848),
//   este módulo funciona como cliente HTTP do daemon. Não sobe nenhum servidor
//   WebSocket. Múltiplas sessões do Claude Code coexistem sem conflito.
//
// MODO STANDALONE (comportamento original):
//   Se o daemon não estiver rodando, este módulo sobe seu próprio WebSocket
//   server na porta 3847, exatamente como antes. Compatibilidade total.
//
// Para ativar o modo daemon:
//   npm run start-daemon    (inicia via pm2)
//   ou: node src/ws-daemon.js

import { WebSocketServer, WebSocket } from "ws";
import { WS_PORT, WS_PATH, PING_INTERVAL, COMMAND_TIMEOUT } from "./config.js";
import fs from "fs";
import os from "os";
import path from "path";

const DAEMON_HTTP_PORT = 3848;
const DAEMON_URL       = `http://localhost:${DAEMON_HTTP_PORT}`;

// ─── DETECÇÃO DO DAEMON ───────────────────────────────────────────────────────

let usingDaemon = false;

async function checkDaemon() {
  try {
    const res = await fetch(`${DAEMON_URL}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const data = await res.json();
      if (data.status === "ok") return true;
    }
  } catch {}
  return false;
}

// ─── MODO DAEMON: SEND COMMAND VIA HTTP ──────────────────────────────────────

async function sendCommandDaemon(type, payload = {}) {
  let res;
  try {
    res = await fetch(`${DAEMON_URL}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, payload }),
      signal: AbortSignal.timeout(COMMAND_TIMEOUT + 2000),
    });
  } catch (err) {
    throw new Error(`Daemon não respondeu: ${err.message}`);
  }

  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.result;
}

async function isConnectedDaemon() {
  try {
    const res = await fetch(`${DAEMON_URL}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const data = await res.json();
      return data.extensionConnected === true;
    }
  } catch {}
  return false;
}

// ─── ESTADO ──────────────────────────────────────────────────────────────────

let wss = null;
let extensionSocket = null;
let pendingRequests = new Map();
let requestId = 0;
let pingTimer = null;

// ─── LOCK FILE ───────────────────────────────────────────────────────────────
// Previne conflitos de porta entre múltiplas instâncias do MCP.
// O lock file contém o PID do processo dono da porta.

const LOCK_FILE = path.join(os.tmpdir(), "whatsapp-mcp.lock");
const IDENTITY_TOKEN = "whatsapp-mcp-v1";

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeLock() {
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      pid: process.pid,
      port: WS_PORT,
      startTime: Date.now(),
    }));
  } catch (err) {
    console.error(`[WS Bridge] Erro ao escrever lock file: ${err.message}`);
  }
}

function clearLock() {
  try {
    const lock = readLock();
    // Só apagar se o lock pertence a este processo
    if (lock && lock.pid === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = só verifica se existe
    return true;
  } catch (err) {
    // No Windows, EPERM significa processo existe mas sem permissão de sinal — tratar como vivo
    if (err.code === "EPERM") return true;
    return false; // ESRCH = processo não existe
  }
}

// ─── PROBE ───────────────────────────────────────────────────────────────────
// Quando a porta está em uso, tenta conectar para ver se é uma instância
// ativa do whatsapp-mcp ou um processo morto/TIME_WAIT.

function probeExistingServer() {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    try {
      const client = new WebSocket(`ws://localhost:${WS_PORT}${WS_PATH}`);
      const timeout = setTimeout(() => {
        client.terminate();
        done(false); // Ninguém respondeu = porta morta
      }, 2000);

      client.on("open", () => {
        client.send(JSON.stringify({ type: "identify" }));
        // Se abriu mas não responde em 1s, não é nosso
        setTimeout(() => {
          client.terminate();
          done(false);
        }, 1000);
      });

      client.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          clearTimeout(timeout);
          client.terminate();
          done(msg.token === IDENTITY_TOKEN);
        } catch {
          clearTimeout(timeout);
          client.terminate();
          done(false);
        }
      });

      client.on("error", () => {
        clearTimeout(timeout);
        done(false);
      });
    } catch {
      done(false);
    }
  });
}

// ─── SERVER ──────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY = 3000;

export async function startServer(retryCount = 0) {
  // Verificar se o daemon está rodando antes de tentar subir standalone
  const daemonRunning = await checkDaemon();
  if (daemonRunning) {
    usingDaemon = true;
    console.error(`[WS Bridge] Modo DAEMON ativo — conectado ao daemon em ${DAEMON_URL}`);
    console.error(`[WS Bridge] Múltiplas sessões do Claude Code são suportadas.`);
    return null;
  }

  // 1. Verificar lock file antes de tentar bind
  const lock = readLock();
  if (lock && lock.pid !== process.pid && isProcessAlive(lock.pid)) {
    // PID está vivo — mas pode ser PID reutilizado por outro processo.
    // Confirmar com probe antes de desistir.
    const isRealSibling = await probeExistingServer();
    if (isRealSibling) {
      console.error(`[WS Bridge] Instância ativa detectada (PID ${lock.pid}).`);
      console.error(`[WS Bridge] Este processo funcionará sem WebSocket.`);
      console.error(`[WS Bridge] Feche outras janelas do Claude Code para usar o WhatsApp nesta sessão.`);
      return null;
    }
    // Probe falhou — lock stale com PID reutilizado, ignorar e tentar bind
    console.error(`[WS Bridge] Lock stale (PID ${lock.pid} pertence a outro processo). Assumindo porta livre.`);
  }

  // 2. Lock stale ou inexistente — tentar bind
  return new Promise((resolve) => {
    try {
      wss = new WebSocketServer({ port: WS_PORT, path: WS_PATH });
    } catch (err) {
      console.error(`[WS Bridge] Erro ao criar WebSocket server: ${err.message}`);
      resolve(null);
      return;
    }

    wss.on("listening", () => {
      console.error(`[WS Bridge] WebSocket server ATIVO em ws://localhost:${WS_PORT}${WS_PATH}`);
      writeLock();
      setupConnectionHandler();
      resolve(wss);
    });

    wss.on("error", (err) => {
      if (err.code !== "EADDRINUSE") {
        console.error(`[WS Bridge] Erro no servidor: ${err.message}`);
        wss = null;
        resolve(null);
        return;
      }

      console.error(`[WS Bridge] Porta ${WS_PORT} em uso — verificando...`);

      // 3. Probe: é instância viva ou processo morto?
      probeExistingServer().then((isLiveSibling) => {
        if (isLiveSibling) {
          console.error(`[WS Bridge] Instância irmã ativa na porta ${WS_PORT}.`);
          console.error(`[WS Bridge] Este processo funcionará sem WebSocket.`);
          wss = null;
          resolve(null);
        } else if (retryCount < MAX_RETRIES) {
          // Porta presa por TIME_WAIT ou processo morto — aguardar e tentar de novo
          console.error(`[WS Bridge] Porta provavelmente em TIME_WAIT. Retry ${retryCount + 1}/${MAX_RETRIES} em ${RETRY_DELAY / 1000}s...`);
          wss = null;
          setTimeout(() => {
            startServer(retryCount + 1).then(resolve);
          }, RETRY_DELAY);
        } else {
          console.error(`[WS Bridge] Não foi possível obter a porta ${WS_PORT} após ${MAX_RETRIES} tentativas.`);
          console.error(`[WS Bridge] Para resolver: feche outros terminais do Claude Code ou mate o processo na porta ${WS_PORT}.`);
          wss = null;
          resolve(null);
        }
      });
    });
  });
}

// ─── CONNECTION HANDLER ──────────────────────────────────────────────────────

function setupConnectionHandler() {
  wss.on("connection", (ws) => {
    console.error(`[WS Bridge] Extensão conectada`);
    extensionSocket = ws;

    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, PING_INTERVAL);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(msg, ws);
      } catch (err) {
        console.error(`[WS Bridge] Erro ao parsear mensagem: ${err.message}`);
      }
    });

    ws.on("close", () => {
      console.error(`[WS Bridge] Extensão desconectada`);
      extensionSocket = null;
      clearInterval(pingTimer);
      rejectAllPending("Extensão desconectou durante a operação");
    });

    ws.on("error", (err) => {
      console.error(`[WS Bridge] Erro WebSocket: ${err.message}`);
    });
  });
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────

function handleMessage(msg, ws) {
  // Responder a identify (probe de outra instância)
  if (msg.type === "identify") {
    ws.send(JSON.stringify({ type: "identity", token: IDENTITY_TOKEN }));
    return;
  }

  // Ignorar pings do service worker
  if (msg.type === "ping") {
    return;
  }

  const { id, result, error, type } = msg;

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

  // Evento push
  if (type === "event") {
    console.error(`[WS Bridge] Evento recebido: ${msg.event}`);
  }
}

// ─── SEND COMMAND ────────────────────────────────────────────────────────────

export function sendCommand(type, payload = {}) {
  // Modo daemon: delegar para HTTP
  if (usingDaemon) return sendCommandDaemon(type, payload);

  // Modo standalone: WebSocket direto (comportamento original)
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      reject(new Error(
        "Extensão WhatsApp não conectada. Verifique se:\n" +
        "1. A extensão está instalada no Chrome/Edge\n" +
        "2. O WhatsApp Web está aberto (web.whatsapp.com)\n" +
        "3. O popup da extensão mostra status verde\n" +
        "4. Se necessário, recarregue a página do WhatsApp Web (F5)"
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

export function isConnected() {
  if (usingDaemon) return isConnectedDaemon();
  return extensionSocket !== null && extensionSocket.readyState === WebSocket.OPEN;
}

function rejectAllPending(reason) {
  for (const [id, req] of pendingRequests) {
    clearTimeout(req.timer);
    req.reject(new Error(reason));
  }
  pendingRequests.clear();
}

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────────
// Fecha todos os clients imediatamente, depois fecha o server.
// Isso libera a porta MUITO mais rápido que wss.close() sozinho.

export function stopServer() {
  // Modo daemon: não encerrar o daemon ao fechar o MCP — ele é independente
  if (usingDaemon) return Promise.resolve();

  clearInterval(pingTimer);
  rejectAllPending("Servidor encerrando");

  if (!wss) {
    clearLock();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    // Forçar desconexão de todos os clients
    for (const client of wss.clients) {
      client.terminate();
    }
    extensionSocket = null;

    wss.close(() => {
      wss = null;
      clearLock();
      resolve();
    });

    // Fallback: se wss.close() não chamar callback em 2s, forçar
    setTimeout(() => {
      wss = null;
      clearLock();
      resolve();
    }, 2000);
  });
}

// ─── PROCESS CLEANUP ─────────────────────────────────────────────────────────

process.on("exit", clearLock);
