> **Despliegue en producción: ver [LEEME_RAILWAY.md](LEEME_RAILWAY.md).**

# DeUna API — versión de trabajo 0.7.1 (Node.js)

API REST con Node.js 18+, Express y MySQL. Android nunca se conecta directo a la base de datos.

## Diagnóstico antes de conectar Android
1. No importes `sql/deuna_completo_laragon.sql` sobre una base que ya tiene datos: contiene `DROP DATABASE IF EXISTS deuna`.
2. Selecciona `deuna` en phpMyAdmin y ejecuta `sql/auditoria_estructura_deuna.sql` (solo lectura).
3. Copia `.env.example` a `.env` y confirma `DB_NAME=deuna`.
4. Ejecuta `npm install`, `npm run check` y `npm run doctor`. El diagnóstico solo consulta la base; no la modifica.

## Puesta en marcha
1. Asegúrate de que MySQL de Laragon esté corriendo y la base `deuna` esté importada.
2. En esta carpeta: `npm install`
3. Revisa `.env` (por defecto: MySQL 127.0.0.1, usuario `root`, sin clave, base `deuna`, puerto 3000).
4. `npm run dev` (reinicia solo al guardar cambios) o `npm start`.
5. Abre http://localhost:3000/salud

## Endpoints
| Método | Ruta      | Descripción                           |
|--------|-----------|---------------------------------------|
| GET    | /salud    | Estado de la API y la base de datos   |
| GET    | /api/health | Alias de salud para diagnóstico |
| POST   | /otp/solicitar | Genera OTP para `login` o `registro` |
| POST   | /otp/verificar | Para registro entrega un ticket temporal; para login entrega la sesión |
| POST   | /registro | Crea la cuenta verificada con los datos y el ticket tras el OTP |
| GET    | /yo       | Usuario de la sesión actual (requiere `Authorization: Bearer <token>`) |
| POST   | /sesion/cerrar | Revoca el token actual (requiere token) |
| GET    | /ciudades | Lista de ciudades activas |
| PUT    | /perfil   | Completa ciudad, fecha de nacimiento y sexo (requiere token) |
| GET    | /comercios | Directorio público de comercios aprobados con saldo de comisión disponible |
| GET    | /comercios/:id/productos | Catálogo público de un comercio publicado |
| POST   | /pedidos | Crea un pedido, calcula delivery, congela precios y reserva comisión del comercio |
| GET    | /pedidos/mios | Pedidos del pasajero actual |
| GET    | /pedidos/comercio/mios | Bandeja de pedidos del comercio |
| POST   | /pedidos/:id/comercio/confirmar-pago-producto | El comercio registra manualmente que verificó el QR en su banco |
| POST   | /pedidos/:id/comercio/aceptar | Acepta la venta y solicita repartidor |
| POST   | /pedidos/:id/comercio/entregar-a-repartidor | Confirma entrega física del pedido al conductor |
| GET    | /pedidos/conductor/ofertas | Delivery disponible cerca del conductor elegible |
| POST   | /pedidos/:id/aceptar | Conductor acepta y reserva su comisión |
| POST   | /pedidos/:id/iniciar | Inicia reparto tras confirmar recogida |
| POST   | /pedidos/:id/confirmar-cobro-delivery | Registra recepción de efectivo o QR verificado por el conductor |
| POST   | /pedidos/:id/finalizar | Finaliza el reparto y descuenta las comisiones una sola vez |

## Probar el flujo de autenticación

No llames a `/registro` antes de verificar el número. El flujo nuevo se inicia solicitando el OTP con `proposito: "registro"`; después verifica ese código y finalmente envía el ticket temporal junto con los datos personales y el rol. Los cuerpos exactos y el orden de las llamadas están en [README_FLUJO_AUTENTICACION.md](README_FLUJO_AUTENTICACION.md).

Para comprobar primero la API y MySQL abre `http://localhost:3000/salud` o `http://localhost:3000/api/health`. Si ambas rutas devuelven `NO_ENCONTRADO`, la solicitud está llegando a otro proceso o puerto, o el proceso que corre es una versión anterior del proyecto.

## Pagos directos y delivery

El flujo de pedidos y delivery se describe en `../LEER_PRIMERO_PEDIDOS_COMISIONES.md`. Los métodos QR muestran la imagen estática del QR bancario del comercio o del conductor y requieren verificación manual de la entrada real en su banco; no existe un webhook bancario conectado en este paquete. La ruta `POST /pedidos/:id/finalizar` descuenta las comisiones prepago del comercio y del conductor en una transacción idempotente.

## Formato de respuestas
- Éxito: `{ "ok": true, "datos": {...} }`
- Error: `{ "ok": false, "error": { "codigo": "...", "mensaje": "...", "detalles": {...} } }`

## Desde el emulador de Android
El emulador accede a tu PC con `http://10.0.2.2:3000/` (no con `localhost`).
Si lo pruebas desde un celular real, usa la IP de tu PC en la red WiFi y permite el puerto 3000 en el Firewall de Windows.

