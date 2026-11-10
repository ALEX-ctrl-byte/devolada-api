import { config } from '../config.js';

function errorProveedor(mensaje, codigo = 'GEOCODIFICACION_NO_DISPONIBLE', estadoHttp = 502) {
  const e = new Error(mensaje);
  e.codigo = codigo;
  e.estadoHttp = estadoHttp;
  return e;
}

async function consultar(url) {
  if (!config.stadiaMapsApiKey) {
    throw errorProveedor('La búsqueda de direcciones aún no está configurada en el servidor.', 'GEOCODIFICACION_NO_CONFIGURADA', 503);
  }
  url.searchParams.set('api_key', config.stadiaMapsApiKey);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: 'application/geo+json, application/json' } });
  } catch {
    throw errorProveedor('No se pudo conectar con el servicio de búsqueda de direcciones.');
  }
  let json;
  try { json = await response.json(); } catch { json = null; }
  if (!response.ok || !json || !Array.isArray(json.features)) {
    throw errorProveedor('El servicio de búsqueda de direcciones no respondió correctamente.');
  }
  return json;
}

function etiqueta(feature) {
  const p = feature?.properties ?? {};
  return String(p.label ?? p.name ?? p.street ?? '').trim().slice(0, 255);
}

/** Autocompletado de direcciones: devuelve forma normalizada para la API de De Volada. */
export async function buscarDireccionesStadia(texto, cercaLat = null, cercaLng = null) {
  const q = String(texto ?? '').trim();
  if (q.length < 3 || q.length > 120) {
    throw errorProveedor('Escribe entre 3 y 120 caracteres para buscar una dirección.', 'CONSULTA_INVALIDA', 422);
  }
  const url = new URL('https://api.stadiamaps.com/geocoding/v2/autocomplete');
  url.searchParams.set('text', q);
  url.searchParams.set('lang', 'es');
  url.searchParams.set('boundary.country', 'BO');
  url.searchParams.set('size', '5');
  if (Number.isFinite(Number(cercaLat)) && Number.isFinite(Number(cercaLng))
      && cercaLat !== null && cercaLng !== null
      && Math.abs(Number(cercaLat)) <= 90 && Math.abs(Number(cercaLng)) <= 180) {
    url.searchParams.set('focus.point.lat', String(Number(cercaLat)));
    url.searchParams.set('focus.point.lon', String(Number(cercaLng)));
  }
  let json = await consultar(url);
  // El autocompletado solo coincide por prefijo; si no halla nada, se prueba la búsqueda completa.
  if (json.features.length === 0) {
    const url2 = new URL('https://api.stadiamaps.com/geocoding/v2/search');
    url2.searchParams.set('text', q);
    url2.searchParams.set('lang', 'es');
    url2.searchParams.set('boundary.country', 'BO');
    url2.searchParams.set('size', '5');
    for (const [k, v] of url.searchParams) if (k.startsWith('focus.')) url2.searchParams.set(k, v);
    json = await consultar(url2);
  }
  return json.features.flatMap((feature) => {
    const coords = feature?.geometry?.coordinates;
    const textoResultado = etiqueta(feature);
    if (!Array.isArray(coords) || coords.length < 2 || !textoResultado) return [];
    const lng = Number(coords[0]); const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return [];
    return [{ texto: textoResultado, lat, lng }];
  }).slice(0, 5);
}

/** Dirección aproximada para unas coordenadas. */
export async function buscarDireccionInversaStadia(lat, lng) {
  const latitude = Number(lat); const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw errorProveedor('Las coordenadas no son válidas.', 'COORDENADAS_INVALIDAS', 422);
  }
  const url = new URL('https://api.stadiamaps.com/geocoding/v2/reverse');
  url.searchParams.set('point.lat', String(latitude));
  url.searchParams.set('point.lon', String(longitude));
  url.searchParams.set('lang', 'es');
  url.searchParams.set('boundary.country', 'BO');
  const json = await consultar(url);
  return etiqueta(json.features[0]) || null;
}
