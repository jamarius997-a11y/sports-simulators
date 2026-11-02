@echo off
cd /d "%~dp0"
echo ===== %date% %time% ===== >> refresh.log
node refresh.js >> refresh.log 2>&1
