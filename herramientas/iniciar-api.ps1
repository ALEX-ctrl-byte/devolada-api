$ErrorActionPreference = "Stop"
if (!(Test-Path ".env")) { Write-Error "Falta .env. Copia .env.example a .env y configura DB_NAME=devolada." }
npm run dev
