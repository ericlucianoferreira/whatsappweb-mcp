# whatsapp-mcp

MCP server que conecta o Claude Code ao WhatsApp Web via extensão Chrome/Edge.
Lê e envia mensagens, transcreve áudios, baixa mídias — tudo sem QR code adicional, reutilizando a sessão já aberta no navegador.

---

## Arquitetura

```
Claude Code (stdio)
    ↓
index.js  —  MCP Server (Node.js)
    ↓
src/ws-bridge.js  —  WebSocket Server (porta 3847)
    ↓
extension/service-worker.js  —  WebSocket Client (Edge/Chrome)
    ↓
extension/content-script.js  —  Bridge
    ↓
extension/injected.js  —  WA-JS no contexto da página
    ↓
web.whatsapp.com
```

---

## Pré-requisitos

- Node.js ≥ 18
- Microsoft Edge ou Google Chrome com WhatsApp Web aberto e logado
- Python 3 + `openai-whisper` + ffmpeg (somente para transcrição de áudios)

---

## Instalação

### 1. Instalar dependências do MCP server

```bash
cd "MCPs e Skills/whatsapp-mcp"
npm install
```

### 2. Instalar a extensão no Edge

1. Abra `edge://extensions`
2. Ative **Modo de desenvolvedor** (canto superior direito)
3. Clique em **Carregar sem pacote**
4. Selecione a pasta `extension/` deste repositório
5. A extensão **Jarvis WA** aparecerá na lista

Para Chrome: mesmo processo em `chrome://extensions`

### 3. Configurar o Claude Code

