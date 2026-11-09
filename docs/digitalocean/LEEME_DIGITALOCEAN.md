# De Volada API — despliegue en producción

API REST + Socket.IO (Node.js ≥ 18, Express y MySQL 8) para la app De Volada (transporte y delivery en La Paz y El Alto).

Arquitectura de bajo costo:
- **DigitalOcean App Platform**: la API (Basic, 512 MB, unos 5 USD al mes) y el panel admin como sitio estático (gratis).
- **DigitalOcean Managed MySQL**: la base de datos.
- **Cloudflare**: dominio, DNS, HTTPS, protección y WebSockets.

> Nombres internos que se conservan a propósito para no romper datos: la base `deuna`, la variable `QR_RECARGA_DEUNA_URL`, la ruta `/media/qr-recarga-deuna` y la clave interna `deuna-envios-pin`.

---

## 1. Base de datos MySQL administrada

1. En DigitalOcean, ve a **Databases → Create Database Cluster**, elige **MySQL 8**, región **NYC** y el plan más pequeño (`db-s-1vcpu-1gb`).
2. Crea una base llamada `deuna` y un usuario dedicado para la API. No uses `doadmin` en la app.
3. Si usas `.do/app.yaml`, el cluster `db` se crea y se vincula solo. La app recibe `${db.DATABASE_URL}` y `${db.CA_CERT}`.
4. En **Settings → Trusted Sources**, agrega la app de App Platform, y tu IP solo mientras ejecutes migraciones.

### Ejecutar las migraciones SQL

Primero se carga tu esquema base y después los archivos de `sql/migracion_*.sql`. Las migraciones están pensadas para poder repetirse sin problemas. El orden recomendado es:

```
migracion_etapa4.sql
migracion_etapa5_perfil.sql
migracion_registro_y_documentos.sql
migracion_billetera_deuna.sql
migracion_saldo_comision_y_qr_directo.sql
migracion_seguridad_pedidos_qr.sql
migracion_pedidos_comercio_delivery.sql
migracion_logo_url_empresas.sql
migracion_soporte_calificaciones_vehiculos_envios.sql
migracion_tarifas_dinamicas_enteras.sql
migracion_ciudades_lanzamiento.sql
migracion_aprobacion_manual_usuarios.sql
migracion_pin_login.sql
migracion_eliminacion_cuenta.sql
```

**Opción A: con `doctl` y el cliente `mysql`, desde tu PC.**

```bash
doctl auth init
doctl databases list                          # copia el ID del cluster
doctl databases connection <ID> --format Host,Port,User,Password
# Descarga el certificado CA desde el panel del cluster (botón "Download CA certificate").
for f in sql/migracion_etapa4.sql sql/migracion_pin_login.sql; do   # agrega aquí todos los archivos, en orden
  mysql -h <HOST> -P 25060 -u <USUARIO> -p --ssl-mode=REQUIRED --ssl-ca=ca-certificate.crt deuna < "$f"
done
```

**Opción B: desde la web.** El panel de DigitalOcean no trae un editor de consultas. Conéctate con MySQL Workbench, DBeaver o HeidiSQL usando los datos de **Connection Details** (puerto 25060 y SSL obligatorio) y ejecuta cada archivo en orden.

> No ejecutes `sql/limpiar_base_dejar_admin.sql` en producción: borra datos.

## 2. API en App Platform

### Desde la web de DigitalOcean
1. Sube este proyecto a un repositorio de GitHub. Puede ser privado.
2. Ve a **Apps → Create App → GitHub**, elige el repositorio y la rama `main`.
3. Tipo de componente: **Web Service**.
   - Build: `npm install --production`
   - Run: `npm start`
   - Puerto HTTP: `3000`
   - Plan: Basic, 512 MB (`basic-xxs`), con 1 instancia.
4. Health check: ruta HTTP `/salud`.
5. Pulsa **Add Resource → Database** y elige el cluster MySQL del paso 1.
6. Carga las variables de entorno de la sección 4. Marca las sensibles como **Encrypt**.
7. Pulsa **Create Resources**. Cada push a `main` vuelve a desplegar la API.

### Con la especificación incluida
```bash
doctl apps create --spec .do/app.yaml       # la primera vez
doctl apps update <APP_ID> --spec .do/app.yaml
```
Después de crear la app, vincula la fuente (GitHub) en el panel y reemplaza todos los valores `CAMBIAR...`.

### Panel admin (sitio estático gratuito)
En la misma app, pulsa **Add Component → Static Site** y usa la carpeta del panel:
- Build: `npm install && npm run build`
- Directorio de salida: `dist`

Define la URL de la API en sus variables de build, por ejemplo `VITE_API_URL=https://api.usadevolada.com`.

