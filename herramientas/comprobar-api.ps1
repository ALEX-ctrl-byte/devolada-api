$ErrorActionPreference = "Stop"
Write-Host "== De Volada: comprobación de entorno ==" -ForegroundColor Cyan
node --version
npm --version
if (!(Test-Path ".env")) { Copy-Item ".env.example" ".env"; Write-Host "Se creó .env desde .env.example. Revísalo antes de continuar." -ForegroundColor Yellow }
npm run check
Write-Host "Probando conexión con la base y tablas mínimas..." -ForegroundColor Cyan
npm run doctor
