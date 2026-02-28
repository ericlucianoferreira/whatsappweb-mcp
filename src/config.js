// ─── CONFIGURAÇÃO DO WHATSAPP MCP ───────────────────────────────────────────

export const WS_PORT = 3847;
export const WS_PATH = "/whatsapp-bridge";

// Delay humanizado para envio (ms) — usado no injected.js
export const SEND_DELAY_MIN = 800;
export const SEND_DELAY_MAX = 2500;

// WebSocket keep-alive interval (ms)
export const PING_INTERVAL = 20_000;

// Timeout para aguardar resposta da extensão (ms)
// 30s para dar margem ao DOWNLOAD_MEDIA + Whisper medium
export const COMMAND_TIMEOUT = 30_000;