Adicione ao arquivo de configuração do Claude Code (`.claude.json` do projeto ou `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "whatsapp-mcp": {
      "command": "node",
      "args": ["C:\\caminho\\para\\whatsapp-mcp\\index.js"]
    }
  }
}
```

### 4. Instalar dependências de transcrição (opcional)

Necessário apenas para `whatsapp_transcribe_audio`:

```bash
pip install openai-whisper
```

ffmpeg: baixe em https://ffmpeg.org/download.html e coloque em `~/ffmpeg/` ou no PATH.

---

## Uso

### Verificar conexão

```
whatsapp_check_connection
```

Confirma se a extensão está conectada e o WhatsApp Web está autenticado.

### Listar chats não lidos

```
whatsapp_get_unread_chats
```

Retorna metadados de todos os chats com mensagens não lidas — **sem abrir os chats, sem marcar como lido**.

### Ler mensagens

```
whatsapp_list_messages
  chat_id: "5511999999999@c.us"
  unread_only: true   ← padrão: somente não lidas
```

O chat é mantido como **não lido** automaticamente após a leitura.

### Enviar mensagem

```
whatsapp_send_message
  chat_id: "5511999999999@c.us"
  message: "Olá!"
  confirmed: false   ← padrão: mostra preview antes de enviar
```

Fluxo: `confirmed=false` → preview → usuário confirma → `confirmed=true` → janela de 10s para cancelar → envio.

### Responder/citar mensagem

```
whatsapp_send_message
  chat_id: "5511999999999@c.us"
  message: "Respondendo isso aqui"
  reply_to_msg_id: "false_5511999999999@c.us_XXXXXXXXXXX"
  confirmed: true
```

### Transcrever áudio

```
whatsapp_transcribe_audio
  chat_id: "5511999999999@c.us"
  msg_id:  "false_5511999999999@c.us_XXXXXXXXXXX"
```

Baixa o áudio e transcreve localmente com Whisper (modelo `medium`). Nenhum dado é enviado para APIs externas.

### Baixar mídia

```
whatsapp_download_media
  chat_id: "5511999999999@c.us"
  msg_id:  "false_5511999999999@c.us_XXXXXXXXXXX"
```

Imagens são retornadas diretamente para visualização. Outros formatos são salvos em arquivo temporário.

---

## Tools disponíveis (19)

| Tool | Descrição |
|------|-----------|
| `whatsapp_check_connection` | Verifica conexão da extensão e autenticação do WA |
| `whatsapp_get_my_info` | Dados do usuário logado (nome, número) |
| `whatsapp_list_chats` | Lista chats recentes |
| `whatsapp_get_chat` | Detalhes de um chat |
| `whatsapp_search_chats` | Busca chats por nome |
| `whatsapp_list_messages` | Lê mensagens (não lidas por padrão) |
| `whatsapp_send_message` | Envia mensagem por chat_id |
| `whatsapp_send_message_by_phone` | Envia mensagem por número de telefone |
| `whatsapp_get_unread_chats` | Lista chats com não lidas (só metadados) |
| `whatsapp_read_unread_messages` | Lê não lidas e mantém como não lido |
| `whatsapp_resolve_chat` | Resolve chat: reply / ignore / keep_unread |
| `whatsapp_mark_as_read` | Marca chat como lido |
| `whatsapp_mark_as_unread` | Marca chat como não lido |
| `whatsapp_download_media` | Baixa mídia em base64 |
| `whatsapp_transcribe_audio` | Transcreve áudio com Whisper local |
| `whatsapp_get_audit_log` | Log de todas as ações realizadas |
| `whatsapp_search_contacts` | Busca contatos por nome ou número |
| `whatsapp_check_number_exists` | Verifica se número existe no WhatsApp |
| `whatsapp_get_contact_about` | Info detalhada de um contato |

---

## Guardrails de segurança

- **Rate limit:** máximo 10 mensagens por minuto
- **Limite diário:** máximo 50 destinatários únicos por dia
- **Preview obrigatório:** toda mensagem mostra preview antes de enviar (`confirmed=false` por padrão)
- **Janela de cancelamento:** 10 segundos após confirmar antes do envio real
- **Anti-loop:** bloqueia reenvio do mesmo texto para o mesmo destinatário em menos de 60s
- **Conteúdo sensível:** bloqueia CPF, CNPJ, cartão de crédito, senhas e tokens
- **Grupos:** exibem aviso ⚠️ GRUPO no preview
- **Auditoria:** todas as ações são registradas em `~/.whatsapp-mcp-audit.jsonl`

---

## Troubleshooting

### "Extensão WhatsApp não conectada"

1. Verifique se o WhatsApp Web está aberto no Edge/Chrome (`web.whatsapp.com`)
2. Verifique se a extensão **Jarvis WA** está ativa em `edge://extensions`
3. Clique no ícone da extensão — o popup deve mostrar status verde
4. Se necessário, recarregue a extensão e dê F5 no WhatsApp Web

### "Timeout aguardando resposta da extensão"

- O WhatsApp Web pode estar sincronizando após sleep/wake. Aguarde a barra de progresso sumir e tente novamente.
- Timeout configurado: 30 segundos.

### "Mensagem não encontrada no store" (download de mídia)

- Mensagens antigas podem não estar carregadas em memória. Abra o chat no WhatsApp Web, role até a mensagem, e tente novamente.

### Conflito de porta 3847

O MCP server usa um lock file em `%TEMP%/whatsapp-mcp.lock` para evitar conflitos. Se houver processo travado:

```powershell
# Verificar processo na porta
netstat -ano | findstr 3847

# Matar processo (substitua PID pelo número encontrado)
Stop-Process -Id PID -Force
```

Depois reinicie o Claude Code.

### WhatsApp Web desconectou após sleep/wake

Comportamento esperado: o WA-JS pode corromper o IndexedDB local se injetado durante a sincronização após o computador acordar. Escaneie o QR code novamente — a sessão é restaurada em segundos e o IndexedDB corrompido é limpo automaticamente.

### Transcrição falha com "No module named whisper"

```bash
pip install openai-whisper
```

Se o ffmpeg não for encontrado, coloque o executável em `~/ffmpeg/ffmpeg-master-latest-win64-gpl/bin/` ou adicione ao PATH do sistema.

---

## Estrutura do projeto

```
whatsapp-mcp/
├── index.js                 # MCP Server — entry point
├── package.json
├── .env.example
├── PRD-v2.md                # Roadmap de features
├── src/
│   ├── config.js            # Porta WS, timeouts, constantes
│   ├── ws-bridge.js         # WebSocket server + lock file
│   ├── guardrails.js        # Rate limit, anti-loop, auditoria
│   └── tools/
│       ├── messages.js      # 11 tools de mensagem
│       ├── chats.js         # 3 tools de chat
│       ├── contacts.js      # 3 tools de contato
│       └── status.js        # 2 tools de status
└── extension/
    ├── manifest.json        # Manifest V3 (Chrome + Edge)
    ├── service-worker.js    # Background — WebSocket client + keep-alive
    ├── content-script.js    # Bridge ISOLATED ↔ MAIN + reconexão automática
    ├── injected.js          # Mundo MAIN — WA-JS handlers
    ├── wppconnect-wa.js     # Build @wppconnect/wa-js v3.22.0
    ├── popup.html / popup.js
    └── icons/
```

---

## Licença

MIT — Expert Integrado 2026
