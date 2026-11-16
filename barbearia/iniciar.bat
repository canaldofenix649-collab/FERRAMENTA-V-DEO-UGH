@echo off
chcp 65001 >nul
title Gestao da Barbearia
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

echo.
echo  Abrindo http://localhost:3100 no navegador...
echo  Deixe esta janela aberta enquanto usa o sistema. Para desligar, feche-a.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3100"
node --disable-warning=ExperimentalWarning server.js
pause
