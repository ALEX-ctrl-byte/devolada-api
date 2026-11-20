import { config } from '../config.js';

function errorProveedor(mensaje, codigo = 'GEOCODIFICACION_NO_DISPONIBLE', estadoHttp = 502) {
  const e = new Error(mensaje);
  e.codigo = codigo;
  e.estadoHttp = estadoHttp;
  return e;
}

async function consultar(url, timeoutMs = 6_000) {
  if (!config.stadiaMapsApiKey) {
    throw errorProveedor('La búsqueda de direcciones aún no está configurada en el servidor.', 'GEOCODIFICACION_NO_CONFIGURADA', 503);
  }
  url.searchParams.set('api_key', config.stadiaMapsApiKey);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/geo+json, application/json' } });
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

// ---------------------------------------------------------------------------------------------
// Normalización de la consulta escrita por el usuario
// ---------------------------------------------------------------------------------------------
// El geocodificador no expande abreviaturas ("av." no coincide con "Avenida") ni corrige errores
// de tecleo habituales ("Snta"). Se normalizan antes de consultar.
const palabra = (alternativas) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternativas})\\.?(?![\\p{L}\\p{N}])`, 'giu');
const ABREVIATURAS = [
  [palabra('avda|avd|ave|av'), 'avenida'],
  [new RegExp('(?<![\\p{L}\\p{N}])c(?:\\.|/)(?=\\s|[\\p{L}])', 'giu'), 'calle '],
  [palabra('pje|psje'), 'pasaje'],
  [palabra('esq'), 'esquina'],
  [palabra('urb'), 'urbanización'],
  [palabra('sta|snta|stta'), 'santa'],
  [palabra('sto'), 'santo'],
  [palabra('gral'), 'general'],
  [palabra('cnel'), 'coronel'],
  [palabra('mcal|mscal'), 'mariscal'],
];
const TIPO_VIA = /^(avenida|calle|pasaje|camino|carretera|plaza|callejón|callejon|autopista)\s+/iu;

export function normalizarConsulta(texto) {
  let t = String(texto ?? '').normalize('NFC').trim();
  for (const [patron, reemplazo] of ABREVIATURAS) t = t.replace(patron, reemplazo);
  return t.replace(/\s+,/g, ',').replace(/\s+/g, ' ').replace(/[.,;:\s]+$/g, '').trim();
}

// ---------------------------------------------------------------------------------------------
// Ciudad cercana (para desambiguar: "Mariscal Santa Cruz" no es la ciudad de Santa Cruz)
// ---------------------------------------------------------------------------------------------
const CIUDADES = [
  { nombre: 'La Paz', lat: -16.4897, lng: -68.1193 },
  { nombre: 'El Alto', lat: -16.5047, lng: -68.1633 },
  { nombre: 'Santa Cruz de la Sierra', lat: -17.7833, lng: -63.1821 },
  { nombre: 'Cochabamba', lat: -17.3935, lng: -66.1570 },
  { nombre: 'Sucre', lat: -19.0196, lng: -65.2619 },
  { nombre: 'Oruro', lat: -17.9647, lng: -67.1060 },
  { nombre: 'Potosí', lat: -19.5836, lng: -65.7531 },
  { nombre: 'Tarija', lat: -21.5355, lng: -64.7296 },
  { nombre: 'Trinidad', lat: -14.8333, lng: -64.9000 },
  { nombre: 'Cobija', lat: -11.0267, lng: -68.7692 },
];

function distanciaKm(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r; const dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export function ciudadCercana(lat, lng) {
  if (lat === null || lng === null || lat === undefined || lng === undefined) return null;
  const la = Number(lat); const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  let mejor = null;
  for (const c of CIUDADES) {
    const d = distanciaKm(la, ln, c.lat, c.lng);
    if (d <= 70 && (!mejor || d < mejor.d)) mejor = { nombre: c.nombre, d };
  }
  return mejor?.nombre ?? null;
}

function focoValido(lat, lng) {
  return lat !== null && lng !== null && lat !== undefined && lng !== undefined
    && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180;
}

function normalizarFeatures(json) {
  return json.features.flatMap((feature) => {
    const coords = feature?.geometry?.coordinates;
    const textoResultado = etiqueta(feature);
    if (!Array.isArray(coords) || coords.length < 2 || !textoResultado) return [];
    const lng = Number(coords[0]); const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return [];
    return [{ texto: textoResultado, lat, lng }];
  });
}

async function buscarUnaVez(modo, texto, lat, lng) {
  const url = new URL(`https://api.stadiamaps.com/geocoding/v2/${modo === 'search' ? 'search' : 'autocomplete'}`);
  url.searchParams.set('text', texto);
  url.searchParams.set('lang', 'es');
  url.searchParams.set('boundary.country', 'BO');
  url.searchParams.set('size', '5');
  if (focoValido(lat, lng)) {
    url.searchParams.set('focus.point.lat', String(Number(lat)));
    url.searchParams.set('focus.point.lon', String(Number(lng)));
  }
  return normalizarFeatures(await consultar(url));
}

