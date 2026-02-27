// ─── TOOLS: CONTATOS ─────────────────────────────────────────────────────────

import { z } from "zod";
import { sendCommand } from "../ws-bridge.js";

export function registerContactTools(server) {
  // ─── search_contacts ───────────────────────────────────────────────────────
  server.tool(
    "whatsapp_search_contacts",
    "Busca contatos no WhatsApp por nome ou número de telefone. " +
    "REGRA: Se retornar mais de 1 resultado com nomes similares ao buscado, NÃO prosseguir com envio. " +
    "Exibir a lista completa ao usuário e pedir que confirme o chat_id exato antes de qualquer envio.",
    {
      query: z.string().describe("Nome ou número para buscar"),
    },
    async ({ query }) => {
      try {
        const result = await sendCommand("SEARCH_CONTACTS", { query });

        if (!result.contacts || result.contacts.length === 0) {
          return { content: [{ type: "text", text: `Nenhum contato encontrado para "${query}".` }] };
        }

        const formatted = result.contacts.map((c) => ({
          id: c.id,
          name: c.name || c.pushname || c.id,
          number: c.number || c.id?.replace("@c.us", "") || "N/A",
          isMyContact: c.isMyContact || false,
          isBusiness: c.isBusiness || false,
        }));

        return {
          content: [{
            type: "text",
            text: `${formatted.length} contato(s) para "${query}":\n\n${JSON.stringify(formatted, null, 2)}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── check_number_exists ───────────────────────────────────────────────────
  server.tool(
    "whatsapp_check_number_exists",
    "Verifica se um número de telefone está registrado no WhatsApp. Retorna o ID correto (útil para números BR com 9 dígito).",
    {
      phone_number: z.string().describe("Número de telefone (ex: 5511999999999)"),
    },
    async ({ phone_number }) => {
      try {
        const cleanNumber = phone_number.replace(/[\s\-\+\(\)]/g, "");
        const result = await sendCommand("CHECK_EXISTS", { phone: cleanNumber });

        if (result.exists) {
          return {
            content: [{
              type: "text",
              text: `Número ${phone_number} existe no WhatsApp.\n` +
                `ID: ${result.jid || "N/A"}\n` +
                `Conta Business: ${result.isBusiness ? "Sim" : "Não"}`
            }],
          };
        } else {
          return {
            content: [{
              type: "text",
              text: `Número ${phone_number} NÃO está registrado no WhatsApp.`
            }],
          };
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── get_contact_about ─────────────────────────────────────────────────────
  server.tool(
    "whatsapp_get_contact_about",
    "Retorna informações detalhadas de um contato do WhatsApp (nome, status/about, foto, se é business).",
    {
      contact_id: z.string().describe("ID do contato (ex: 5511999999999@c.us)"),
    },
    async ({ contact_id }) => {
      try {
        const result = await sendCommand("GET_CONTACT", { contactId: contact_id });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );
}
