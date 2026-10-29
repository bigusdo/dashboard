@echo off
chcp 65001 >nul
cd /d "%~dp0server"
start "" http://localhost:3000
node server.mjs
pause
