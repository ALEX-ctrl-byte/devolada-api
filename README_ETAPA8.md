> **Documento histórico:** describe la integración anterior con Mapbox. Ya no es la guía de configuración vigente. Para la configuración actual usa `MIGRACION_MAPAS_OSRM_STADIA.md` y `README.md`.

# DeUna API — Etapa 7/8 (Mapbox + viajes)

Esta entrega amplía la API REST Node.js/Express de DeUna con cotización por ruta de Mapbox y el ciclo principal de viajes, usando los nombres de tabla y estados del esquema `deuna_v2.sql` compartido para el proyecto.

## Requisitos

- Node.js 18 o superior (recomendado Node 20 LTS).
- MySQL 8.0.16 o superior y la base de datos `deuna` ya creada con el esquema v2.
- Token público de Mapbox (`pk...`) con acceso a la API Directions. No lo pegues en el chat ni lo subas a Git.

## Instalación en Windows / Laragon

1. Haz una copia de seguridad de tu carpeta actual `deuna-api`.
2. Extrae esta carpeta `deuna-api` en la misma ubicación de trabajo, o copia su contenido sobre la carpeta del proyecto después de hacer la copia de seguridad.
3. Copia `.env.example` a `.env`.
4. Edita `.env`: indica tu configuración MySQL y `MAPBOX_ACCESS_TOKEN=pk...`. Para producción, cambia `OTP_SECRET` por una clave larga y aleatoria, establece `NODE_ENV=production` y no compartas `.env`.
5. Abre CMD o PowerShell en la carpeta `deuna-api` y ejecuta:

   ```powershell
   npm install
   npm run check
   npm run dev
   ```

6. Abre `http://localhost:3000/salud`. Si la ruta de salud devuelve `ok: true`, el servidor está escuchando. Esto por sí solo no prueba que Mapbox y MySQL estén listos; se deben probar también las rutas autenticadas.

> Importante: este ZIP excluye `.env` y `node_modules`. No incluye ni ejecuta un SQL destructivo. No ejecutes de nuevo el archivo de esquema si ya tienes datos que quieres conservar: su primera sentencia borra y recrea la base `deuna`.

## Autenticación

Salvo `/salud`, las rutas de viajes requieren `Authorization: Bearer <token-de-sesion>` emitido por el flujo de sesión existente. El cuerpo de las respuestas conserva el formato de la API:

- Correcto: `{ "ok": true, "datos": ... }`
- Error: `{ "ok": false, "error": { "codigo": ..., "mensaje": ... } }`

## Endpoints de viajes

### Cotizar una ruta (requiere sesión)

`POST /viajes/cotizar`

```json
{
  "origen_lat": -16.5000,
  "origen_lng": -68.1500,
  "destino_lat": -16.5100,
  "destino_lng": -68.1200
}
```

Devuelve distancia en metros/kilómetros, duración estimada, geometría GeoJSON `LineString` (pares `[longitud, latitud]`), tarifa en Bs, comisión estimada y un `cotizacion_token` firmado por la API. La app puede usar `geometria.coordinates` para dibujar la ruta. El token expira según `validez_cotizacion_s`.

La tarifa inicial se calcula como `max(tarifa_base_bs, distancia_km * tarifa_por_km_bs)`. Es un cálculo provisional que usa los valores de `configuracion`; confirmar el modelo económico antes del lanzamiento. Con los valores iniciales del SQL (tarifa mínima Bs 5 y Bs 2/km), una ruta de 3.4 km cotiza Bs 6.80. No se incluye un componente por tiempo porque no existe una clave de tarifa por minuto en esa configuración.

### Crear el viaje

`POST /viajes`

```json
{
  "cotizacion_token": "TOKEN_DEVUELTO_POR_COTIZAR",
  "idempotency_key": "app-9f2a7f1c-001",
  "metodo_pago": "efectivo",
  "origen_direccion": "Av. ejemplo",
  "destino_direccion": "Plaza ejemplo"
}
```

Solo acepta solicitudes de cuentas con rol `pasajero`. La API verifica el token y su vencimiento, y guarda distancia, duración, tarifa, porcentaje de comisión y coordenadas calculados en el servidor. La tarifa y el porcentaje quedan protegidos por el trigger del esquema. La clave idempotente evita crear dos veces la misma solicitud.

### Consultar viajes

- `GET /viajes/mios` — últimos 30 viajes del usuario autenticado.
- `GET /viajes/:id` — detalle, solo si el usuario es el pasajero o el conductor asignado.

### Conductor y viaje activo

