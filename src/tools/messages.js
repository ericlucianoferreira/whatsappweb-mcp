// ─── TOOLS: MENSAGENS ────────────────────────────────────────────────────────

import { z } from "zod";
import { sendCommand } from "../ws-bridge.js";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import {
  checkRateLimit,
  checkDailyRecipientLimit,
  checkGroupConfirmation,
  checkMessageLength,
  checkAntiLoop,
  checkSensitiveContent,
  sendDelay,
  SEND_DELAY_SECONDS,
  logAudit,
  getAuditLog,
  getDailyStats,
} from "../guardrails.js";

export function registerMessageTools(server) {
  // ─── list_messages ─────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_list_messages",
    "Lista mensagens recentes de um chat do WhatsApp. CUIDADO: abrir mensagens de um chat pode marcá-las como lidas (blue ticks). Para ver não lidas sem risco, use whatsapp_get_unread_chats primeiro.",
    {
      chat_id: z.string().describe("ID do chat"),
      limit: z.number().optional().default(30).describe("Quantidade de mensagens (padrão 30, máx 50)"),
    },
    async ({ chat_id, limit }) => {
      try {
        const result = await sendCommand("GET_MESSAGES", {
          chatId: chat_id,
          limit: Math.min(limit, 50),
        });

        if (!result.messages || result.messages.length === 0) {
          return { content: [{ type: "text", text: "Nenhuma mensagem encontrada." }] };
        }

        const formatted = result.messages.map((m) => ({
          id: m.id,
          from: m.from || (m.fromMe ? "Eu" : m.sender || "Desconhecido"),
          body: m.body || "",
          timestamp: m.timestamp,
          fromMe: m.fromMe || false,
          type: m.type || "chat",
          hasMedia: m.hasMedia || false,
        }));

        return {
          content: [{
            type: "text",
            text: `⚠️ Atenção: abrir este chat pode marcar mensagens como lidas.\n\n${formatted.length} mensagem(ns):\n\n${JSON.stringify(formatted, null, 2)}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── send_message ──────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_send_message",
    "Envia mensagem pelo WHATSAPP PESSOAL do Eric. " +
    "CANAL: WhatsApp pessoal (não ChatGuru, não Zoom). Sempre confirmar canal com o usuário antes de usar. " +
    "DESTINATÁRIO: SEMPRE use whatsapp_search_contacts antes se o usuário informou apenas um nome. " +
    "Se a busca retornar mais de 1 contato com nome similar, NÃO envie — exiba a lista e peça ao usuário que confirme o chat_id exato. " +
    "FLUXO: confirmed=false (padrão) = mostrar preview, NÃO envia. confirmed=true = enviar após 10s. " +
    "Regras: 10 msgs/min, 50 destinatários/dia, grupos exigem confirmed=true, " +
    "msgs >1000 chars exigem confirmed=true, conteúdo sensível exige confirmed=true.",
    {
      chat_id: z.string().describe("ID do chat destino (ex: 5511999999999@c.us)"),
      message: z.string().describe("Texto da mensagem"),
      confirmed: z.boolean().optional().default(false).describe(
        "false (padrão) = mostrar preview. true = confirmar e enviar após 10s de janela de cancelamento."
      ),
    },
    async ({ chat_id, message, confirmed }) => {
      try {
        // Validações que rodam sempre (antes do preview)
        checkMessageLength(message, confirmed);
        checkSensitiveContent(message, confirmed);
        checkGroupConfirmation(chat_id, confirmed);

        // PREVIEW — se não confirmado, mostrar e parar
        if (!confirmed) {
          return {
            content: [{
              type: "text",
              text: `📋 PREVIEW — mensagem NÃO enviada ainda.\n\n` +
                `Para: ${chat_id}\n` +
                `Mensagem:\n"${message}"\n\n` +
                `Para enviar, chame novamente com confirmed: true.\n` +
                `Após confirmação, haverá ${SEND_DELAY_SECONDS}s de janela para cancelar.`
            }],
          };
        }

        // CONFIRMADO — rodar todos os guardrails
        checkRateLimit();
        checkAntiLoop(chat_id, message);
        checkDailyRecipientLimit(chat_id);

        // Janela de cancelamento
        logAudit({ action: "send_pending", chat_id, length: message.length });
        await sendDelay();

        const result = await sendCommand("SEND_MESSAGE", {
          chatId: chat_id,
          text: message,
        });

        logAudit({ action: "send_message", chat_id, length: message.length, message_id: result.id || "" });

        const stats = getDailyStats();
        return {
          content: [{
            type: "text",
            text: `✅ Mensagem enviada.${result.id ? ` ID: ${result.id}` : ""}\n` +
              `Destinatários hoje: ${stats.uniqueRecipients}/${stats.maxRecipients}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── send_message_by_phone ─────────────────────────────────────────────────
  server.tool(
    "whatsapp_send_message_by_phone",
    "Envia mensagem pelo WHATSAPP PESSOAL do Eric por número de telefone. " +
    "CANAL: WhatsApp pessoal (não ChatGuru, não Zoom). Sempre confirmar canal com o usuário antes de usar. " +
    "Use este tool apenas quando o número de telefone for explicitamente conhecido — sem ambiguidade de destinatário. " +
    "confirmed=false (padrão) = mostrar preview. confirmed=true = enviar após 10s de janela de cancelamento.",
    {
      phone_number: z.string().describe("Número de telefone (ex: 5511999999999)"),
      message: z.string().describe("Texto da mensagem"),
      confirmed: z.boolean().optional().default(false).describe("false = preview, true = enviar"),
    },
    async ({ phone_number, message, confirmed }) => {
      try {
        const cleanNumber = phone_number.replace(/[\s\-\+\(\)]/g, "");
        const chatId = cleanNumber.includes("@") ? cleanNumber : `${cleanNumber}@c.us`;

        checkMessageLength(message, confirmed);
        checkSensitiveContent(message, confirmed);
        checkGroupConfirmation(chatId, confirmed);

        if (!confirmed) {
          return {
            content: [{
              type: "text",
              text: `📋 PREVIEW — mensagem NÃO enviada ainda.\n\n` +
                `Para: ${phone_number}\n` +
                `Mensagem:\n"${message}"\n\n` +
                `Para enviar, chame novamente com confirmed: true.\n` +
                `Após confirmação, haverá ${SEND_DELAY_SECONDS}s de janela para cancelar.`
            }],
          };
        }

        checkRateLimit();
        checkAntiLoop(chatId, message);
        checkDailyRecipientLimit(chatId);

        logAudit({ action: "send_pending", chat_id: chatId, length: message.length });
        await sendDelay();

        const result = await sendCommand("SEND_MESSAGE", { chatId, text: message });

        logAudit({ action: "send_message_by_phone", chat_id: chatId, phone: phone_number, length: message.length, message_id: result.id || "" });

        const stats = getDailyStats();
        return {
          content: [{
            type: "text",
            text: `✅ Mensagem enviada para ${phone_number}.\n` +
              `Destinatários hoje: ${stats.uniqueRecipients}/${stats.maxRecipients}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── get_unread_chats ──────────────────────────────────────────────────────
  server.tool(
    "whatsapp_get_unread_chats",
    "Lista chats com mensagens não lidas. Retorna APENAS metadados — NÃO abre os chats, NÃO marca como lido, NÃO envia blue ticks. Seguro para verificar periodicamente.",
    {},
    async () => {
      try {
        const result = await sendCommand("GET_UNREAD");

        if (!result.chats || result.chats.length === 0) {
          return { content: [{ type: "text", text: "Nenhum chat com mensagens não lidas." }] };
        }

        const formatted = result.chats.map((c) => ({
          chatId: c.id,
          chatName: c.name || c.id,
          isGroup: c.isGroup || false,
          unreadCount: c.unreadCount || 0,
          lastMessage: c.lastMessage
            ? {
                body: (c.lastMessage.body || "").substring(0, 150),
                timestamp: c.lastMessage.timestamp,
                fromMe: c.lastMessage.fromMe,
              }
            : null,
        }));

        const totalUnread = formatted.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
        return {
          content: [{
            type: "text",
            text: `${totalUnread} mensagem(ns) não lida(s) em ${formatted.length} chat(s):\n\n${JSON.stringify(formatted, null, 2)}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── read_unread_messages ──────────────────────────────────────────────────
  server.tool(
    "whatsapp_read_unread_messages",
    "Lê mensagens não lidas de um chat. REGRA IMPORTANTE: após ler, o chat é automaticamente marcado de volta como NÃO LIDO para não perder. Você DEVE usar whatsapp_resolve_chat depois para decidir o que fazer: responder, ignorar (marcar como lido) ou manter não lido.",
    {
      chat_id: z.string().describe("ID do chat"),
      limit: z.number().optional().default(20).describe("Quantidade máxima (padrão 20)"),
    },
    async ({ chat_id, limit }) => {
      try {
        const result = await sendCommand("GET_UNREAD_DETAIL", {
          chatId: chat_id,
          limit: Math.min(limit, 50),
        });

        // Sempre marcar de volta como não lido — regra inviolável
        try {
          await sendCommand("MARK_AS_UNREAD", { chatId: chat_id });
        } catch {}

        if (!result.messages || result.messages.length === 0) {
          return { content: [{ type: "text", text: "Nenhuma mensagem não lida neste chat." }] };
        }

        const formatted = result.messages.map((m) => ({
          id: m.id,
          from: m.from || (m.fromMe ? "Eu" : m.sender || "Desconhecido"),
          body: m.body || "",
          timestamp: m.timestamp,
          fromMe: m.fromMe || false,
          type: m.type || "chat",
        }));

        // Log de auditoria — lido sem resolução
        logAudit({ action: "read_unread", chat_id, count: formatted.length, resolved: false });

        return {
          content: [{
            type: "text",
            text: `${formatted.length} mensagem(ns) lida(s).\n` +
              `⚠️ Chat mantido como NÃO LIDO. Use whatsapp_resolve_chat para decidir:\n` +
              `- "reply" + message: responder e marcar como lido\n` +
              `- "ignore": marcar como lido sem responder\n` +
              `- "keep_unread": manter não lido\n\n` +
              JSON.stringify(formatted, null, 2)
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── resolve_chat ──────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_resolve_chat",
    "Resolve um chat do WHATSAPP PESSOAL após leitura. " +
    "Ações: 'reply' (mostra preview se confirmed=false, envia se confirmed=true), " +
    "'ignore' (marca como lido sem responder — requer confirmação explícita do usuário), " +
    "'keep_unread' (mantém não lido). Usar após whatsapp_read_unread_messages.",
    {
      chat_id: z.string().describe("ID do chat"),
      action: z.enum(["reply", "ignore", "keep_unread"]).describe("Ação a tomar"),
      message: z.string().optional().describe("Mensagem de resposta (obrigatório se action='reply')"),
      confirmed: z.boolean().optional().default(false).describe("false = preview (reply) ou aguarda confirmação (ignore). true = executar."),
    },
    async ({ chat_id, action, message, confirmed }) => {
      try {
        if (action === "reply") {
          if (!message) throw new Error("Mensagem obrigatória para action='reply'.");
          checkMessageLength(message, confirmed);
          checkSensitiveContent(message, confirmed);
          checkGroupConfirmation(chat_id, confirmed);

          // Preview se não confirmado
          if (!confirmed) {
            return {
              content: [{
                type: "text",
                text: `📋 PREVIEW — resposta NÃO enviada ainda.\n\n` +
                  `Para: ${chat_id}\n` +
                  `Mensagem:\n"${message}"\n\n` +
                  `Para enviar, chame novamente com confirmed: true.\n` +
                  `Após confirmação, haverá ${SEND_DELAY_SECONDS}s de janela para cancelar.`
              }],
            };
          }

          checkRateLimit();
          checkAntiLoop(chat_id, message);
          checkDailyRecipientLimit(chat_id);
          logAudit({ action: "resolve_reply_pending", chat_id, length: message.length });
          await sendDelay();
          await sendCommand("SEND_MESSAGE", { chatId: chat_id, text: message });
          await sendCommand("MARK_AS_READ", { chatId: chat_id });
          logAudit({ action: "resolve_reply", chat_id, length: message.length });
          const stats = getDailyStats();
          return {
            content: [{
              type: "text",
              text: `✅ Respondido e marcado como lido.\nDestinatários hoje: ${stats.uniqueRecipients}/${stats.maxRecipients}`
            }],
          };
        }

        if (action === "ignore") {
          if (!confirmed) {
            return {
              content: [{
                type: "text",
                text: `⚠️ Confirma que quer ignorar este chat e marcá-lo como lido sem responder?\n` +
                  `Chat: ${chat_id}\n\n` +
                  `Chame novamente com confirmed: true para confirmar.`
              }],
            };
          }
          await sendCommand("MARK_AS_READ", { chatId: chat_id });
          logAudit({ action: "resolve_ignore", chat_id });
          return { content: [{ type: "text", text: `✅ Chat marcado como lido (ignorado explicitamente).` }] };
        }

        if (action === "keep_unread") {
          logAudit({ action: "resolve_keep_unread", chat_id });
          return { content: [{ type: "text", text: `Chat mantido como não lido.` }] };
        }

      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── mark_as_read ──────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_mark_as_read",
    "Marca um chat como lido (envia blue ticks). Use após ler e processar as mensagens.",
    {
      chat_id: z.string().describe("ID do chat"),
    },
    async ({ chat_id }) => {
      try {
        await sendCommand("MARK_AS_READ", { chatId: chat_id });
        logAudit({ action: "mark_as_read", chat_id });
        return { content: [{ type: "text", text: `Chat marcado como lido.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── mark_as_unread ────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_mark_as_unread",
    "Marca um chat como não lido. Útil para lembrar de responder depois.",
    {
      chat_id: z.string().describe("ID do chat"),
    },
    async ({ chat_id }) => {
      try {
        await sendCommand("MARK_AS_UNREAD", { chatId: chat_id });
        logAudit({ action: "mark_as_unread", chat_id });
        return { content: [{ type: "text", text: `Chat marcado como não lido.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );

  // ─── download_media ────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_download_media",
    "Baixa a mídia (imagem, vídeo, documento, áudio, sticker) de uma mensagem do WhatsApp. " +
    "Retorna o conteúdo em base64 com mimetype. Para imagens, o Claude pode visualizá-las diretamente. " +
    "Para áudios (ptt/audio), use whatsapp_transcribe_audio em seguida.",
    {
      chat_id: z.string().describe("ID do chat (ex: 5511999999999@c.us)"),
      msg_id: z.string().describe("ID da mensagem com mídia (campo 'id' retornado por list_messages)"),
    },
    async ({ chat_id, msg_id }) => {
      try {
        const result = await sendCommand("DOWNLOAD_MEDIA", { chatId: chat_id, msgId: msg_id });

        const { data, mimetype, filename, type, caption } = result;

        if (!data) throw new Error("Mídia retornou vazia — o arquivo pode ter expirado no servidor do WhatsApp.");

        // Para imagens: retornar como bloco de imagem (Claude visualiza diretamente)
        if (mimetype && mimetype.startsWith("image/")) {
          const base64Data = data.replace(/^data:[^;]+;base64,/, "");
          return {
            content: [
              {
                type: "text",
                text: `📎 Mídia baixada: ${filename || type}\nTipo: ${mimetype}${caption ? `\nLegenda: ${caption}` : ""}`,
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimetype,
                  data: base64Data,
                },
              },
            ],
          };
        }

        // Para outros tipos (áudio, vídeo, documento): salvar em tmp e retornar caminho
        const ext = mimetype ? mimetype.split("/")[1]?.split(";")[0] : "bin";
        const tmpFile = path.join(os.tmpdir(), `whatsapp-media-${Date.now()}.${ext}`);
        const base64Data = data.replace(/^data:[^;]+;base64,/, "");
        fs.writeFileSync(tmpFile, Buffer.from(base64Data, "base64"));

        logAudit({ action: "download_media", chat_id, msg_id, type, mimetype, tmpFile });

        return {
          content: [{
            type: "text",
            text: `📎 Mídia baixada: ${filename || type}\nTipo: ${mimetype}\nArquivo temporário: ${tmpFile}${caption ? `\nLegenda: ${caption}` : ""}\n\n` +
              (type === "ptt" || type === "audio"
                ? `🎤 É um áudio. Use whatsapp_transcribe_audio com:\n  chat_id: "${chat_id}"\n  msg_id: "${msg_id}"`
                : ``)
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro ao baixar mídia: ${err.message}` }] };
      }
    }
  );

  // ─── transcribe_audio ──────────────────────────────────────────────────────
  server.tool(
    "whatsapp_transcribe_audio",
    "Transcreve um áudio ou mensagem de voz (ptt) do WhatsApp usando Whisper localmente. " +
    "Faz o download do áudio e transcreve sem enviar para nenhuma API externa. " +
    "Requer: Python com openai-whisper instalado (pip install openai-whisper) e ffmpeg no PATH.",
    {
      chat_id: z.string().describe("ID do chat"),
      msg_id: z.string().describe("ID da mensagem de áudio"),
      language: z.string().optional().default("pt").describe("Idioma do áudio (padrão: pt para português)"),
    },
    async ({ chat_id, msg_id, language }) => {
      try {
        // 1. Baixar o áudio via DOWNLOAD_MEDIA
        const mediaResult = await sendCommand("DOWNLOAD_MEDIA", { chatId: chat_id, msgId: msg_id });
        const { data, mimetype, type } = mediaResult;

        if (!data) throw new Error("Áudio retornou vazio — arquivo pode ter expirado.");
        if (type !== "ptt" && type !== "audio") {
          throw new Error(`Esta mensagem não é um áudio (type: ${type}). Use whatsapp_download_media para outros tipos de mídia.`);
        }

        // 2. Salvar em arquivo temporário
        const tmpOgg = path.join(os.tmpdir(), `whatsapp-audio-${Date.now()}.ogg`);
        const base64Data = data.replace(/^data:[^;]+;base64,/, "");
        fs.writeFileSync(tmpOgg, Buffer.from(base64Data, "base64"));

        // 3. Transcrever com Whisper via Python
        const transcript = await new Promise((resolve, reject) => {
          const pythonScript = `
import whisper, sys, json
model = whisper.load_model("base")
result = model.transcribe(sys.argv[1], language="${language}")
print(result["text"].strip())
`.trim();

          const scriptFile = path.join(os.tmpdir(), "whisper_transcribe.py");
          fs.writeFileSync(scriptFile, pythonScript);

          execFile("python3", [scriptFile, tmpOgg], { timeout: 120_000 }, (err, stdout, stderr) => {
            // Limpar arquivos temporários
            try { fs.unlinkSync(tmpOgg); } catch {}
            try { fs.unlinkSync(scriptFile); } catch {}

            if (err) {
              if (err.message.includes("No module named whisper") || stderr.includes("No module named whisper")) {
                reject(new Error(
                  "Whisper não está instalado. Para instalar:\n" +
                  "1. pip install openai-whisper\n" +
                  "2. Instalar ffmpeg: https://ffmpeg.org/download.html\n" +
                  "Depois reinicie o Claude Code."
                ));
              } else {
                reject(new Error(`Erro no Whisper: ${stderr || err.message}`));
              }
              return;
            }
            resolve(stdout.trim());
          });
        });

        logAudit({ action: "transcribe_audio", chat_id, msg_id, language, length: transcript.length });

        return {
          content: [{
            type: "text",
            text: `🎤 Transcrição (${language}):\n\n"${transcript}"`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro na transcrição: ${err.message}` }] };
      }
    }
  );

  // ─── get_audit_log ─────────────────────────────────────────────────────────
  server.tool(
    "whatsapp_get_audit_log",
    "Retorna o log de auditoria das últimas ações realizadas (envios, leituras). Útil para rastrear o que foi feito.",
    {
      limit: z.number().optional().default(20).describe("Quantidade de entradas (padrão 20)"),
    },
    async ({ limit }) => {
      try {
        const entries = getAuditLog(limit);
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "Nenhuma entrada no log de auditoria." }] };
        }
        const stats = getDailyStats();
        return {
          content: [{
            type: "text",
            text: `📊 Stats hoje: ${stats.uniqueRecipients}/${stats.maxRecipients} destinatários únicos\n\n` +
              `Últimas ${entries.length} ações:\n\n${JSON.stringify(entries, null, 2)}`
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Erro: ${err.message}` }] };
      }
    }
  );
}
