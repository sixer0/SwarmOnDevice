@echo off
setlocal DisableDelayedExpansion
set "NoDefaultCurrentDirectoryInExePath=1"
rem datum-studio-launcher (Windows, spec 114 section 5.4, decision L26). Exit 3: Swarm not running; exit 4: bundle incomplete.
rem Line 3 stops cmd.exe from searching the current folder; every external tool below is called by its full System32 path.
set "dir=%~dp0"
set "runtime=%dir%..\swarm-cli\swarm.exe"
if not exist "%runtime%" goto incomplete
if not exist "%dir%server\datum-studio-bridge.js" goto incomplete
set "state=%SWARM_APP_STATE_HOME%"
if not defined state set "state=%XDG_STATE_HOME%"
if not defined state goto notrunning
set /a tries=0
:wait
call :alive "%state%\swarm\datum-studio.env" && goto run
call :alive "%state%\swarm\app-server.env" || goto notrunning
set /a tries+=1
if %tries% GEQ 15 goto notrunning
"%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
goto wait
:run
set "DATUM_STUDIO_STATE=%state%"
set "DATUM_STUDIO_CALLER_CWD=%CD%"
if not defined STUDIO_AGENT_ID set "STUDIO_AGENT_ID=claude"
set "BUN_BE_BUN=1"
set "HTTP_PROXY=" & set "HTTPS_PROXY=" & set "ALL_PROXY=" & set "http_proxy=" & set "https_proxy=" & set "all_proxy="
cd /d "%dir%server" || exit /b 4
"%runtime%" .\datum-studio-bridge.js
exit /b %ERRORLEVEL%
:alive
set "pid="
if not exist "%~1" exit /b 1
for /f "tokens=2 delims==" %%p in ('^""%SystemRoot%\System32\findstr.exe" /B /C:"PID=" "%~1"^"') do set "pid=%%p"
if not defined pid exit /b 1
setlocal EnableDelayedExpansion
for /f "delims=0123456789" %%x in ("!pid!") do (endlocal & exit /b 1)
endlocal
"%SystemRoot%\System32\tasklist.exe" /FI "PID eq %pid%" /FI "IMAGENAME eq Swarm.exe" /NH /FO CSV | "%SystemRoot%\System32\findstr.exe" /B /I /C:"\"Swarm.exe\"" >nul
exit /b %ERRORLEVEL%
:incomplete
echo DATUM Studio is not bundled with this app. Reinstall Swarm. 1>&2
exit /b 4
:notrunning
echo DATUM Studio runs inside the Swarm app. Start Swarm, then reconnect this MCP server (Claude Code: /mcp). 1>&2
exit /b 3
