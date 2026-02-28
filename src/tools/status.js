// ─── TOOLS: STATUS E CONEXÃO ─────────────────────────────────────────────────

import { isConnected, sendCommand } from "../ws-bridge.js";

export function registerStatusTools(server) {
  // ─── check_connection ──────────────────────────────────────────────────────
  server.tool(
    "whatsapp_check_connection",
    "Verifica se a extensão WhatsApp está conectada e o WhatsApp Web está autenticado.",
    {},
    async () => {
      if (!(await isConnected())) {
        return {
          content: [{
            type: "text",
            text: "Extensão WhatsApp NÃO conectada.\n\n" +
              "Para conectar:\n" +
              "1. Instale a extensão no Chrome/Edge (carregar descompactada)\n" +
              "2. Abra web.whatsapp.com e faça login\n" +
              "3. Inicie o MCP server (npm start)\n" +
              "4. Verifique o popup da extensão — deve ficar verde"
          }],
        };
      }

      try {
        const result = await sendCommand("IS_AUTHENTICATED");
        if (result.authenticated) {
          return {
            content: [{
              type: "text",
              text: "WhatsApp conectado e autenticado!\n" +
                `WebSocket: conectado\nWhatsApp Web: autenticado`
            }],
          };
        } else {
          return {
            content: [{
              type: "text",
              text: "Extensão conectada, mas WhatsApp Web NÃO autenticado.\n" +
                "Abra web.whatsapp.com e faça login com QR code."
            }],
          };
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Erro ao verificar autenticação: ${err.message}` }],
        };
      }
    }
  );

  // ─── get_my_info ───────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_get_my_info",
    "Retorna informações do usuário logado no WhatsApp Web (nome, número, plataforma).",
    {},
    async () => {
      try {
        const result = await sendCommand("GET_MY_INFO");
        return {
          content: [{
            type: "text",
            text: `Informações do WhatsApp:\n` +
              `Nome: ${result.name || "N/A"}\n` +
              `Número: ${result.phone || result.wid || "N/A"}\n` +
              `Plataforma: ${result.platform || "N/A"}`
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Erro: ${err.message}` }],
        };
      }
    }
  );
}
