// ─── WHATSAPP MCP SERVER ─────────────────────────────────────────────────────
// MCP server que conecta Claude Code ao WhatsApp Web via extensão Chrome/Edge.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startServer, stopServer } from "./src/ws-bridge.js";
import { registerStatusTools } from "./src/tools/status.js";
import { registerChatTools } from "./src/tools/chats.js";
import { registerMessageTools } from "./src/tools/messages.js";
import { registerContactTools } from "./src/tools/contacts.js";

// ─── GRACEFUL SHUTDOWN ──────────────────────────────────────────────────────

async function shutdown() {
  try {
    await stopServer();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── MCP SERVER ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "whatsapp-mcp",
  version: "1.0.0",
});

// Registrar todas as tools (15 total)
registerStatusTools(server);    // 2 tools: check_connection, get_my_info
registerChatTools(server);      // 3 tools: list_chats, get_chat, search_chats
registerMessageTools(server);   // 11 tools: list_messages, send_message, send_message_by_phone, get_unread_chats, read_unread_messages, resolve_chat, mark_as_read, mark_as_unread, download_media, transcribe_audio, get_audit_log
registerContactTools(server);   // 3 tools: search_contacts, check_number_exists, get_contact_about

// ─── INICIAR ─────────────────────────────────────────────────────────────────

// 1. Iniciar WebSocket server para comunicação com a extensão
await startServer();

// 2. Conectar ao Claude Code via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
