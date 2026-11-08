@echo off
REM One-click launcher for the TAGT SLE Flare Prediction web app (Windows).
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] Creating virtual environment...
    python -m venv .venv || goto :error
    echo [2/3] Installing dependencies - this takes a few minutes the first time...
    .venv\Scripts\python -m pip install --upgrade pip
    .venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cpu || goto :error
    .venv\Scripts\python -m pip install -r requirements-webapp.txt || goto :error
)

echo [3/3] Starting server at http://127.0.0.1:5000  (press Ctrl+C to stop)
start "" http://127.0.0.1:5000
.venv\Scripts\python webapp\app.py
goto :eof

:error
echo.
echo Setup failed. Make sure Python 3.10+ is installed and on PATH, then try again.
pause
