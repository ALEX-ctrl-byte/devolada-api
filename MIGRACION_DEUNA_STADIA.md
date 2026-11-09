# DeUna: rutas y geocodificación con Stadia Maps

## Qué cambia en la API

- Los cálculos de ruta se realizan con Stadia Maps Routing API (motor Valhalla) a través de `src/servicios/rutasStadia.js`.
- Se solicita el formato de respuesta compatible con OSRM para conservar el contrato interno `{ distancia_m, duracion_estimada_s, geometria }` consumido por viajes, pedidos, envíos y tarifas.
- La búsqueda y geocodificación inversa también se realiza desde el backend con Stadia Maps: `GET /ubicaciones/buscar?texto=...&lat=...&lng=...` y `GET /ubicaciones/inversa?lat=...&lng=...`.
- La clave no se inserta en Android. El backend la envía en el encabezado `Authorization: Stadia-Auth ...`.
- `STADIA_ROUTING_URL` es opcional y por defecto usa `https://api.stadiamaps.com/route/v1`.

## Variables de entorno

```dotenv
STADIA_MAPS_API_KEY=TU_CLAVE_STADIA
STADIA_ROUTING_URL=https://api.stadiamaps.com/route/v1
```

Añade estas variables a `.env` local y a las variables del servicio desplegado. No publiques `.env` ni pongas la clave en el código de Android o en GitHub. Las antiguas variables `OSRM_BASE_URL` se ignoran en esta versión y se pueden eliminar del entorno después de confirmar que no las utiliza otra herramienta.

## Plan y costes

La API de rutas requiere que el plan contratado en Stadia Maps permita usar el endpoint estándar. La tabla pública actual anuncia créditos por solicitud para rutas y planes con distintos niveles de acceso; confirma en el panel de tu cuenta y durante la prueba de 14 días el permiso exacto para routing antes de desplegarlo en producción. La API usa créditos de Stadia; revisa los límites del plan y el volumen de tiles/autocompletado, porque las consultas de direcciones y cada tesela de mapa consumen créditos por separado.

## Contrato interno conservado

El servicio devuelve:

- `distancia_m`: distancia de ruta en metros.
- `duracion_estimada_s`: duración estimada en segundos.
- `geometria`: GeoJSON `LineString` con coordenadas `[longitud, latitud]`.

Los controladores de viajes, pedidos y envíos siguen usando este resultado, de modo que no se cambian las fórmulas tarifarias en esta etapa. La API verifica los datos de ruta recibidos antes de usarlos.

## Siguiente etapa

Los mapas visuales de Android (`MapaScreen.kt` y `SelectorUbicacionComercio.kt`) aún deben migrarse del SDK visual de Mapbox a MapLibre. Esta migración de backend no retira todavía el SDK ni el token de Mapbox de Android. La verificación con WhatsApp Intent Link y aprobación manual tampoco se implementa en esta etapa.
