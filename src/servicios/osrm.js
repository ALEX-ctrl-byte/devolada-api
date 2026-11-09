import { config } from '../config.js';

/** Calcula una ruta por calles con OSRM. Coordenadas de entrada y GeoJSON siguen lng,lat. */
export async function obtenerRutaOSRM(origen, destino) {
  const validar = (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
    && Number(p.lat) >= -90 && Number(p.lat) <= 90
    && Number(p.lng) >= -180 && Number(p.lng) <= 180;
  if (!validar(origen) || !validar(destino)) {
    const e = new Error('Las coordenadas de origen o destino no son válidas.');
    e.codigo = 'COORDENADAS_INVALIDAS';
    e.estadoHttp = 422;
    throw e;
  }

  const base = config.osrmBaseUrl;
  if (!base) {
    const e = new Error('Falta configurar OSRM_BASE_URL.');
    e.codigo = 'OSRM_NO_CONFIGURADO';
    e.estadoHttp = 503;
    throw e;
  }

  const coordenadas = `${Number(origen.lng)},${Number(origen.lat)};${Number(destino.lng)},${Number(destino.lat)}`;
  const url = new URL(`${base}/route/v1/driving/${coordenadas}`);
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('steps', 'false');
  url.searchParams.set('alternatives', 'false');

  let respuesta;
  try {
    respuesta = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/json' } });
  } catch {
    const e = new Error('No se pudo conectar con el servicio de rutas OSRM.');
    e.codigo = 'OSRM_NO_DISPONIBLE';
    e.estadoHttp = 502;
    throw e;
  }

  let json;
  try { json = await respuesta.json(); } catch { json = null; }
  if (!respuesta.ok || !json || json.code !== 'Ok' || !json.routes?.[0]) {
    const noRuta = json?.code === 'NoRoute' || json?.code === 'NoSegment';
    const e = new Error(noRuta
      ? 'OSRM no encontró una ruta entre esos puntos.'
      : 'OSRM no pudo calcular la ruta. Verifica el servicio y las coordenadas.');
    e.codigo = noRuta ? 'RUTA_NO_DISPONIBLE' : 'OSRM_ERROR';
    e.estadoHttp = noRuta ? 422 : 502;
    throw e;
  }

  const ruta = json.routes[0];
  const coordenadasRuta = ruta.geometry?.coordinates;
  if (!Array.isArray(coordenadasRuta) || coordenadasRuta.length < 2
      || !Number.isFinite(ruta.distance) || !Number.isFinite(ruta.duration)
      || coordenadasRuta.some((p) => !Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
    const e = new Error('OSRM devolvió una ruta incompleta o inválida.');
    e.codigo = 'RUTA_INVALIDA';
    e.estadoHttp = 502;
    throw e;
  }

  return {
    distancia_m: Math.max(1, Math.round(ruta.distance)),
    duracion_estimada_s: Math.max(1, Math.round(ruta.duration)),
    geometria: { type: 'LineString', coordinates: coordenadasRuta },
  };
}