/** Intentos en orden: del más literal al más tolerante. Se detiene en el primero con resultados. */
export function planDeBusqueda(texto, cercaLat = null, cercaLng = null) {
  const base = normalizarConsulta(texto);
  const ciudad = ciudadCercana(cercaLat, cercaLng);
  const conComa = base.includes(',');
  const sinTipo = base.replace(TIPO_VIA, '').trim();
  const intentos = [];
  const agregar = (modo, t) => {
    if (t.length >= 3 && !intentos.some((i) => i.modo === modo && i.texto.toLowerCase() === t.toLowerCase())) intentos.push({ modo, texto: t });
  };
  agregar('autocomplete', base);
  // Con la ciudad al final, "Mariscal Santa Cruz" deja de leerse como la ciudad de Santa Cruz.
  if (!conComa && ciudad) agregar('autocomplete', `${base}, ${ciudad}`);
  agregar('search', conComa || !ciudad ? base : `${base}, ${ciudad}`);
  if (sinTipo !== base && sinTipo.length >= 3) {
    if (!conComa && ciudad) agregar('autocomplete', `${sinTipo}, ${ciudad}`);
    agregar('search', conComa || !ciudad ? sinTipo : `${sinTipo}, ${ciudad}`);
  }
  // Sin ubicación del usuario: zona de operación inicial de De Volada.
  if (!conComa && !ciudad) {
    agregar('autocomplete', `${base}, La Paz`);
    agregar('autocomplete', `${base}, El Alto`);
  }
  return intentos;
}

/** Autocompletado de direcciones: devuelve forma normalizada para la API de De Volada. */
export async function buscarDireccionesStadia(texto, cercaLat = null, cercaLng = null) {
  const q = String(texto ?? '').trim();
  if (q.length < 3 || q.length > 120) {
    throw errorProveedor('Escribe entre 3 y 120 caracteres para buscar una dirección.', 'CONSULTA_INVALIDA', 422);
  }
  const intentos = planDeBusqueda(q, cercaLat, cercaLng);
  const inicio = Date.now();
  let primerError = null;
  let respuestaValida = false;
  for (const intento of intentos) {
    if (Date.now() - inicio > 12_000) break; // la app espera como máximo ~20 s
    try {
      const resultados = await buscarUnaVez(intento.modo, intento.texto, cercaLat, cercaLng);
      respuestaValida = true;
      if (resultados.length) {
        const vistos = new Set();
        return resultados.filter((r) => !vistos.has(r.texto) && vistos.add(r.texto)).slice(0, 5);
      }
    } catch (e) {
      if (e.codigo === 'GEOCODIFICACION_NO_CONFIGURADA') throw e;
      primerError ??= e;
    }
  }
  if (!respuestaValida && primerError) throw primerError;
  return [];
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
