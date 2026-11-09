# DeUna API — Etapa 9 (tiempo real)

Versión 0.6.0. Agrega **Socket.IO** a la API de la Etapa 8 sin cambiar el esquema de la base de datos
(no hay migración SQL) ni los contratos de las rutas existentes.

## Instalar (Windows / Laragon)
1. Copia tu carpeta actual `deuna-api` como respaldo y copia sobre ella el contenido de este ZIP (conserva tu `.env`).
2. En la carpeta `deuna-api`:
   ```powershell
   npm install
   npm run check
   npm run dev
   ```
3. En la consola debe aparecer `Tiempo real (Socket.IO): activo`.
4. Si usas túnel de Cloudflare, el mismo túnel sirve para Socket.IO (usa WebSocket sobre HTTPS). No hay puerto nuevo.

## Cómo funciona (y por qué es seguro)
El servidor sigue siendo la **única fuente de verdad**. Todos los cambios (aceptar, iniciar, finalizar, enviar
ubicación…) siguen entrando por las rutas REST de la Etapa 8, que ya validan rol, estado, GPS simulado, radio y saldo.
Cuando el cambio queda confirmado en MySQL, la ruta **avisa** por el socket a las personas autorizadas.
Los clientes **no pueden emitir** estados ni ubicaciones por el socket; solo reciben.

- **Autenticación:** el socket exige el mismo token de sesión de la API (`auth: { token }`); se valida contra la tabla
  `sesiones` (hash, no revocada, no vencida) y que la cuenta esté `activo`.
- **Privacidad:** la posición del conductor solo llega a quienes participan en ese viaje (sala `viaje:{id}`), solo mientras
  está en `aceptado`, `conductor_llego` o `en_curso`, y nunca si la ubicación viene marcada `es_mock`.
  Al terminar o cancelar el viaje, las conexiones salen de la sala.
- **Ofertas:** una solicitud nueva solo se avisa a conductores aprobados, disponibles, con GPS reciente y real,
  dentro del radio (`radio_busqueda_km`), los mismos criterios que `GET /viajes/ofertas`. El aviso solo lleva el id del viaje;
  el conductor consulta `GET /viajes/ofertas`, que valida todo de nuevo.
- **Cerrar sesión:** `POST /sesion/cerrar` corta también los sockets de esa sesión.
- **Anti-abuso:** tope de 30 eventos/minuto por conexión, mensajes de máximo 10 KB.

## Eventos que recibe la app
| Evento | Datos | Cuándo |
|---|---|---|
| `listo` | `{ usuario_id }` | Al conectar. |
| `oferta:nueva` | `{ viaje_id }` | Hay una solicitud cerca (solo conductores elegibles). |
| `oferta:cerrada` | `{ viaje_id }` | La solicitud la tomó otro conductor o se canceló. |
| `viaje:estado` | `{ viaje_id, estado, cancelado_por? }` | Cada cambio de estado del viaje. La app pide el detalle a `GET /viajes/:id`. |
| `viaje:ubicacion` | `{ viaje_id, lat, lng, rumbo, t }` | Posición del conductor durante el viaje. |

Cliente → servidor: solo `viaje:unirse(viaje_id, ack)` (opcional; el servidor ya junta a los participantes solo).

## Cambios en rutas existentes
- `POST /viajes/ubicacion-conductor`: si el conductor tiene un viaje activo, la misma ubicación se guarda en
  `ubicaciones_viaje` y se envía al pasajero. La respuesta incluye `viaje_id` (o `null`). Así el servicio en segundo plano de la
  app no necesita conocer el id del viaje. `POST /viajes/:id/ubicacion` sigue funcionando igual.
- `POST /viajes`, `/:id/aceptar`, `/llegada`, `/confirmar-casco`, `/iniciar`, `/finalizar`, `/cancelar` y `/sesion/cerrar`
  ahora avisan por el socket después de confirmar el cambio.

## Prueba automática
`npm run probar:tiempo-real` levanta tu API contra una base **temporal** (`deuna_prueba_tiempo_real`, se crea y se borra sola;
no toca la base `deuna`) y simula un pasajero, dos conductores cercanos, uno lejano y un intruso. Necesita MySQL encendido
y `DB_USER`/`DB_PASSWORD` en `.env`. Verifica 27 puntos: autenticación, ofertas, aceptación, posición en vivo, privacidad,
reconexión, ciclo completo, cancelación y cierre de sesión.

> La base temporal imita las tablas y columnas que usa la API (tomadas de tu código); **no es tu esquema v2**. Antes de
> producción, repite el ciclo completo contra tu base real con dos teléfonos.

## Límites conocidos
- Una sola instancia de la API: las salas viven en memoria. Si algún día usas varias instancias, hará falta el adaptador de Redis.
- Si el socket se cae, la app sigue funcionando con consultas periódicas (cada 4 s); no se pierde ninguna operación.
- Los viajes en estado `solicitado` sin conductor no expiran solos todavía (no existe tarea de expiración en la Etapa 8).