- `POST /viajes/ubicacion-conductor` — actualiza la posición del conductor autenticado. Body: `latitud`, `longitud` y opcionalmente `precision_m`, `rumbo_grados`, `es_mock`.
- `POST /viajes/:id/aceptar` — acepta un viaje solicitado si el conductor está aprobado y disponible, tiene los documentos vigentes y moto, ubicación reciente no marcada como simulada, está dentro del radio de despacho, y el saldo cubre comisión y mínimo operativo.
- `POST /viajes/:id/ubicacion` — registra la ubicación durante el viaje y actualiza la última ubicación del conductor. Solo el conductor asignado.
- `POST /viajes/:id/llegada` — marca la llegada si la ubicación reportada está dentro de la tolerancia configurada.
- `POST /viajes/:id/confirmar-casco` — acción del pasajero cuando confirma que recibió el casco.
- `POST /viajes/:id/iniciar` — exige estado `conductor_llego` y confirmación del casco.
- `POST /viajes/:id/finalizar` — exige estado `en_curso` y que la ubicación reportada esté dentro de la tolerancia del destino. Congela los importes finales calculados y libera el estado operativo del conductor.
- `POST /viajes/:id/cancelar` — permite cancelar según los estados válidos del trigger; no permite cancelar un viaje en curso. Motivo opcional: `{ "motivo": "..." }`.

## Ejemplo de prueba de integración

Necesitarás un token de sesión real generado desde el flujo existente de la API y coordenadas con rutas válidas. En PowerShell, establece el token como variable local (no lo añadas al código fuente):

```powershell
$token = "TOKEN_DE_SESION"
$headers = @{ Authorization = "Bearer $token" }
$body = @{
  origen_lat = -16.5000
  origen_lng = -68.1500
  destino_lat = -16.5100
  destino_lng = -68.1200
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/viajes/cotizar" -Headers $headers -ContentType "application/json" -Body $body
```

Usa el `cotizacion_token` devuelto para la solicitud a `POST /viajes`. Para probar aceptar/iniciar/finalizar hace falta una segunda sesión con rol `conductor`, una postulación aprobada, documentos vigentes, moto, billetera activa y ubicación dentro del radio/tolerancia.

## Alcance y límites de esta etapa

- La API calcula rutas con Mapbox Directions en el servidor; no puede verificar un token real hasta que lo configures.
- Requiere que el esquema v2 exista y que tenga las tablas, trigger y claves indicadas. Se hizo comprobación sintáctica del código JavaScript; antes de producción deben realizarse pruebas de integración contra tu instancia MySQL y tu token Mapbox.
- La finalización del viaje calcula `tarifa_final`, `comision_monto` y `ganancia_conductor`, pero **no descuenta comisión de la billetera ni crea el asiento en `movimientos_billetera`**. Esa operación debe integrarse en la etapa de billetera/pagos con transacción e idempotencia; no se debe tratar este ZIP como implementación completa de pagos.
- `es_mock` es una señal enviada por la app, no una detección infalible del servidor. La app debe detectar ubicación simulada donde el sistema operativo lo permita.
- La tarifa está marcada como provisional en el esquema. Revisa la fórmula comercial antes de producción.

## Rutas adicionales para la operación de conductores y el panel
- `POST /viajes/disponibilidad` con `{ "disponible": true|false }`: valida aprobación, moto, documentos vigentes, licencia, billetera, saldo mínimo y ubicación reciente antes de conectarse.
- `GET /viajes/ofertas`: lista solicitudes dentro del radio configurado para un conductor aprobado y disponible.
- `GET /admin/resumen`: devuelve conteos para el dashboard administrativo.
- `GET /admin/auditoria?limite=30&pagina=1`: devuelve eventos recientes de auditoría para lectura.

Las rutas administrativas requieren `Authorization: Bearer <token>` de una cuenta que tenga el rol `admin` en MySQL.

## Solución para “Falta MAPBOX_ACCESS_TOKEN”

Esta versión carga `.env` desde la raíz de esta carpeta `deuna-api`, incluso si Node se inicia desde otra carpeta. Al arrancar, la terminal muestra si encontró el archivo y si detectó un token público `pk.`; nunca imprime el valor del token.

1. Copia `.env.example` como `.env` en esta misma carpeta, junto a `package.json`.
2. En `.env`, cambia la línea de Mapbox por `MAPBOX_ACCESS_TOKEN=pk.TU_TOKEN_PUBLICO_REAL`.
3. Detén el servidor anterior con `Ctrl+C`. Ejecuta `npm run dev` desde esta carpeta del ZIP nuevo.
4. Verifica en la terminal que aparezca `Archivo .env: cargado` y `Mapbox Directions: token público configurado`.
5. Si esas líneas salen bien pero Android aún muestra el error, está llamando a otra API/puerto/túnel: confirma que la URL configurada en Android apunta al servidor recién iniciado.

No compartas el archivo `.env` ni el valor del token.
