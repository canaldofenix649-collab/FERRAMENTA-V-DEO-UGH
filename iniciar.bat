@echo off
chcp 65001 >nul
title Estudio Viral IA
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js nao encontrado.
  echo  Instale a versao LTS em https://nodejs.org e depois rode este arquivo de novo.
  echo.
  start https://nodejs.org
  pause
  exit /b
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo  ============================================================
  echo   PRIMEIRA VEZ: vou abrir o arquivo de configuracao.
  echo   Preencha pelo menos:
  echo     ANTHROPIC_API_KEY=  (sua chave da Anthropic)
  echo     ADMIN_EMAIL=        (seu e-mail)
  echo     AI33_API_KEY=       (sua chave da ai33, para a voz)
  echo   Salve, feche o Bloco de Notas e volte aqui.
  echo  ============================================================
  echo.
  notepad ".env"
  pause
)

if not exist "node_modules" (
  echo.
  echo  Instalando dependencias, pode levar alguns minutos...
  call npm install
  if errorlevel 1 (
    echo.
    echo  Erro na instalacao. Copie as mensagens acima e envie para o suporte.
    pause
    exit /b
  )
)

echo.
echo  Abrindo http://localhost:3000 no navegador...
echo  Deixe esta janela aberta enquanto usa a ferramenta. Para desligar, feche-a.
echo.
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
call npm start
pause
