import { config } from '../config.js';

/** Obtiene una ruta real de Mapbox Directions. Las coordenadas de Mapbox se expresan lng,lat. */
export async function obtenerRutaMapbox(origen, destino) {
  const token = config.mapboxAccessToken;
  if (!token) {
    const e = new Error('Falta MAPBOX_ACCESS_TOKEN en el archivo .env.');
    e.codigo = 'MAPBOX_NO_CONFIGURADO';
    e.estadoHttp = 503;
    throw e;
  }

  const coordenadas = `${origen.lng},${origen.lat};${destino.lng},${destino.lat}`;
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordenadas}`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('steps', 'false');
  url.searchParams.set('alternatives', 'false');

  let respuesta;
  try {
    respuesta = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  } catch {
    const e = new Error('No se pudo conectar con el servicio de rutas de Mapbox.');
    e.codigo = 'MAPBOX_NO_DISPONIBLE';
    e.estadoHttp = 502;
    throw e;
  }

  let json;
  try {
    json = await respuesta.json();
  } catch {
    json = null;
  }
  if (!respuesta.ok || !json || json.code !== 'Ok' || !json.routes?.[0]) {
    const e = new Error('Mapbox no pudo calcular una ruta entre esos puntos. Revisa el token y las coordenadas.');
    e.codigo = 'RUTA_NO_DISPONIBLE';
    e.estadoHttp = respuesta.status === 401 || respuesta.status === 403 ? 502 : 422;
    throw e;
  }

  const r = json.routes[0];
  const coordinates = r.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !Number.isFinite(r.distance) || !Number.isFinite(r.duration)) {
    const e = new Error('Mapbox devolvió una ruta incompleta.');
    e.codigo = 'RUTA_INVALIDA';
    e.estadoHttp = 502;
    throw e;
  }
  return {
    distancia_m: Math.max(1, Math.round(r.distance)),
    duracion_estimada_s: Math.max(1, Math.round(r.duration)),
    geometria: { type: 'LineString', coordinates },
  };
}
