# PRD — WhatsApp MCP v2.0
**Produto:** whatsapp-mcp
**Versão atual:** 1.0 (funcionando)
**Próxima versão:** 2.0
**Data:** Fevereiro 2026

---

## Contexto

A v1.0 cobre leitura e envio de texto, guardrails de segurança e gerenciamento de mensagens não lidas.
A v2.0 expande para mídia (download, envio, transcrição de áudio) e notificações em tempo real.

---

## Features v2.0

### Feature 1 — Download de Mídia (imagens, vídeos, documentos)

**O que é:**
Quando uma mensagem tem `hasMedia: true`, baixar o conteúdo (base64) via `WPP.chat.downloadMedia()` e retornar para o Claude visualizar ou descrever.

**Como funciona tecnicamente:**
- Novo handler `DOWNLOAD_MEDIA` no `injected.js`
- Chama `WPP.chat.downloadMedia(msgId)` → retorna `{ data: base64, mimetype, filename }`
- MCP server recebe e retorna o base64 para o Claude interpretar (imagens via `type: "image"` no content block)

**Risco de banimento:** 🟢 BAIXO
- Download de mídia é uma leitura local — o arquivo já está no servidor do WhatsApp, o cliente só requisita o download da CDN (mesma requisição que o app faz quando você abre uma imagem)
- Não há diferença detectável entre um humano abrindo uma imagem e o wa-js fazendo o mesmo
- Não gera tráfego anômalo de saída
- Nenhum relato de ban por download de mídia nos issues do wa-js ou whatsapp-web.js

**Prioridade:** Alta — feature mais solicitada

---

### Feature 2 — Envio de Mídia (imagens, áudios, documentos)

**O que é:**
Enviar imagens, arquivos ou áudios via `WPP.chat.sendFileMessage()` ou `WPP.chat.sendVoiceMessage()`.

**Como funciona tecnicamente:**
- Novo handler `SEND_MEDIA` no `injected.js`
- Recebe base64 + mimetype + filename do MCP server
- Usa `WPP.chat.sendFileMessage(chatId, base64, { mimetype, filename, caption })`
- Todos os guardrails de envio se aplicam (rate limit, daily limit, confirmed, delay)

**Risco de banimento:** 🟡 MÉDIO
- O envio de mídia gera upload para os servidores do WhatsApp — diferente do texto, há tráfego de rede mensurável
- Padrões anômalos (muitos uploads em sequência, arquivos idênticos para destinatários diferentes) são detectáveis
- Risco é equivalente ao envio de texto — os guardrails existentes já cobrem os principais vetores
- Issue documentado no wa-js: `sendFileMessage` tem comportamento intermitente em WA Web 2.3000.x — requer teste
- **Mitigação:** aplicar os mesmos guardrails do texto + limitar a 1 mídia por conversa por minuto

**Prioridade:** Média

---

### Feature 3 — Transcrição de Áudio (Whisper local)

**O que é:**
Quando receber um áudio (`type: "ptt"` ou `type: "audio"`), fazer download do arquivo e transcrever usando Whisper localmente (sem enviar para nenhuma API externa).

**Como funciona tecnicamente:**
- Depende da Feature 1 (download de mídia)
- MCP server recebe o base64 do áudio
- Salva em arquivo temporário `.ogg` ou `.mp3`
- Chama `whisper` via subprocess Python ou usa `openai-whisper` npm
- Retorna a transcrição como texto
- Arquivo temporário deletado após transcrição

**Risco de banimento:** 🟢 MUITO BAIXO
- A transcrição acontece 100% localmente — nenhuma requisição adicional ao WhatsApp
- Do ponto de vista do WhatsApp, é idêntico a um usuário ouvindo o áudio
- Não há tráfego anômalo, sem upload, sem pattern detectável
- Risco real é zero — é apenas um download de mídia + processamento local

**Dependências:**
- Python com `openai-whisper` instalado, OU
- `ffmpeg` + `nodejs-whisper` npm
- Já temos experiência com isso no youtube-mcp

**Prioridade:** Alta — muito útil para ler áudios sem precisar ouvir

---

### Feature 4 — Notificações em Tempo Real (push de novas mensagens)

