@echo off
setlocal
set "MEM_GRAPH_DIR=C:/Users/VanCh/.claude/mem-graph"
cd /d "C:\Users\VanCh\Documents\Projects\mem-graph"
node node_modules\tsx\dist\cli.mjs src\index.ts