## 3. Cloudflare (dominio, HTTPS y WebSockets)

1. En Cloudflare, ve a **Add a site**, escribe tu dominio (`usadevolada.com`), elige el plan **Free** y cambia los nameservers en tu registrador.
2. En DigitalOcean, abre la app, entra en **Settings → Domains → Add Domain** y escribe `api.usadevolada.com`, y `panel.usadevolada.com` para el sitio estático. Elige **"You manage your domain"**.
3. En Cloudflare, ve a **DNS** y crea un registro `CNAME` por subdominio:
   - `api` → `<tu-app>.ondigitalocean.app`
   - `panel` → `<tu-app>.ondigitalocean.app`
4. Primero deja el proxy en **gris (DNS only)** hasta que DigitalOcean muestre el dominio como *Active* y emita el certificado. Después activa el **proxy naranja**.
5. En **SSL/TLS**, elige el modo **Full (strict)**.
6. En **Network**, deja **WebSockets: On**. Viene activado por defecto.
7. Opcional: en **Security → WAF**, activa una regla de límite de peticiones para `/entrar`.

La API ya está preparada para Cloudflare:
- En producción, Socket.IO usa solo WebSocket, con un latido cada 25 s y un margen de espera de 60 s.
- Con `TRUST_PROXY=true`, la API toma la IP real del cliente desde `X-Forwarded-For`.

## 4. Variables de entorno

| Variable | Producción | Descripción |
|---|---|---|
| `NODE_ENV` | `production` | Activa las validaciones de producción. |
| `PORT` | `3000` | DigitalOcean la inyecta; por defecto vale 3000. |
| `DATABASE_URL` | `${db.DATABASE_URL}` | Conexión MySQL. Tiene prioridad sobre `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` y `DB_PASSWORD`. |
| `DB_SSL` | `true` | TLS obligatorio en Managed MySQL. |
| `DB_CA_CERT` | `${db.CA_CERT}` | Certificado CA para verificar el servidor. Es opcional, pero se recomienda. |
| `TRUST_PROXY` | `true` | Hace falta detrás de Cloudflare y DigitalOcean. |
| `ADMIN_WEB_ORIGIN` | `https://panel.usadevolada.com` | Origen del panel. Se usa para CORS de la API REST. |
| `CORS_ORIGIN` / `FRONTEND_URL` | `https://panel.usadevolada.com` | Orígenes web extra para Socket.IO, separados por comas. |
| `PUBLIC_API_URL` | `https://api.usadevolada.com` | URL pública HTTPS de la API, sin barra final. |
| `OTP_PROVEEDOR` | `desactivado` | El inicio de sesión es con teléfono y PIN. No hay costo de SMS ni WhatsApp. |
| `OTP_SECRET` | secreto largo | Obligatorio en producción. Se usa para firmar datos internos. |
| `JWT_SECRET` | secreto largo | Reservado. La versión actual usa tokens de sesión guardados con hash y no lo lee. |
| `WHATSAPP_BUSINESS_NUMBER` | `591XXXXXXXXX` | Número que recibe las solicitudes de activación por WhatsApp. |
| `QR_RECARGA_DEUNA_URL` | URL HTTPS | Imagen del QR oficial para recargar puntos. |
| `OSRM_BASE_URL` | `https://router.project-osrm.org` | Cálculo de rutas. |
| `PUNTOS_POR_VIAJE` | `2` | Puntos que se descuentan por servicio completado. |
| `VERSION_TERMINOS` | `1.0` | Versión vigente de los términos y condiciones. |

Para generar un secreto: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

Si falta alguna variable obligatoria, la API no arranca en producción y lo indica en los logs (**Runtime Logs** en DigitalOcean).

## 5. PIN del administrador

El inicio de sesión del panel y de la app es **teléfono + PIN de 4 dígitos**. Para crear o restablecer el PIN del admin, ejecuta en tu PC, con `DATABASE_URL`, `DB_SSL` y `DB_CA_CERT` en `.env` apuntando a la base de producción (y tu IP en *Trusted Sources*):

```bash
npm install
node herramientas/pin-admin.mjs 71234567 2580
```

También se puede ejecutar desde la **Console** del componente `api` en App Platform, que ya tiene las variables cargadas.

No se aceptan PIN débiles como `1234` o `1111`. Luego, desde el panel, el admin asigna PIN a otros usuarios con el botón **Asignar PIN**.

## 6. Verificación

```bash
curl https://api.usadevolada.com/salud        # debe responder ok: true
npm run check                              # revisa la sintaxis
npm test                                   # pruebas
```

## Desarrollo local

```bash
cp .env.example .env      # en local: NODE_ENV=development, OTP_PROVEEDOR=consola, deja DATABASE_URL vacío
npm install
npm run dev
```
