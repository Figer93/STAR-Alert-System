@echo off
cd /d %~dp0
echo Starting ST^&R Alert Dashboard...
"%LOCALAPPDATA%\Python\bin\python3.exe" -m backend.seed
start "ST&R Backend" cmd /k ""%LOCALAPPDATA%\Python\bin\python3.exe" -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload"
timeout /t 3 /nobreak >nul
start "ST&R Frontend" cmd /k "cd frontend && npm run dev"
timeout /t 4 /nobreak >nul
start "" "http://localhost:5173"
echo Dashboard started!
echo   Frontend: http://localhost:5173
echo   API:      http://localhost:8000/docs
