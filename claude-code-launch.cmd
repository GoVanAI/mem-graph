@echo off
setlocal
set "MEM_GRAPH_DIR=%USERPROFILE%\.claude\mem-graph"
cd /d "%~dp0"
node node_modules\tsx\dist\cli.mjs src\index.ts
