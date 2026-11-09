import { Router } from 'express';
import { ok, error } from '../respuesta.js';
import { buscarDireccionesStadia, buscarDireccionInversaStadia } from '../servicios/geocodificacionStadia.js';

export const rutaUbicaciones = Router();

function numeroValido(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : NaN;
}

// GET /ubicaciones/buscar?texto=...&lat=...&lng=...
rutaUbicaciones.get('/buscar', async (req, res) => {
  const texto = String(req.query.texto ?? '').trim();
  if (texto.length < 3 || texto.length > 120) {
    return error(res, 422, 'CONSULTA_INVALIDA', 'Escribe entre 3 y 120 caracteres para buscar una dirección.');
  }
  const lat = numeroValido(req.query.lat, -90, 90);
  const lng = numeroValido(req.query.lng, -180, 180);
  if (Number.isNaN(lat) || Number.isNaN(lng) || ((lat === null) !== (lng === null))) {
    return error(res, 422, 'COORDENADAS_INVALIDAS', 'Envía latitud y longitud válidas juntas, o deja ambas vacías.');
  }
  try {
    const sugerencias = await buscarDireccionesStadia(texto, lat, lng);
    return ok(res, { sugerencias });
  } catch (e) {
    return error(res, e.estadoHttp ?? 502, e.codigo ?? 'GEOCODIFICACION_NO_DISPONIBLE', e.message ?? 'No se pudo buscar la dirección.');
  }
});

// GET /ubicaciones/inversa?lat=...&lng=...
rutaUbicaciones.get('/inversa', async (req, res) => {
  const lat = numeroValido(req.query.lat, -90, 90);
  const lng = numeroValido(req.query.lng, -180, 180);
  if (lat === null || lng === null || Number.isNaN(lat) || Number.isNaN(lng)) {
    return error(res, 422, 'COORDENADAS_INVALIDAS', 'Envía una latitud y longitud válidas.');
  }
  try {
    const direccion = await buscarDireccionInversaStadia(lat, lng);
    return ok(res, { direccion });
  } catch (e) {
    return error(res, e.estadoHttp ?? 502, e.codigo ?? 'GEOCODIFICACION_NO_DISPONIBLE', e.message ?? 'No se pudo resolver la dirección.');
  }
});
