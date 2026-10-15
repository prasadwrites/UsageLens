@echo off
REM UsageLens — Start the server (Windows)
REM Runs inside WSL if available, otherwise uses native Python

setlocal
set PORT=%1
if "%PORT%"=="" set PORT=8000
set SCRIPT_DIR=%~dp0

echo =========================================
echo   UsageLens — System Usage Tracker
echo =========================================
echo.

REM Check if WSL is available
where wsl >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [INFO] Using WSL to run the server...
    echo.

    REM Convert Windows path to WSL path
    for /f "tokens=*" %%i in ('wsl wslpath "%SCRIPT_DIR%"') do set WSL_DIR=%%i

    echo [1/3] Installing dependencies if needed...
    wsl -e bash -lc "cd %WSL_DIR% && pip3 install --quiet fastapi uvicorn paramiko pyyaml filelock sse-starlette 2>/dev/null || pip3 install --quiet --break-system-packages fastapi uvicorn paramiko pyyaml filelock sse-starlette 2>/dev/null; echo Done"

    echo [2/3] Stopping any existing instance...
    wsl -e bash -lc "pkill -f 'uvicorn backend.server:app' 2>/dev/null; sleep 1; echo Done"

    echo [3/3] Starting server...
    wsl -e bash -lc "cd %WSL_DIR% && mkdir -p data && nohup python3 -m uvicorn backend.server:app --host 0.0.0.0 --port %PORT% > /tmp/usagelens.log 2>&1 & disown; echo PID: $!"

    echo.
    echo Waiting for server to start (this may take up to a minute)...

    REM Poll until server responds
    set /a TRIES=0
    :WAIT_LOOP
    if %TRIES% GEQ 60 goto WAIT_TIMEOUT
    timeout /t 1 /nobreak >nul
    wsl -e bash -lc "curl -s -o /dev/null -w '%%{http_code}' http://127.0.0.1:%PORT%/api/hosts 2>/dev/null" | findstr "200" >nul 2>&1
    if %ERRORLEVEL% EQU 0 goto SERVER_READY
    set /a TRIES=%TRIES%+1
    goto WAIT_LOOP

    :SERVER_READY
    echo.
    echo =========================================
    echo   Server is running!
    echo.
    echo   Open in browser: http://localhost:%PORT%
    echo.
    echo   To stop: stop.bat
    echo =========================================
    goto END

    :WAIT_TIMEOUT
    echo.
    echo [WARNING] Server may still be starting.
    echo Check: http://localhost:%PORT%
    echo Log:   wsl -e bash -lc "tail -20 /tmp/usagelens.log"
    goto END

) else (
    REM No WSL — try native Python
    echo [INFO] WSL not found, using native Python...
    echo.

    where python >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Python not found. Install Python 3.8+ or WSL.
        goto END
    )

    echo [1/2] Installing dependencies...
    pip install --quiet fastapi uvicorn paramiko pyyaml filelock sse-starlette

    echo [2/2] Starting server on http://0.0.0.0:%PORT% ...
    echo   Press Ctrl+C to stop.
    echo.
    if not exist "%SCRIPT_DIR%data" mkdir "%SCRIPT_DIR%data"
    python -m uvicorn backend.server:app --host 0.0.0.0 --port %PORT%
)

:END
endlocal
