@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 墨 · 单词实验室
echo.
echo   墨 · 单词实验室
echo   ------------------------------------
if not exist "data\momo.db" (
  echo   首次运行，正在构建数据库（约 1 分钟）...
  python build_db.py
  echo.
)
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8899"
python server.py
pause
