@echo off
chcp 65001 >nul 2>&1
:: ─── whatsapp-mcp start.bat ───────────────────────────────────────────────────
:: Iniciado automaticamente pelo Claude Code ao abrir qualquer sessão.
:: 1. Localiza pm2 (PATH ou npm bin -g) — evita falso negativo em processos não interativos
:: 2. Garante que o daemon WebSocket está rodando (pm2 com auto-restart)
:: 3. Aguarda o daemon estar saudável via health check
:: 4. Inicia o MCP server (stdio)
::
:: IMPORTANTE: todos os echo vão para stderr (>&2) para não corromper o protocolo
:: MCP que o Claude Code lê via stdout.

set DIR=%~dp0
set PM2_BIN=

:: ── Tentativa 1: pm2 no PATH ──────────────────────────────────────────────
where pm2 >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set PM2_BIN=pm2
    goto PM2_FOUND
)

:: ── Tentativa 2: pm2.cmd via npm bin -g ───────────────────────────────────
for /f "delims=" %%i in ('npm bin -g 2^>nul') do set NPM_GLOBAL=%%i
if defined NPM_GLOBAL (
    if exist "%NPM_GLOBAL%\pm2.cmd" (
        set PM2_BIN=%NPM_GLOBAL%\pm2.cmd
        goto PM2_FOUND
    )
)

:: ── Tentativa 3: instalar pm2 e redetectar ────────────────────────────────
echo [whatsapp-mcp] pm2 nao encontrado. Instalando... >&2
call npm install -g pm2 >nul 2>&1
for /f "delims=" %%i in ('npm bin -g 2^>nul') do set NPM_GLOBAL=%%i
if defined NPM_GLOBAL (
    if exist "%NPM_GLOBAL%\pm2.cmd" (
        set PM2_BIN=%NPM_GLOBAL%\pm2.cmd
        goto PM2_FOUND
    )
)
where pm2 >nul 2>&1
if %ERRORLEVEL% EQU 0 set PM2_BIN=pm2

:PM2_FOUND
if not defined PM2_BIN (
    echo [whatsapp-mcp] ERRO: pm2 nao encontrado mesmo apos instalacao. Verifique npm. >&2
    exit /b 1
)

:: ── Iniciar daemon se não estiver rodando ─────────────────────────────────
"%PM2_BIN%" describe whatsapp-ws-daemon >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [whatsapp-mcp] Iniciando daemon WebSocket... >&2
    "%PM2_BIN%" start "%DIR%src\ws-daemon.js" --name whatsapp-ws-daemon >nul 2>&1
    "%PM2_BIN%" save >nul 2>&1
) else (
    :: Daemon existe — garantir que está online
    "%PM2_BIN%" start whatsapp-ws-daemon >nul 2>&1
)

:: ── Aguardar daemon responder no health check (até 10s) ───────────────────
set RETRIES=0
:WAIT_DAEMON
curl -s -o nul -w "%%{http_code}" http://localhost:3848/health 2>nul | findstr "200" >nul 2>&1
if %ERRORLEVEL% EQU 0 goto DAEMON_READY
set /a RETRIES+=1
if %RETRIES% GEQ 10 (
    echo [whatsapp-mcp] Daemon nao respondeu apos 10s. Continuando mesmo assim... >&2
    goto DAEMON_READY
)
timeout /t 1 /nobreak >nul
goto WAIT_DAEMON

:DAEMON_READY
:: ── Iniciar MCP server (stdio — fica em foreground para o Claude Code) ────
node "%DIR%index.js"
