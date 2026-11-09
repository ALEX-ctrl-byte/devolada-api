@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  if exist ".env.example" (
    echo Creando .env desde .env.example. Revisa la conexion a MySQL.
    copy ".env.example" ".env" >nul
  ) else (
    echo ERROR: No existe .env.example.
    pause
    exit /b 1
  )
)
if not exist "node_modules" (
  echo Instalando dependencias de la API...
  call npm install
  if errorlevel 1 (pause & exit /b 1)
)
call npm run check
if errorlevel 1 (pause & exit /b 1)
call npm run dev
pause
