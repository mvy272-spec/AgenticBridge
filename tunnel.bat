@echo off
chcp 65001 >nul
title Pinggy Tunnel - Agent Bridge

echo Проверяю Node Bridge...
curl.exe -s ^
  -H "X-Bridge-Token: CHANGE-ME-TO-A-LONG-RANDOM-TOKEN" ^
  http://127.0.0.1:8080/api/health

echo.
echo Запускаю SSH-туннель через TCP 443...
echo Не закрывайте это окно.
echo.

ssh.exe ^
  -p 443 ^
  -o ServerAliveInterval=20 ^
  -o ServerAliveCountMax=3 ^
  -o ExitOnForwardFailure=yes ^
  -o StrictHostKeyChecking=no ^
  -R0:127.0.0.1:8080 ^
  a.pinggy.io

pause