**O que é:**
Em vez de fazer polling (perguntar "tem mensagem nova?"), a extensão escuta o evento `WPP.chat.on('chat.new_message')` e empurra a notificação para o MCP server automaticamente via WebSocket.

**Como funciona tecnicamente:**
- Adicionar listener no `injected.js`:
  ```js
  WPP.chat.on('chat.new_message', (msg) => {
    sendPushEvent('NEW_MESSAGE', formatMessage(msg));
  });
  ```
- `service-worker.js` recebe e encaminha via WebSocket para o MCP server
- MCP server expõe via SSE (Server-Sent Events) ou via polling do Claude
- Claude pode ser notificado quando uma mensagem nova chegar

**Risco de banimento:** 🟢 BAIXO
- Escutar eventos é uma operação 100% passiva — não gera nenhuma requisição ao servidor do WhatsApp
- O wa-js usa os eventos internos do WhatsApp Web, que já existem no app normalmente
- Nenhum tráfego adicional de rede é gerado
- O único risco seria se o sistema de push disparasse ações automáticas de envio em resposta — o que não está no escopo
- **Atenção:** O MCP server (stdio) não tem canal nativo de push para o Claude. Para que o Claude seja notificado, ele precisaria fazer polling periódico via tool ou o usuário precisaria chamar uma tool de "verificar inbox"

**Limitação técnica:** O protocolo MCP atual (stdio) não suporta notificações push do servidor para o cliente. O Claude só age quando o usuário chama uma tool. A notificação em tempo real funcionaria melhor como:
  a) Um log que o Claude pode consultar
  b) Integração futura quando MCP suportar SSE nativo

**Prioridade:** Baixa na forma de push real; Média na forma de "verificar inbox acumulado"

---

## Análise de Risco Consolidada

| Feature | Risco de Ban | Motivo principal |
|---|:---:|---|
| Download de mídia | 🟢 Baixo | Leitura local da CDN, idêntico ao comportamento humano |
| Transcrição de áudio | 🟢 Muito baixo | 100% local após download, zero tráfego adicional |
| Notificações em tempo real | 🟢 Baixo | Escuta passiva de eventos internos, sem tráfego |
| Envio de mídia | 🟡 Médio | Upload gera tráfego — mesmos guardrails do texto se aplicam |

**O que o WhatsApp detecta de fato (baseado em pesquisa):**
1. Envio em massa / bulk (principal critério)
2. Intervalo fixo de 500ms entre mensagens (padrão de bot)
3. Contas que só enviam, nunca recebem respostas
4. Alto volume de bloqueios/reports de spam por destinatários
5. Extensões que fazem upload massivo para CDN do WhatsApp

**O que NÃO detecta / risco desprezível:**
- Leitura de mensagens via API interna (sem requisição de rede)
- Download de mídia individual
- Escuta de eventos internos
- Processamento local de arquivos

---

## Roadmap de Implementação

| # | Feature | Dependências | Esforço estimado |
|---|---|---|---|
| 1 | Download de mídia | — | Pequeno (1 handler + 1 tool) |
| 2 | Transcrição de áudio | Feature 1 + Whisper instalado | Médio |
| 3 | Notificações (inbox acumulado) | — | Pequeno |
| 4 | Envio de mídia | — | Médio (+ guardrails específicos) |

**Ordem recomendada:** 1 → 2 → 3 → 4

---

## Fontes da pesquisa de risco

- [wppconnect-team/wa-js — GitHub](https://github.com/wppconnect-team/wa-js)
- [WhatsApp — Uso não autorizado de automação](https://faq.whatsapp.com/5957850900902049)
- [131 Chrome Extensions abusaram WhatsApp Web — Malwarebytes](https://www.malwarebytes.com/blog/news/2025/10/over-100-chrome-extensions-break-whatsapps-anti-spam-rules)
- [Reduzir risco de bloqueio — GREEN-API](https://green-api.com/en/blog/reduce-the-risk-of-WA-blocking/)
- [Top Reasons WhatsApp Accounts Get Banned 2025 — Whautomate](https://whautomate.com/top-reasons-why-whatsapp-accounts-get-banned-in-2025-and-how-to-avoid-them/)
- [whatsmeow — WhatsApp ban rules discussion](https://github.com/tulir/whatsmeow/discussions/567)
