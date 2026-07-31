@echo off
chcp 65001 >nul
cd /d "%~dp0"
:menu
cls
echo.
echo   ==============================================
echo       aiaha-proxy   Control Panel
echo   ==============================================
echo.
echo     [1] Start proxy   (auto-open dashboard / 启动代理并打开面板)
echo     [2] Setup account / config wizard   (设置账号)
echo     [3] Refresh login token   (刷新令牌)
echo     [4] Exit   (退出)
echo.
set /p op=Enter number / 输入数字回车: 
if "%op%"=="1" goto run
if "%op%"=="2" goto setupacc
if "%op%"=="3" goto refresh
if "%op%"=="4" exit /b
goto menu

:setupacc
echo.
node setup-account.js
echo.
pause
goto menu

:refresh
echo.
node refresh-token.js
echo.
pause
goto menu

:run
echo.
echo Freeing port 8787 and starting... dashboard opens in your browser.
echo (Close this window to stop the proxy / 关闭本窗口即停止代理)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
node server.js
echo.
echo Proxy stopped.
pause
goto menu
