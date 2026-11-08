@echo off
rem swarm (Windows): the same engine and state as the app (spec 114 section 5.3, register R6.1).
setlocal DisableDelayedExpansion
set "dir=%~dp0"
if defined SWARM_APP_STATE_HOME set "XDG_STATE_HOME=%SWARM_APP_STATE_HOME%"
set "OPENCODE_EXPERIMENTAL_ICON_DISCOVERY=true"
set "OPENCODE_EXPERIMENTAL_FILEWATCHER=true"
if not defined SWARM_BUNDLED_PROVIDER if exist "%dir%bundled-provider.json" set /p SWARM_BUNDLED_PROVIDER=<"%dir%bundled-provider.json"
"%dir%swarm.exe" %*
exit /b %ERRORLEVEL%
