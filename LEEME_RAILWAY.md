# Despliegue de De Volada en Railway

Arquitectura: **1 servicio API** (este repositorio) + **1 servicio MySQL** de Railway.
La API ya trae `railway.json` (comando de inicio, health check `/salud`, reinicio automático).

## 1. Subir a GitHub
```bash
git init && git add . && git commit -m "De Volada API listo para Railway"
git branch -M main && git remote add origin <TU_REPO> && git push -u origin main
```
`.env` y los dumps con datos reales están en `.gitignore`.

## 2. Crear el proyecto en Railway
1. **New Project → Deploy from GitHub repo** → elige el repositorio.
2. En el mismo proyecto: **+ New → Database → Add MySQL**.
3. Abre el servicio de la API → **Variables → Raw Editor** → pega el contenido de `railway.variables.example`
   y completa lo marcado `<<< CAMBIAR >>>`.
   *No hace falta `PORT`: Railway lo inyecta.*
4. **Settings → Networking → Generate Domain** (o **Custom Domain** → `api.usadevolada.com` y crea el CNAME
   que Railway indique; si usas Cloudflare, déjalo en "DNS only" hasta que el certificado esté activo).

## 3. Cargar la base de datos (una sola vez)
El archivo `devolada_railway.sql` (entregado aparte, **no va a GitHub** porque trae datos reales) ya contiene
el esquema completo **con todas las migraciones aplicadas**, triggers, el evento diario de mantenimiento y la vista.
**No ejecutes los archivos de `sql/`** (son migraciones históricas) y **nunca** `limpiar_base_dejar_admin.sql`.

1. En el servicio MySQL → **Variables** → copia `MYSQL_PUBLIC_URL`
   (`mysql://root:…@…proxy.rlwy.net:PUERTO/railway`).
2. Desde tu PC, en la carpeta del proyecto (`npm install` una vez):

   PowerShell:
   ```powershell
   $env:DATABASE_URL = "<MYSQL_PUBLIC_URL>"
   npm run importar:sql -- C:\ruta\devolada_railway.sql
   ```
   Bash:
   ```bash
   DATABASE_URL="<MYSQL_PUBLIC_URL>" npm run importar:sql -- ./devolada_railway.sql
   ```
   Alternativa con el cliente mysql: `mysql -h <HOST> -P <PUERTO> -u root -p railway < devolada_railway.sql`

   El importador se niega a correr si la base ya tiene tablas (usa `--forzar` solo si sabes lo que haces).
3. Verifica: `npm run doctor` con la misma `DATABASE_URL` debe mostrar todo `ok: true`.

## 4. Verificar
- `https://<tu-dominio>/salud` → `{"ok":true, ... "base_datos":"conectada"}`.
- Logs del servicio: si falta una variable obligatoria, la API no arranca y lista exactamente cuáles.

## Archivos (documentos de conductores e imágenes de comercios)
- **Sigues con Spaces** (`ALMACENAMIENTO_DRIVER=s3`): los archivos ya subidos siguen funcionando, porque la base
  guarda solo los nombres. Es lo más simple si ya tienes datos.
- **Volume de Railway** (`ALMACENAMIENTO_DRIVER=disco`): servicio API → **Settings → Volumes → Add** con Mount Path `/data`.
  La API usa `/data/documentos` y `/data/comercios` automáticamente. Los archivos existentes en Spaces **no** se copian solos.
  Un servicio con Volume no puede tener varias réplicas.

## Notas
- Usuario MySQL `root`: Railway no ofrece otro y la conexión va por red privada (`mysql.railway.internal`, sin TLS); la API lo admite en Railway.
- Socket.IO funciona por WebSocket (soportado por Railway); sin cambios.
- Los datos importados incluyen cuentas de prueba (admin, pasajero, conductores) y sesiones activas del dump. Si lanzas
  desde cero, cambia el PIN del admin (`herramientas/pin-admin.mjs`) y revoca sesiones.
- `docs/digitalocean/` conserva la guía y el `app.yaml` anteriores por si los necesitas.
