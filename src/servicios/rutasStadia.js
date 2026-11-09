import { config } from '../config.js';

function errorRuta(mensaje, codigo = 'RUTAS_NO_DISPONIBLES', estadoHttp = 502) {
  const e = new Error(mensaje);
  e.codigo = codigo;
  e.estadoHttp = estadoHttp;
  return e;
}

function coordenadasValidas(p) {
  if (!p || p.lat === null || p.lat === undefined || p.lng === null || p.lng === undefined) return false;
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  return Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/**
 * Calcula una ruta con Stadia Maps Routing API (motor Valhalla).
 * Usa formato de respuesta compatible con OSRM para conservar el contrato interno
 * usado por viajes, pedidos, envíos y tarifas: { distancia_m, duracion_estimada_s, geometria }.
 * La clave solo se usa desde el backend mediante el encabezado Stadia-Auth.
 */
export async function obtenerRutaStadia(origen, destino) {
  if (!coordenadasValidas(origen) || !coordenadasValidas(destino)) {
    throw errorRuta('Las coordenadas de origen o destino no son válidas.', 'COORDENADAS_INVALIDAS', 422);
  }

  if (!config.stadiaMapsApiKey) {
    throw errorRuta('Falta configurar STADIA_MAPS_API_KEY para el cálculo de rutas.', 'RUTAS_NO_CONFIGURADAS', 503);
  }

  const url = new URL(config.stadiaRoutingUrl);
  url.searchParams.set('format', 'osrm');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('steps', 'false');

  let respuesta;
  try {
    respuesta = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(12_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Stadia-Auth ${config.stadiaMapsApiKey}`,
      },
      body: JSON.stringify({
        id: 'deuna-route',
        locations: [
          { lat: Number(origen.lat), lon: Number(origen.lng), type: 'break' },
          { lat: Number(destino.lat), lon: Number(destino.lng), type: 'break' },
        ],
        costing: 'auto',
      }),
    });
  } catch {
    throw errorRuta('No se pudo conectar con el servicio de rutas de Stadia Maps.');
  }

  let json;
  try { json = await respuesta.json(); } catch { json = null; }
  const ruta = Array.isArray(json?.routes) ? json.routes[0] : null;
  if (!respuesta.ok || !json || !ruta) {
    const mensajeProveedor = String(json?.message ?? json?.error ?? '').toLowerCase();
    const noRuta = json?.code === 'NoRoute' || json?.code === 'NoSegment'
      || /no route|no suitable edges|no path/.test(mensajeProveedor);
    if (noRuta) {
      throw errorRuta('Stadia Maps no encontró una ruta entre esos puntos.', 'RUTA_NO_DISPONIBLE', 422);
    }
    if (respuesta.status === 401 || respuesta.status === 403) {
      throw errorRuta('Stadia Maps rechazó la clave o el plan no permite usar la API de rutas. Revisa la cuenta y el plan contratado.', 'STADIA_RUTAS_NO_AUTORIZADAS', 502);
    }
    throw errorRuta('Stadia Maps no pudo calcular la ruta. Verifica el servicio y las coordenadas.', 'STADIA_RUTAS_ERROR', 502);
  }

  const distancia = Number(ruta.distance);
  const duracion = Number(ruta.duration);
  let geometria = ruta.geometry;
  if (typeof geometria === 'string') {
    try { geometria = JSON.parse(geometria); } catch { geometria = null; }
  }
  const coords = geometria?.coordinates;
  if (!Number.isFinite(distancia) || distancia <= 0
      || !Number.isFinite(duracion) || duracion <= 0
      || geometria?.type !== 'LineString'
      || !Array.isArray(coords) || coords.length < 2
      || coords.some((p) => !Array.isArray(p) || p.length < 2
        || !Number.isFinite(Number(p[0])) || !Number.isFinite(Number(p[1]))
        || Math.abs(Number(p[0])) > 180 || Math.abs(Number(p[1])) > 90)) {
    throw errorRuta('Stadia Maps devolvió una ruta incompleta o inválida.', 'RUTA_INVALIDA', 502);
  }

  return {
    distancia_m: Math.max(1, Math.round(distancia)),
    duracion_estimada_s: Math.max(1, Math.round(duracion)),
    geometria: {
      type: 'LineString',
      coordinates: coords.map(([lng, lat]) => [Number(lng), Number(lat)]),
    },
  };
}
