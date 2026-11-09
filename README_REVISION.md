# DeUna API — cambios de la revisión

- Base: `DeUna_API_Mapbox_ConfigFix_v2` (carga `.env` desde la raíz del proyecto).
- Nuevo `GET /viajes/activo`: viaje en curso del usuario (o `null`).
- `GET /viajes/:id` ahora incluye, solo mientras el viaje está activo: `conductor_telefono`, `conductor_lat`, `conductor_lng` (ubicación real y reciente, no simulada) y `moto_color`.
- `POST /viajes` ahora aplica `restringido_hasta` (antes se guardaba la restricción pero nunca se comprobaba) y responde `VIAJE_ACTIVO_EXISTENTE` con el id si ya hay un viaje activo.
- `GET /viajes/mios` incluye `ganancia_conductor` y `estado_operativo` del conductor.

Instalación: `npm install`, copiar `.env.example` a `.env`, `npm run check`, `npm run dev`.