## Etapa 4: verificación por OTP y sesión
- En desarrollo el código **aparece en la terminal de la API** (`OTP_PROVEEDOR=consola`). Cuando se elija
  proveedor (WhatsApp/SMS), solo se agrega un caso en `src/servicios/enviarOtp.js`.
- Los códigos se guardan como HMAC (nunca en claro); los tokens de sesión, como SHA-256.
- Límites (tabla `configuracion`): 5 envíos por hora, 60 s entre envíos, 5 intentos por código, vigencia 5 min.
- `/otp/solicitar` recibe el propósito explícito `login` o `registro`; un celular nuevo puede solicitar OTP en el flujo de registro.
- Para completar registro, `/otp/verificar` devuelve un ticket firmado con vencimiento de 15 minutos. La cuenta solo se crea cuando `/registro` recibe ese ticket y los datos requeridos.
- El código se firma con HMAC sobre `telefono|proposito|codigo`; los códigos anteriores se marcan con `invalidado_en`.

### Probar con curl (PowerShell)
```powershell
curl.exe -X POST http://localhost:3000/otp/solicitar -H "Content-Type: application/json" -d "{\"telefono\":\"71234567\"}"
# mira el código en la terminal de la API, luego:
curl.exe -X POST http://localhost:3000/otp/verificar -H "Content-Type: application/json" -d "{\"telefono\":\"71234567\",\"codigo\":\"123456\"}"
# usa el token recibido:
curl.exe http://localhost:3000/yo -H "Authorization: Bearer TU_TOKEN"
```

## Etapa 5: perfil y límites anti-abuso
- La base de datos de referencia es el **esquema v2** del proyecto (ya incluye ciudades, fecha de nacimiento,
  sexo, ciudad e IP de registro). No hay scripts de migración.
- Tras verificar el teléfono, el formulario de registro solicita nombre, apellido, correo, fecha de nacimiento,
  sexo (`femenino` | `masculino` | `prefiero_no_decir`) y aceptación de términos. La ciudad se completa a continuación
  en el perfil (`PUT /perfil`); se guarda fecha y versión de los términos en `acepto_terminos_en` / `version_terminos`.
- Se guarda la **fecha** de nacimiento; la edad se calcula al consultar (sirve para estadísticas por rango).
- Edad mínima configurable en la tabla `configuracion` (`edad_minima`, 18 provisional).
- Límites: registros por IP/hora, códigos por IP/hora y tope diario global de códigos.
  Las IP de redes móviles suelen compartirse entre muchas personas, por eso los límites son holgados.


## Rutas y búsqueda de direcciones: Stadia Maps

La API usa Stadia Maps para calcular rutas (motor Valhalla, solicitando formato compatible con OSRM) y para geocodificación/autocompletado. Configura `STADIA_MAPS_API_KEY` y, de forma opcional, `STADIA_ROUTING_URL` según [MIGRACION_DEUNA_STADIA.md](MIGRACION_DEUNA_STADIA.md). La clave se utiliza solo en el backend. Verifica en el panel de Stadia Maps que el plan de tu cuenta permita la API de rutas antes de producción. La migración de la representación visual Android a MapLibre todavía debe completarse. El ZIP no incluye `.env` ni `node_modules`.

## Panel web React (administración)

La API incluye además `GET /admin/resumen` y `GET /admin/auditoria`, ambos protegidos por una sesión válida con rol `admin`. El CORS del panel se limita a `ADMIN_WEB_ORIGIN` y, en desarrollo, a localhost:5173/4173.

Para desarrollo, coloca `ADMIN_WEB_ORIGIN=http://localhost:5173` en `.env`. Para producción, define el origen HTTPS exacto del panel. No se permite usar administradores creados desde endpoints públicos: el rol se asigna directamente en base de datos a una cuenta de confianza.


## OTP por WhatsApp Cloud API
- Por defecto `OTP_PROVEEDOR=consola`: sirve únicamente para pruebas locales y muestra el código en la terminal.
- Para enviar OTP real, se requiere una cuenta de Meta Business, un número habilitado para WhatsApp Cloud API, un token vigente, el ID del número y una plantilla aprobada compatible con la variable de código. Sin esas credenciales no es posible enviar mensajes reales.
- Configura `OTP_PROVEEDOR=whatsapp`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_OTP_TEMPLATE` y `WHATSAPP_OTP_LANGUAGE` en `.env`. Nunca pongas el token de Meta dentro de Android ni lo subas al repositorio.
- La API llama a WhatsApp desde el servidor; el túnel Cloudflare sigue siendo la URL HTTPS que consume Android y no reemplaza las credenciales del proveedor.
- Primero valida el flujo local con `consola`, luego configura WhatsApp y prueba con un número de destino autorizado. Revisa también la plantilla aprobada en Meta.
