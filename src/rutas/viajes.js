import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';
import { ajusteNumero } from '../servicios/ajustes.js';
import { obtenerRutaOSRM } from '../servicios/osrm.js';
import { calcularTarifaDeUna, enteroBs } from '../servicios/tarifas.js';
import { config } from '../config.js';
import { iguales } from '../seguridad.js';
import { notificarEstadoViaje, avisarOfertaNueva, emitirUbicacionViaje, emitirUbicacionPedido } from '../tiempoReal.js';

export const rutaViajes = Router();
const ROLES_CONDUCTOR = ['conductor'];
const TIPOS_DOCUMENTO_MOTO = ['ci_frente','ci_reverso','selfie','licencia_frente','licencia_reverso','selfie_licencia','soat','tarjeta_propiedad','foto_placa','foto_moto'];
const TIPOS_DOCUMENTO_AUTO = ['ci_frente','ci_reverso','selfie','licencia_frente','licencia_reverso','selfie_licencia','soat','tarjeta_propiedad','foto_placa','foto_auto_frente','foto_auto_atras','foto_auto_lateral','ruat'];
const tiposDocumentoVehiculo = (tipo) => tipo === 'auto' ? TIPOS_DOCUMENTO_AUTO : TIPOS_DOCUMENTO_MOTO;

function numeroId(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function leerCoordenadas(body) {
  const oLat = Number(body?.origen_lat);
  const oLng = Number(body?.origen_lng);
  const dLat = Number(body?.destino_lat);
  const dLng = Number(body?.destino_lng);
  const coords = [oLat, oLng, dLat, dLng];
  if (!coords.every(Number.isFinite)
      || oLat < -90 || oLat > 90 || dLat < -90 || dLat > 90
      || oLng < -180 || oLng > 180 || dLng < -180 || dLng > 180) return null;
  if (Math.abs(oLat - dLat) < 0.00001 && Math.abs(oLng - dLng) < 0.00001) return null;
  return { origen: { lat: redondear(oLat, 7), lng: redondear(oLng, 7) }, destino: { lat: redondear(dLat, 7), lng: redondear(dLng, 7) } };
}

function redondear(n, decimales = 2) {
  const factor = 10 ** decimales;
  return Math.round((Number(n) + Number.EPSILON) * factor) / factor;
}

function crearTokenCotizacion(datos) {
  const parte = Buffer.from(JSON.stringify(datos)).toString('base64url');
  const firma = crypto.createHmac('sha256', config.otpSecret).update(parte).digest('hex');
  return `${parte}.${firma}`;
}

function leerTokenCotizacion(token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const partes = token.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null;
  const firmaEsperada = crypto.createHmac('sha256', config.otpSecret).update(partes[0]).digest('hex');
  if (!iguales(firmaEsperada, partes[1])) return null;
  try {
    const d = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
    if (!d || !Number.isSafeInteger(d.usuario_id) || !Number.isFinite(d.expira_en)) return null;
    if (d.expira_en < Math.floor(Date.now() / 1000)) return { expirada: true };
    return d;
  } catch {
    return null;
  }
}

function haversineMetros(lat1, lng1, lat2, lng2) {
  const rad = (v) => (v * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function transaccion(fn) {
  const cx = await db.getConnection();
  try {
    await cx.beginTransaction();
    const resultado = await fn(cx);
    if (resultado?.e) {
      await cx.rollback();
      return resultado;
    }
    await cx.commit();
    return resultado;
  } catch (e) {
    await cx.rollback().catch(() => {});
    throw e;
  } finally {
    cx.release();
  }
}

function responderErrorDeOperacion(res, resultado) {
  if (!resultado?.e) return false;
  return error(res, ...resultado.e);
}

async function obtenerDetalle(cx, viajeId) {
  const [filas] = await cx.execute(
    `SELECT v.*, up.nombre AS pasajero_nombre, up.apellido AS pasajero_apellido,
            uc.nombre AS conductor_nombre, uc.apellido AS conductor_apellido,
            CASE WHEN v.metodo_pago = 'digital' AND v.estado IN ('aceptado','conductor_llego','en_curso','finalizado') THEN c.qr_pago_url END AS conductor_qr_pago_url,
            m.placa AS moto_placa, m.marca AS moto_marca, m.modelo AS moto_modelo, m.color AS moto_color,
            CASE WHEN v.estado IN ('aceptado','conductor_llego','en_curso') THEN uc.telefono END AS conductor_telefono,
            CASE WHEN v.estado IN ('aceptado','conductor_llego','en_curso') AND cu.es_mock = 0
                      AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND
                 THEN cu.latitud END AS conductor_lat,
            CASE WHEN v.estado IN ('aceptado','conductor_llego','en_curso') AND cu.es_mock = 0
                      AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND
                 THEN cu.longitud END AS conductor_lng
       FROM viajes v
       JOIN usuarios up ON up.id = v.pasajero_id
       LEFT JOIN conductores c ON c.id = v.conductor_id
       LEFT JOIN usuarios uc ON uc.id = c.usuario_id
       LEFT JOIN motos m ON m.id = v.moto_id
       LEFT JOIN conductor_ubicacion cu ON cu.conductor_id = v.conductor_id
      WHERE v.id = ? LIMIT 1`,
    [viajeId],
  );
  const fila = filas[0];
  if (!fila) return null;
  return {
    ...fila,
    tarifa_estimada: enteroBs(fila.tarifa_estimada),
    tarifa_final: fila.tarifa_final == null ? null : enteroBs(fila.tarifa_final),
    comision_monto: fila.comision_monto == null ? null : enteroBs(fila.comision_monto),
    ganancia_conductor: fila.ganancia_conductor == null ? null : enteroBs(fila.ganancia_conductor),
  };
}

async function tienePermisoVerViaje(cx, viaje, usuarioId) {
  if (String(viaje.pasajero_id) === String(usuarioId)) return true;
  if (viaje.conductor_id == null) return false;
  const [filas] = await cx.execute('SELECT usuario_id FROM conductores WHERE id = ? LIMIT 1', [viaje.conductor_id]);
  return Boolean(filas[0] && String(filas[0].usuario_id) === String(usuarioId));
}

async function datosConductor(cx, usuarioId, conBloqueo = false) {
  const lock = conBloqueo ? ' FOR UPDATE' : '';
  const [filas] = await cx.execute(
    `SELECT c.id AS conductor_id, c.estado_aprobacion, c.estado_operativo,
            c.licencia_vence_en, c.usuario_id, c.qr_pago_url, c.qr_pago_vence_en, IF(c.qr_pago_url IS NOT NULL AND c.qr_pago_vence_en > UTC_TIMESTAMP(),1,0) AS qr_vigente, u.restringido_hasta,
            m.id AS moto_id, m.tipo_vehiculo, b.id AS billetera_id, b.saldo_prepago, b.saldo_comision_reservado, b.estado AS billetera_estado
       FROM conductores c
       JOIN usuarios u ON u.id = c.usuario_id
       LEFT JOIN motos m ON m.conductor_id = c.id
       LEFT JOIN billeteras b ON b.conductor_id = c.id
      WHERE c.usuario_id = ? LIMIT 1${lock}`,
    [usuarioId],
  );
  return filas[0] ?? null;
}

async function ubicacionConductor(cx, conductorId, segundosMaximos, conBloqueo = false) {
  const s = Math.max(5, Math.min(120, Math.floor(segundosMaximos)));
  const lock = conBloqueo ? ' FOR UPDATE' : '';
  const [filas] = await cx.execute(
    `SELECT latitud, longitud, es_mock, actualizado_en
       FROM conductor_ubicacion
      WHERE conductor_id = ? AND es_mock = 0
        AND actualizado_en >= UTC_TIMESTAMP() - INTERVAL ${s} SECOND
      LIMIT 1${lock}`,
    [conductorId],
  );
  return filas[0] ?? null;
}

function validarCoordenadaUnica(body) {
  const lat = Number(body?.latitud);
  const lng = Number(body?.longitud);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const precision = body?.precision_m == null ? null : Number(body.precision_m);
  const rumbo = body?.rumbo_grados == null ? null : Number(body.rumbo_grados);
  if (precision !== null && (!Number.isFinite(precision) || precision < 0 || precision > 10000)) return null;
  if (rumbo !== null && (!Number.isInteger(rumbo) || rumbo < 0 || rumbo > 359)) return null;
  return { latitud: redondear(lat, 7), longitud: redondear(lng, 7), precision, rumbo, esMock: body?.es_mock === true };
}

// ---------------------------------------------------------------------
// POST /viajes/cotizar
// Body: { origen_lat, origen_lng, destino_lat, destino_lng }
// El servidor consulta OSRM y devuelve una cotización firmada que no puede
// ser modificada por el cliente. El motor compartido calcula base entera, distancia,
// duración estimada y aproximación desde un conductor disponible cercano.
// ---------------------------------------------------------------------
rutaViajes.post('/cotizar', autenticar, async (req, res) => {
  const coordenadas = leerCoordenadas(req.body);
  if (!coordenadas) return error(res, 422, 'COORDENADAS_INVALIDAS', 'Indica un origen y un destino válidos y distintos.');
  const tipoVehiculo = String(req.body?.tipo_vehiculo ?? 'moto').trim().toLowerCase();
  if (!['moto', 'auto'].includes(tipoVehiculo)) return error(res, 422, 'TIPO_VEHICULO_INVALIDO', 'Selecciona moto o auto antes de cotizar.');

  let ruta;
  try {
    ruta = await obtenerRutaOSRM(coordenadas.origen, coordenadas.destino);
  } catch (e) {
    return error(res, e.estadoHttp ?? 502, e.codigo ?? 'RUTA_NO_DISPONIBLE', e.message ?? 'No se pudo calcular la ruta.');
  }

  let calculo;
  try {
    calculo = await calcularTarifaDeUna({ tipoServicio: 'viaje', tipoVehiculo, origen: coordenadas.origen, rutaServicio: ruta });
  } catch (e) {
    console.error('[tarifas] no se pudo calcular la cotización de viaje', e.message);
    return error(res, 503, 'TARIFA_NO_DISPONIBLE', 'No se pudo calcular la tarifa dinámica. Intenta nuevamente.');
  }
  const tarifa = enteroBs(calculo.tarifa_bs);
  const comisionPorcentaje = Math.max(0, Math.min(100, await ajusteNumero('comision_porcentaje', 10)));
  // Sistema de puntos: la comisión De Volada es un descuento fijo de puntos por servicio completado.
  // comision_porcentaje se conserva solo como dato histórico en la BD.
  const comision = config.puntosPorViaje;
  const validezSegundos = Math.max(15, Math.min(600, Math.floor(await ajusteNumero('validez_cotizacion_s', 120))));
  const ahora = Math.floor(Date.now() / 1000);
  const tokenDatos = {
    v: 2,
    usuario_id: Number(req.usuario.id),
    tipo_vehiculo: tipoVehiculo,
    origen: coordenadas.origen,
    destino: coordenadas.destino,
    distancia_m: ruta.distancia_m,
    duracion_estimada_s: ruta.duracion_estimada_s,
    distancia_aproximacion_m: Number(calculo.detalle.distancia_aproximacion_m ?? 0),
    duracion_aproximacion_s: Number(calculo.detalle.duracion_aproximacion_s ?? 0),
    detalle_tarifa: calculo.detalle,
    tarifa_estimada: tarifa,
    comision_porcentaje: comisionPorcentaje,
    expira_en: ahora + validezSegundos,
  };
  const token = crearTokenCotizacion(tokenDatos);
  const km = ruta.distancia_m / 1000;

  return ok(res, {
    cotizacion_token: token,
    expira_en: new Date((ahora + validezSegundos) * 1000).toISOString(),
    origen: coordenadas.origen,
    destino: coordenadas.destino,
    tipo_vehiculo: tipoVehiculo,
    distancia_m: ruta.distancia_m,
    distancia_km: redondear(km, 2),
    duracion_estimada_s: ruta.duracion_estimada_s,
    duracion_estimada_min: Math.max(1, Math.round(ruta.duracion_estimada_s / 60)),
    tarifa_estimada_bs: tarifa,
    comision_estimada_bs: comision,
    comision_puntos: comision,
    comision_porcentaje: comisionPorcentaje,
    detalle_tarifa: calculo.detalle,
    moneda: 'BOB',
    geometria: ruta.geometria,
    regla_tarifa: 'base_entera + km + bloques_de_5_min + aproximacion_estimada; la base baja a Bs 3 solo cuando la oferta cercana supera a la demanda.',
  });
});

// ---------------------------------------------------------------------
// POST /viajes
// Body: { cotizacion_token, idempotency_key, metodo_pago: "efectivo"|"qr" ("digital" legacy),
//         origen_direccion?, destino_direccion? }
// ---------------------------------------------------------------------
rutaViajes.post('/', autenticar, async (req, res) => {
  if (req.usuario.rol !== 'pasajero') return error(res, 403, 'SOLO_PASAJEROS', 'Solo una cuenta de pasajero puede solicitar viajes.');
  const token = leerTokenCotizacion(req.body?.cotizacion_token);
  if (!token) return error(res, 422, 'COTIZACION_INVALIDA', 'La cotización no es válida. Calcula la ruta nuevamente.');
  if (token.expirada) return error(res, 409, 'COTIZACION_EXPIRADA', 'La cotización expiró. Calcula la ruta nuevamente.');
  if (String(token.usuario_id) !== String(req.usuario.id)) return error(res, 403, 'COTIZACION_AJENA', 'La cotización pertenece a otra sesión.');

  const idempotencyKey = String(req.body?.idempotency_key ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{8,64}$/.test(idempotencyKey)) {
    return error(res, 422, 'IDEMPOTENCY_KEY_INVALIDA', 'Envía una idempotency_key única de 8 a 64 caracteres.');
  }
  const metodoEntrada = String(req.body?.metodo_pago ?? 'efectivo');
  const metodo = metodoEntrada === 'qr' ? 'digital' : metodoEntrada; // La columna SQL conserva 'digital' por compatibilidad: significa QR externo directo al conductor.
  if (!['efectivo', 'digital'].includes(metodo)) return error(res, 422, 'METODO_PAGO_INVALIDO', 'El método de pago debe ser efectivo o QR directo al conductor.')
  const origenDireccion = req.body?.origen_direccion == null ? null : String(req.body.origen_direccion).trim().slice(0, 255);
  const destinoDireccion = req.body?.destino_direccion == null ? null : String(req.body.destino_direccion).trim().slice(0, 255);

  // La restricción por exceso de cancelaciones se aplica de verdad al solicitar un viaje.
  const [restr] = await db.execute(
    'SELECT restringido_hasta FROM usuarios WHERE id = ? AND restringido_hasta > UTC_TIMESTAMP() LIMIT 1',
    [req.usuario.id],
  );
  if (restr[0]) {
    return error(res, 403, 'CUENTA_RESTRINGIDA', 'Tu cuenta tiene una restricción temporal por cancelaciones. Intenta más tarde.');
  }

  try {
    const r = await transaccion(async (cx) => {
      const [existentes] = await cx.execute(
        'SELECT * FROM viajes WHERE pasajero_id = ? AND idempotency_key = ? LIMIT 1 FOR UPDATE',
        [req.usuario.id, idempotencyKey],
      );
      if (existentes[0]) {
        const v = existentes[0];
        const same = Math.abs(Number(v.origen_lat) - token.origen.lat) < 0.0000002
          && Math.abs(Number(v.origen_lng) - token.origen.lng) < 0.0000002
          && Math.abs(Number(v.destino_lat) - token.destino.lat) < 0.0000002
          && Math.abs(Number(v.destino_lng) - token.destino.lng) < 0.0000002
          && v.metodo_pago === metodo
          && (v.tipo_vehiculo_solicitado ?? 'moto') === (token.tipo_vehiculo ?? 'moto');
        if (!same) return { e: [409, 'IDEMPOTENCY_KEY_REUTILIZADA', 'Esa idempotency_key ya se usó para otra ruta.'] };
        return { viaje: await obtenerDetalle(cx, v.id), repetido: true };
      }

      const [activos] = await cx.execute(
        `SELECT id FROM viajes WHERE pasajero_id = ?
            AND estado IN ('solicitado','aceptado','conductor_llego','en_curso') LIMIT 1 FOR UPDATE`,
        [req.usuario.id],
      );
      if (activos[0]) return { e: [409, 'VIAJE_ACTIVO_EXISTENTE', 'Ya tienes un viaje activo. Termínalo o cancélalo antes de pedir otro.', { viaje_id: activos[0].id }] };

      // En el modelo De Volada, el pasajero paga directamente al conductor (efectivo o QR personal).
      // No se retiene ni debita dinero del pasajero dentro de De Volada.

      const [ins] = await cx.execute(
        `INSERT INTO viajes
          (pasajero_id, estado, origen_lat, origen_lng, origen_direccion,
           destino_lat, destino_lng, destino_direccion, distancia_m,
           duracion_estimada_s, tipo_vehiculo_solicitado,
           distancia_aproximacion_m, duracion_aproximacion_s, detalle_tarifa_json,
           tarifa_estimada, comision_porcentaje, metodo_pago, idempotency_key, solicitado_en)
         VALUES (?, 'solicitado', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [req.usuario.id, token.origen.lat, token.origen.lng, origenDireccion,
         token.destino.lat, token.destino.lng, destinoDireccion,
         token.distancia_m, token.duracion_estimada_s, token.tipo_vehiculo ?? 'moto',
         token.distancia_aproximacion_m ?? 0, token.duracion_aproximacion_s ?? 0,
         JSON.stringify(token.detalle_tarifa ?? {}), enteroBs(token.tarifa_estimada),
         token.comision_porcentaje, metodo, idempotencyKey],
      );
      return { viaje: await obtenerDetalle(cx, ins.insertId), repetido: false };
    });
    if (responderErrorDeOperacion(res, r)) return;
    if (!r.repetido) avisarOfertaNueva(r.viaje.id); // Etapa 9: conductores cercanos reciben el aviso al instante
    return ok(res, r, r.repetido ? 200 : 201);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return error(res, 409, 'VIAJE_ACTIVO_EXISTENTE', 'Ya tienes un viaje activo o la clave de solicitud está repetida.');
    throw e;
  }
});

// GET /viajes/mios: historial reciente del pasajero o conductor autenticado.
rutaViajes.get('/mios', autenticar, async (req, res) => {
  const [filas] = await db.execute(
    `SELECT v.id, v.pasajero_id, v.conductor_id, v.estado,
            v.origen_lat, v.origen_lng, v.origen_direccion,
            v.destino_lat, v.destino_lng, v.destino_direccion,
            v.distancia_m, v.duracion_estimada_s, v.tipo_vehiculo_solicitado, v.tarifa_estimada,
            v.tarifa_final, v.ganancia_conductor, v.metodo_pago, v.solicitado_en, v.aceptado_en,
            v.iniciado_en, v.finalizado_en, up.nombre AS pasajero_nombre,
            uc.nombre AS conductor_nombre
       FROM viajes v
       JOIN usuarios up ON up.id = v.pasajero_id
       LEFT JOIN conductores c ON c.id = v.conductor_id
       LEFT JOIN usuarios uc ON uc.id = c.usuario_id
      WHERE v.pasajero_id = ? OR c.usuario_id = ?
      ORDER BY v.solicitado_en DESC LIMIT 30`,
    [req.usuario.id, req.usuario.id],
  );
  // Para conductores, se informa también su estado operativo (disponible / en_viaje / offline).
  let estadoOperativo = null;
  if (req.usuario.rol === 'conductor') {
    const [co] = await db.execute('SELECT estado_operativo FROM conductores WHERE usuario_id = ? LIMIT 1', [req.usuario.id]);
    estadoOperativo = co[0]?.estado_operativo ?? null;
  }
  return ok(res, { viajes: filas.map((v) => ({
    ...v,
    tarifa_estimada: enteroBs(v.tarifa_estimada),
    tarifa_final: v.tarifa_final == null ? null : enteroBs(v.tarifa_final),
    ganancia_conductor: v.ganancia_conductor == null ? null : enteroBs(v.ganancia_conductor),
  })), estado_operativo: estadoOperativo });
});

// POST /viajes/disponibilidad { disponible: true|false }
// La disponibilidad solo puede activarse después de validar aprobación, moto, documentos,
// licencia y billetera. La aceptación de cada viaje vuelve a verificar todas las condiciones.
rutaViajes.post('/disponibilidad', autenticar, async (req, res) => {
  if (!ROLES_CONDUCTOR.includes(req.usuario.rol)) return error(res, 403, 'NO_ES_CONDUCTOR', 'Esta función es solo para cuentas de conductor.');
  if (typeof req.body?.disponible !== 'boolean') return error(res, 422, 'DATOS_INVALIDOS', 'disponible debe ser true o false.');
  const c = await datosConductor(db, req.usuario.id, true);
  if (!c) return error(res, 409, 'SIN_POSTULACION', 'Primero completa tu postulación como conductor.');
  if (!req.body.disponible) {
    if (c.estado_operativo === 'en_viaje') return error(res, 409, 'VIAJE_ACTIVO', 'No puedes desconectarte mientras tengas un viaje activo.');
    await db.execute("UPDATE conductores SET estado_operativo='offline' WHERE id=?", [c.conductor_id]);
    return ok(res, { disponible: false, estado_operativo: 'offline' });
  }
  if (c.estado_aprobacion !== 'aprobado') return error(res, 403, 'CONDUCTOR_NO_APROBADO', 'La cuenta aún no está aprobada.');
  if (!c.moto_id) return error(res, 409, 'SIN_VEHICULO', 'Registra una moto o auto antes de conectarte.');
  if (!c.billetera_id || c.billetera_estado !== 'activa') return error(res, 409, 'BILLETERA_NO_ACTIVA', 'Tu billetera no está activa.');
  const [licencias] = await db.execute(
    `SELECT (licencia_vence_en IS NOT NULL AND licencia_vence_en >= DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR)) AS vigente
       FROM conductores WHERE id=?`, [c.conductor_id]);
  if (!licencias[0]?.vigente) return error(res, 403, 'LICENCIA_VENCIDA', 'Registra una licencia vigente.');
  const [docs] = await db.execute(
    `SELECT DISTINCT tipo FROM documentos_conductor WHERE conductor_id=? AND estado='aprobado'
       AND (vence_en IS NULL OR vence_en >= DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR))`, [c.conductor_id]);
  const presentes = new Set(docs.map((d) => d.tipo));
  const faltan = tiposDocumentoVehiculo(c.tipo_vehiculo).filter((t) => !presentes.has(t));
  if (faltan.length) return error(res, 403, 'DOCUMENTOS_NO_VIGENTES', 'Hay documentos requeridos no aprobados o vencidos.', { faltan });
  const puntosMinimos = config.puntosPorViaje;
  const saldoLibre = redondear(Math.max(0, Number(c.saldo_prepago ?? 0) - Number(c.saldo_comision_reservado ?? 0)));
  if (saldoLibre < puntosMinimos) return error(res, 409, 'SALDO_INSUFICIENTE', `Necesitas al menos ${puntosMinimos} puntos disponibles para conectarte. Recarga puntos para recibir servicios.`, { puntos_disponibles: saldoLibre, puntos_requeridos: puntosMinimos });
  const ubicacion = await ubicacionConductor(db, c.conductor_id, await ajusteNumero('ubicacion_max_antiguedad_s', 30));
  if (!ubicacion) return error(res, 409, 'UBICACION_NO_ACTUALIZADA', 'Actualiza tu ubicación GPS antes de conectarte.');
  await db.execute("UPDATE conductores SET estado_operativo='disponible' WHERE id=?", [c.conductor_id]);
  return ok(res, { disponible: true, estado_operativo: 'disponible' });
});

// GET /viajes/ofertas — solicitudes cercanas para el panel del conductor.
rutaViajes.get('/ofertas', autenticar, async (req, res) => {
  if (!ROLES_CONDUCTOR.includes(req.usuario.rol)) return error(res, 403, 'NO_ES_CONDUCTOR', 'Esta función es solo para conductores.');
  const c = await datosConductor(db, req.usuario.id);
  if (!c || c.estado_aprobacion !== 'aprobado' || c.estado_operativo !== 'disponible') {
    return error(res, 409, 'CONDUCTOR_NO_DISPONIBLE', 'Activa tu disponibilidad para ver solicitudes.');
  }
  const edad = await ajusteNumero('ubicacion_max_antiguedad_s', 30);
  const u = await ubicacionConductor(db, c.conductor_id, edad);
  if (!u) return error(res, 409, 'UBICACION_NO_ACTUALIZADA', 'Actualiza tu ubicación GPS para ver solicitudes.');
  const puntosMinimos = config.puntosPorViaje;
  const saldoLibre = redondear(Math.max(0, Number(c.saldo_prepago ?? 0) - Number(c.saldo_comision_reservado ?? 0)));
  if (saldoLibre < puntosMinimos) {
    return error(res, 409, 'SALDO_COMISION_INSUFICIENTE', `No tienes puntos suficientes. Cada servicio completado descuenta ${puntosMinimos} puntos; recarga para volver a recibir viajes y delivery.`, { saldo_comision_bs: Number(c.saldo_prepago ?? 0), reservado_bs: Number(c.saldo_comision_reservado ?? 0), disponible_bs: saldoLibre, minimo_bs: puntosMinimos, puntos_disponibles: saldoLibre, puntos_requeridos: puntosMinimos });
  }
  const radio = Math.max(1, Math.min(20, await ajusteNumero('radio_busqueda_km', 3)));
  const [filas] = await db.execute(
    `SELECT v.id, v.estado, v.origen_lat, v.origen_lng, v.origen_direccion,
            v.destino_lat, v.destino_lng, v.destino_direccion, v.distancia_m,
            v.duracion_estimada_s, v.tipo_vehiculo_solicitado, v.tarifa_estimada, v.metodo_pago, v.solicitado_en,
            ROUND(ST_Distance_Sphere(POINT(v.origen_lng, v.origen_lat), POINT(?, ?))) AS distancia_recogida_m
       FROM viajes v
      WHERE v.estado='solicitado'
        AND (v.tipo_vehiculo_solicitado IS NULL OR v.tipo_vehiculo_solicitado = ?)
        AND ST_Distance_Sphere(POINT(v.origen_lng, v.origen_lat), POINT(?, ?)) <= ?
      ORDER BY distancia_recogida_m ASC, v.solicitado_en ASC LIMIT 30`,
    [Number(u.longitud), Number(u.latitud), c.tipo_vehiculo ?? 'moto', Number(u.longitud), Number(u.latitud), radio * 1000],
  );
  const qrVigente = Boolean(c.qr_pago_url) && Number(c.qr_vigente) === 1;
  const compatibles = filas.filter((v) => v.metodo_pago !== 'digital' || qrVigente).map((v) => ({ ...v, tarifa_estimada: enteroBs(v.tarifa_estimada) }));
  return ok(res, { viajes: compatibles, radio_km: radio, ubicacion_actualizada_en: u.actualizado_en, requiere_qr: !qrVigente });
});

// POST /viajes/ubicacion-conductor: actualiza ubicación propia, necesaria para aparecer en despacho.
rutaViajes.post('/ubicacion-conductor', autenticar, async (req, res) => {
  if (!ROLES_CONDUCTOR.includes(req.usuario.rol)) return error(res, 403, 'NO_ES_CONDUCTOR', 'Esta función es solo para cuentas de conductor.');
  const p = validarCoordenadaUnica(req.body);
  if (!p) return error(res, 422, 'UBICACION_INVALIDA', 'La latitud, longitud, precisión o rumbo no son válidos.');
  const c = await datosConductor(db, req.usuario.id);
  if (!c) return error(res, 409, 'SIN_POSTULACION', 'Primero completa tu postulación como conductor.');
  await db.execute(
    `INSERT INTO conductor_ubicacion (conductor_id, latitud, longitud, rumbo_grados, precision_m, es_mock, actualizado_en)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE latitud=VALUES(latitud), longitud=VALUES(longitud), rumbo_grados=VALUES(rumbo_grados),
       precision_m=VALUES(precision_m), es_mock=VALUES(es_mock), actualizado_en=UTC_TIMESTAMP(3)`,
    [c.conductor_id, p.latitud, p.longitud, p.rumbo, p.precision, p.esMock ? 1 : 0],
  );
  // Etapa 9: si el conductor tiene un viaje activo, esta misma ubicación se guarda en el recorrido
  // y se envía al pasajero. Así el servicio en segundo plano de la app no necesita saber el id del viaje.
  let viajeActivoId = null;
  let pedidoActivoId = null;
  const [activos] = await db.execute(
    `SELECT id FROM viajes WHERE conductor_id = ? AND estado IN ('aceptado','conductor_llego','en_curso') LIMIT 1`,
    [c.conductor_id],
  );
  if (activos[0]) {
    viajeActivoId = Number(activos[0].id);
    await db.execute(
      `INSERT INTO ubicaciones_viaje (viaje_id, latitud, longitud, precision_m, rumbo_grados, registrado_en)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [viajeActivoId, p.latitud, p.longitud, p.precision, p.rumbo],
    );
    if (!p.esMock) emitirUbicacionViaje(viajeActivoId, p);
  } else {
    // Un delivery mantiene el servicio de ubicación activo aunque no haya viaje de pasajeros.
    // Esto es esencial para validar la recogida/entrega y no dejar que el GPS caduque en ruta.
    const [pedidos] = await db.execute(
      `SELECT id FROM pedidos WHERE conductor_id=? AND estado IN ('asignado','recogido','en_camino') ORDER BY asignado_en DESC LIMIT 1`,
      [c.conductor_id],
    );
    if (pedidos[0]) {
      pedidoActivoId = Number(pedidos[0].id);
      if (!p.esMock) await emitirUbicacionPedido(pedidoActivoId, p);
    }
  }
  const usadaParaServicio = !p.esMock && (
    (c.estado_aprobacion === 'aprobado' && c.estado_operativo === 'disponible') ||
    viajeActivoId != null || pedidoActivoId != null
  );
  return ok(res, { guardada: true, viaje_id: viajeActivoId, pedido_id: pedidoActivoId, actualizado_en: new Date().toISOString(), usada_para_despacho: usadaParaServicio });
});

// POST /viajes/:id/aceptar — el conductor debe estar aprobado, disponible, documentado,
// dentro del radio, con ubicación fresca y saldo suficiente para cubrir comisión y mínimo operativo.
rutaViajes.post('/:id/aceptar', autenticar, async (req, res) => {
  if (!ROLES_CONDUCTOR.includes(req.usuario.rol)) return error(res, 403, 'NO_ES_CONDUCTOR', 'Solo un conductor puede aceptar un viaje.');
  const viajeId = numeroId(req.params.id);
  if (!viajeId) return error(res, 400, 'ID_INVALIDO', 'El identificador del viaje no es válido.');

  try {
    const r = await transaccion(async (cx) => {
      const [viajes] = await cx.execute('SELECT * FROM viajes WHERE id = ? LIMIT 1 FOR UPDATE', [viajeId]);
      const v = viajes[0];
      if (!v) return { e: [404, 'VIAJE_NO_ENCONTRADO', 'No se encontró el viaje.'] };
      if (v.estado !== 'solicitado') return { e: [409, 'VIAJE_NO_DISPONIBLE', 'Este viaje ya no está disponible para aceptar.'] };

      const c = await datosConductor(cx, req.usuario.id, true);
      if (!c) return { e: [409, 'SIN_POSTULACION', 'No se encontró tu registro de conductor.'] };
      if (v.metodo_pago === 'digital' && (!c.qr_pago_url || Number(c.qr_vigente) !== 1)) return { e: [409, 'QR_CONDUCTOR_NO_CONFIGURADO', 'Para aceptar viajes con pago QR, primero sube el QR de tu cuenta bancaria en tu perfil.'] };
      if (c.estado_aprobacion !== 'aprobado') return { e: [403, 'CONDUCTOR_NO_APROBADO', 'Tu cuenta de conductor aún no está aprobada.'] };
      if (c.estado_operativo !== 'disponible') return { e: [409, 'CONDUCTOR_NO_DISPONIBLE', 'Debes estar disponible para aceptar un viaje.'] };
      if (!c.moto_id) return { e: [409, 'SIN_VEHICULO', 'Tu cuenta no tiene un vehículo registrado.'] };
      if (v.tipo_vehiculo_solicitado && c.tipo_vehiculo !== v.tipo_vehiculo_solicitado) return { e: [409, 'VEHICULO_NO_COINCIDE', `Este viaje fue cotizado para ${v.tipo_vehiculo_solicitado}. Solo un conductor con ese tipo de vehículo puede aceptarlo.`] };
      if (!c.billetera_id || c.billetera_estado !== 'activa') return { e: [409, 'BILLETERA_NO_ACTIVA', 'Tu billetera de conductor no está activa.'] };
      if (c.restringido_hasta && new Date(c.restringido_hasta).getTime() > Date.now()) return { e: [403, 'CUENTA_RESTRINGIDA', 'Tu cuenta tiene una restricción temporal.'] };
      const [docRows] = await cx.execute(
        `SELECT DISTINCT tipo FROM documentos_conductor
          WHERE conductor_id = ? AND estado = 'aprobado'
            AND (vence_en IS NULL OR vence_en >= DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR))`,
        [c.conductor_id],
      );
      const aprobados = new Set(docRows.map((x) => x.tipo));
      const faltan = tiposDocumentoVehiculo(c.tipo_vehiculo).filter((t) => !aprobados.has(t));
      if (faltan.length) return { e: [403, 'DOCUMENTOS_NO_VIGENTES', 'Debes tener todos los documentos requeridos aprobados y vigentes.', { faltan }] };
      const [licencias] = await cx.execute(
        'SELECT (licencia_vence_en IS NOT NULL AND licencia_vence_en >= DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR)) AS licencia_vigente FROM conductores WHERE id = ?',
        [c.conductor_id],
      );
      if (!licencias[0]?.licencia_vigente) return { e: [403, 'LICENCIA_VENCIDA', 'Registra una licencia de conducir vigente.'] };

      const edadUbicacion = await ajusteNumero('ubicacion_max_antiguedad_s', 30);
      const ubi = await ubicacionConductor(cx, c.conductor_id, edadUbicacion, true);
      if (!ubi) return { e: [409, 'UBICACION_NO_ACTUALIZADA', 'Envía tu ubicación actual antes de aceptar viajes. La ubicación debe ser reciente y no simulada.'] };
      const radioKm = await ajusteNumero('radio_busqueda_km', 3);
      const separacion = haversineMetros(Number(ubi.latitud), Number(ubi.longitud), Number(v.origen_lat), Number(v.origen_lng));
      if (separacion > radioKm * 1000) return { e: [409, 'FUERA_DEL_RADIO', `Debes estar a menos de ${radioKm} km del punto de recogida.`, { distancia_m: Math.round(separacion), radio_km: radioKm }] };

      // Sistema de puntos: se reservan exactamente config.puntosPorViaje puntos (no un porcentaje).
      const comisionRequerida = config.puntosPorViaje;
      const saldoLibreConductor = redondear(Math.max(0, Number(c.saldo_prepago) - Number(c.saldo_comision_reservado ?? 0)));
      if (saldoLibreConductor < comisionRequerida) return { e: [409, 'SALDO_INSUFICIENTE', `No tienes puntos suficientes para aceptar este viaje. Necesitas ${comisionRequerida} puntos disponibles; recarga puntos para seguir recibiendo servicios.`, { saldo_bs: Number(c.saldo_prepago), reservado_bs: Number(c.saldo_comision_reservado ?? 0), disponible_bs: saldoLibreConductor, requerido_bs: comisionRequerida, comision_bs: comisionRequerida, puntos_disponibles: saldoLibreConductor, puntos_requeridos: comisionRequerida }] };

      const [serviciosActivos] = await cx.execute(
        `SELECT id FROM pedidos WHERE conductor_id=? AND estado IN ('asignado','recogido','en_camino','requiere_revision') LIMIT 1 FOR UPDATE`, [c.conductor_id],
      );
      if (serviciosActivos[0]) return { e: [409, 'SERVICIO_ACTIVO', 'Termina tu delivery activo antes de aceptar otro servicio.'] };
      if (comisionRequerida > 0) {
        await cx.execute('UPDATE billeteras SET saldo_comision_reservado=saldo_comision_reservado+? WHERE id=?', [comisionRequerida, c.billetera_id]);
      }
      await cx.execute(
        `UPDATE viajes SET estado='aceptado', conductor_id=?, moto_id=?, aceptado_en=UTC_TIMESTAMP(), comision_reservada=?, comision_monto=?
          WHERE id=? AND estado='solicitado'`,
        // comision_monto guarda los puntos reservados para liberar exactamente lo mismo al finalizar o cancelar.
        [c.conductor_id, c.moto_id, comisionRequerida > 0 ? 1 : 0, comisionRequerida, viajeId],
      );
      await cx.execute("UPDATE conductores SET estado_operativo='en_viaje' WHERE id=?", [c.conductor_id]);
      return { viaje: await obtenerDetalle(cx, viajeId) };
    });
    if (responderErrorDeOperacion(res, r)) return;
    notificarEstadoViaje(viajeId); // Etapa 9
    return ok(res, r.viaje);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return error(res, 409, 'CONDUCTOR_O_PASAJERO_OCUPADO', 'Tú o el pasajero ya tienen otro viaje activo.');
    throw e;
  }
});

// POST /viajes/:id/ubicacion — ubicación durante un viaje; solo el conductor asignado.
rutaViajes.post('/:id/ubicacion', autenticar, async (req, res) => {
  if (!ROLES_CONDUCTOR.includes(req.usuario.rol)) return error(res, 403, 'NO_ES_CONDUCTOR', 'Solo un conductor puede enviar ubicación del viaje.');
  const viajeId = numeroId(req.params.id);
  const p = validarCoordenadaUnica(req.body);
  if (!viajeId) return error(res, 400, 'ID_INVALIDO', 'El identificador del viaje no es válido.');
  if (!p) return error(res, 422, 'UBICACION_INVALIDA', 'La latitud, longitud, precisión o rumbo no son válidos.');
  const viaje = await obtenerDetalle(db, viajeId);
  if (!viaje) return error(res, 404, 'VIAJE_NO_ENCONTRADO', 'No se encontró el viaje.');
  if (!['aceptado', 'conductor_llego', 'en_curso'].includes(viaje.estado)) return error(res, 409, 'VIAJE_NO_ACTIVO', 'El viaje no admite nuevas ubicaciones.');
  const c = await datosConductor(db, req.usuario.id);
  if (!c || String(c.conductor_id) !== String(viaje.conductor_id)) return error(res, 403, 'VIAJE_AJENO', 'No estás asignado a este viaje.');
  await transaccion(async (cx) => {
    await cx.execute(
      `INSERT INTO conductor_ubicacion (conductor_id, latitud, longitud, rumbo_grados, precision_m, es_mock, actualizado_en)
       VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE latitud=VALUES(latitud), longitud=VALUES(longitud), rumbo_grados=VALUES(rumbo_grados),
         precision_m=VALUES(precision_m), es_mock=VALUES(es_mock), actualizado_en=UTC_TIMESTAMP(3)`,
      [c.conductor_id, p.latitud, p.longitud, p.rumbo, p.precision, p.esMock ? 1 : 0],
    );
    await cx.execute(
      `INSERT INTO ubicaciones_viaje (viaje_id, latitud, longitud, precision_m, rumbo_grados, registrado_en)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [viajeId, p.latitud, p.longitud, p.precision, p.rumbo],
    );
    return {};
  });
  if (!p.esMock) emitirUbicacionViaje(viajeId, p); // Etapa 9: solo posiciones reales
  return ok(res, { guardada: true, viaje_id: viajeId, registrado_en: new Date().toISOString() });
});

// POST /viajes/:id/llegada — conductor marca llegada únicamente dentro de tolerancia configurada.
rutaViajes.post('/:id/llegada', autenticar, async (req, res) => {
  if (!ROLES_CONDUCTOR.includes(req.usuario.rol)) return error(res, 403, 'NO_ES_CONDUCTOR', 'Solo el conductor asignado puede marcar llegada.');
  const id = numeroId(req.params.id);
  if (!id) return error(res, 400, 'ID_INVALIDO', 'El identificador del viaje no es válido.');
  const r = await transaccion(async (cx) => {
    const [rows] = await cx.execute('SELECT * FROM viajes WHERE id=? LIMIT 1 FOR UPDATE', [id]);
    const v = rows[0];
    if (!v) return { e: [404, 'VIAJE_NO_ENCONTRADO', 'No se encontró el viaje.'] };
    if (v.estado !== 'aceptado') return { e: [409, 'ESTADO_INVALIDO', 'El viaje debe estar aceptado para marcar la llegada.'] };
    const c = await datosConductor(cx, req.usuario.id, true);
    if (!c || String(c.conductor_id) !== String(v.conductor_id)) return { e: [403, 'VIAJE_AJENO', 'No estás asignado a este viaje.'] };
    const maxEdad = await ajusteNumero('ubicacion_max_antiguedad_s', 30);
    const ubi = await ubicacionConductor(cx, c.conductor_id, maxEdad, true);
    if (!ubi) return { e: [409, 'UBICACION_NO_ACTUALIZADA', 'Actualiza tu ubicación antes de marcar llegada.'] };
    const tolerancia = await ajusteNumero('tolerancia_llegada_m', 150);
    const metros = haversineMetros(Number(ubi.latitud), Number(ubi.longitud), Number(v.origen_lat), Number(v.origen_lng));
    if (metros > tolerancia) return { e: [409, 'DEMASIADO_LEJOS', `Debes estar a ${tolerancia} m o menos del punto de recogida.`, { distancia_m: Math.round(metros), tolerancia_m: tolerancia }] };
    await cx.execute("UPDATE viajes SET estado='conductor_llego', llegada_en=UTC_TIMESTAMP() WHERE id=?", [id]);
    return { viaje: await obtenerDetalle(cx, id) };
  });
  if (responderErrorDeOperacion(res, r)) return;
  notificarEstadoViaje(id); // Etapa 9
  return ok(res, r.viaje);
});

// POST /viajes/:id/confirmar-casco — confirmación del pasajero antes de iniciar el viaje.
rutaViajes.post('/:id/confirmar-casco', autenticar, async (req, res) => {
  const id = numeroId(req.params.id);
  if (!id) return error(res, 400, 'ID_INVALIDO', 'El identificador del viaje no es válido.');
  const r = await transaccion(async (cx) => {
    const [rows] = await cx.execute('SELECT * FROM viajes WHERE id=? LIMIT 1 FOR UPDATE', [id]);
    const v = rows[0];
    if (!v) return { e: [404, 'VIAJE_NO_ENCONTRADO', 'No se encontró el viaje.'] };
    if (String(v.pasajero_id) !== String(req.usuario.id)) return { e: [403, 'VIAJE_AJENO', 'Solo el pasajero del viaje puede confirmar el casco.'] };
    if (v.estado !== 'conductor_llego') return { e: [409, 'ESTADO_INVALIDO', 'Confirma el casco cuando el conductor haya marcado su llegada.'] };
    await cx.execute('UPDATE viajes SET casco_confirmado_en=COALESCE(casco_confirmado_en, UTC_TIMESTAMP()) WHERE id=?', [id]);
    return { viaje: await obtenerDetalle(cx, id) };
  });
  if (responderErrorDeOperacion(res, r)) return;
  notificarEstadoViaje(id); // Etapa 9
  return ok(res, r.viaje);
});

// POST /viajes/:id/iniciar — exige llegada del conductor y confirmación del casco por el pasajero.
rutaViajes.post('/:id/iniciar', autenticar, async (req, res) => {
  if (!ROLES_CONDUCTOR.includes(req.usuario.rol)) return error(res, 403, 'NO_ES_CONDUCTOR', 'Solo el conductor asignado puede iniciar el viaje.');
  const id = numeroId(req.params.id);
  if (!id) return error(res, 400, 'ID_INVALIDO', 'El identificador del viaje no es válido.');
  const r = await transaccion(async (cx) => {
    const [rows] = await cx.execute('SELECT * FROM viajes WHERE id=? LIMIT 1 FOR UPDATE', [id]);
    const v = rows[0];
    if (!v) return { e: [404, 'VIAJE_NO_ENCONTRADO', 'No se encontró el viaje.'] };
    if (v.estado !== 'conductor_llego') return { e: [409, 'ESTADO_INVALIDO', 'El viaje debe estar en estado conductor_llego.'] };
    if (!v.casco_confirmado_en) return { e: [409, 'CASCO_NO_CONFIRMADO', 'El pasajero debe confirmar que recibió el casco antes de iniciar.'] };
    const c = await datosConductor(cx, req.usuario.id, true);
    if (!c || String(c.conductor_id) !== String(v.conductor_id)) return { e: [403, 'VIAJE_AJENO', 'No estás asignado a este viaje.'] };
    await cx.execute("UPDATE viajes SET estado='en_curso', iniciado_en=UTC_TIMESTAMP() WHERE id=?", [id]);
    return { viaje: await obtenerDetalle(cx, id) };
  });
  if (responderErrorDeOperacion(res, r)) return;
  notificarEstadoViaje(id); // Etapa 9
  return ok(res, r.viaje);
});

// POST /viajes/:id/finalizar — solo finaliza si el conductor está junto al destino.
rutaViajes.post('/:id/finalizar', autenticar, async (req, res) => {
  if (!ROLES_CONDUCTOR.includes(req.usuario.rol)) return error(res, 403, 'NO_ES_CONDUCTOR', 'Solo el conductor asignado puede finalizar el viaje.');
  const id = numeroId(req.params.id);
  if (!id) return error(res, 400, 'ID_INVALIDO', 'El identificador del viaje no es válido.');
  const r = await transaccion(async (cx) => {
    const [rows] = await cx.execute('SELECT * FROM viajes WHERE id=? LIMIT 1 FOR UPDATE', [id]);
    const v = rows[0];
    if (!v) return { e: [404, 'VIAJE_NO_ENCONTRADO', 'No se encontró el viaje.'] };
    if (v.estado !== 'en_curso') return { e: [409, 'ESTADO_INVALIDO', 'Solo se puede finalizar un viaje que está en curso.'] };
    const c = await datosConductor(cx, req.usuario.id, true);
    if (!c || String(c.conductor_id) !== String(v.conductor_id)) return { e: [403, 'VIAJE_AJENO', 'No estás asignado a este viaje.'] };
    const maxEdad = await ajusteNumero('ubicacion_max_antiguedad_s', 30);
    const ubi = await ubicacionConductor(cx, c.conductor_id, maxEdad, true);
    if (!ubi) return { e: [409, 'UBICACION_NO_ACTUALIZADA', 'Actualiza tu ubicación antes de finalizar el viaje.'] };
    const tolerancia = await ajusteNumero('tolerancia_llegada_m', 150);
    const metros = haversineMetros(Number(ubi.latitud), Number(ubi.longitud), Number(v.destino_lat), Number(v.destino_lng));
    if (metros > tolerancia) return { e: [409, 'DEMASIADO_LEJOS', `Debes estar a ${tolerancia} m o menos del destino para finalizar.`, { distancia_m: Math.round(metros), tolerancia_m: tolerancia }] };
    const tarifaFinal = enteroBs(Number(v.tarifa_estimada));
    // Sistema de puntos: siempre se descuentan config.puntosPorViaje puntos por viaje completado.
    // La tarifa la cobra el conductor íntegra; los puntos no son dinero.
    const comisionFinal = config.puntosPorViaje;
    const gananciaFinal = tarifaFinal;
    // Reserva a liberar: los puntos guardados al aceptar; viajes antiguos usan su cálculo porcentual original.
    const montoReservado = v.comision_monto != null
      ? Number(v.comision_monto)
      : enteroBs(Number(v.tarifa_estimada) * Number(v.comision_porcentaje) / 100);
    const [wallets] = await cx.execute(
      'SELECT id, saldo_prepago, saldo_comision_reservado FROM billeteras WHERE conductor_id=? LIMIT 1 FOR UPDATE',
      [c.conductor_id],
    );
    const billeteraConductor = wallets[0];
    if (!billeteraConductor) return { e: [409, 'BILLETERA_NO_CREADA', 'No se encontró el saldo de comisiones del conductor.'] };
    const comisionAntes = Number(billeteraConductor.saldo_prepago);
    const reservaActiva = Number(v.comision_reservada ?? 0) === 1;
    const reservaWallet = Number(billeteraConductor.saldo_comision_reservado ?? 0);
    const libreParaEsteViaje = reservaActiva ? comisionAntes : redondear(Math.max(0, comisionAntes - reservaWallet));
    const reservasInconsistentes = reservaActiva && comisionAntes < reservaWallet;
    if (comisionFinal > 0 && (libreParaEsteViaje < comisionFinal || (reservaActiva && reservaWallet < montoReservado) || reservasInconsistentes)) {
      const motivo = `Saldo/reserva insuficiente al finalizar el viaje #${id}; requiere conciliación administrativa.`;
      await cx.execute("UPDATE viajes SET estado='requiere_revision',motivo_revision=?,comision_reservada=0 WHERE id=?", [motivo.slice(0,255), id]);
      await cx.execute("UPDATE conductores SET estado_operativo='bloqueado_saldo' WHERE id=?", [c.conductor_id]);
      return { revisionPendiente: true, viaje_id: id, motivo, mensaje: 'El viaje se guardó para revisión administrativa. No se descontó una comisión parcial.' };
    }
    const comisionDespues = redondear(comisionAntes - comisionFinal);
    // El pasajero liquida el importe directamente al conductor (efectivo o QR personal).
    // De Volada solo descuenta la comisión prepaga. Si había reserva, la libera al convertirla en débito.
    await cx.execute(
      'UPDATE billeteras SET saldo_prepago=?, saldo_comision_reservado=GREATEST(0,saldo_comision_reservado-?) WHERE id=?',
      [comisionDespues, reservaActiva ? montoReservado : 0, billeteraConductor.id],
    );
    if (comisionFinal > 0) {
      await cx.execute(
        `INSERT INTO movimientos_billetera
           (billetera_id, cuenta, tipo, monto, saldo_antes, saldo_despues, viaje_id, descripcion, idempotency_key)
         VALUES (?, 'prepago', 'comision', ?, ?, ?, ?, ?, ?)`,
        [billeteraConductor.id, -comisionFinal, comisionAntes, comisionDespues, id, `Comisión viaje #${id}: -${config.puntosPorViaje} pts`, `comision:viaje:${id}`],
      );
    }
    await cx.execute(
      `UPDATE viajes
          SET estado='finalizado', tarifa_final=?, comision_monto=?, ganancia_conductor=?, finalizado_en=UTC_TIMESTAMP(), comision_reservada=0
        WHERE id=?`,
      [tarifaFinal, comisionFinal, gananciaFinal, id],
    );
    // Si ya no le alcanzan los puntos para otro servicio, queda bloqueado hasta recargar.
    const saldoMinimoOperativo = config.puntosPorViaje;
    await cx.execute(
      `UPDATE conductores
          SET estado_operativo = ?, total_viajes = total_viajes + 1
        WHERE id = ?`,
      [comisionDespues < saldoMinimoOperativo ? 'bloqueado_saldo' : 'disponible', c.conductor_id],
    );
    return { viaje: await obtenerDetalle(cx, id), nota: `Cobro marcado como ${v.metodo_pago === 'digital' ? 'QR directo al conductor' : 'efectivo'}; se descontaron ${comisionFinal} puntos De Volada.`, puntos_descontados: comisionFinal, puntos_restantes: comisionDespues };
  });
  if (responderErrorDeOperacion(res, r)) return;
  notificarEstadoViaje(id); // Etapa 9
  if (r.revisionPendiente) return error(res, 409, 'REVISION_ADMINISTRATIVA', r.mensaje, { viaje_id: id, motivo: r.motivo });
  return ok(res, r);
});

// POST /viajes/:id/cancelar — pasajero puede cancelar solicitado/aceptado/conductor_llego;
// conductor asignado puede cancelar aceptado/conductor_llego. No permite cancelar en curso.
rutaViajes.post('/:id/cancelar', autenticar, async (req, res) => {
  const id = numeroId(req.params.id);
  if (!id) return error(res, 400, 'ID_INVALIDO', 'El identificador del viaje no es válido.');
  const motivo = String(req.body?.motivo ?? 'Cancelado desde la aplicación').trim().slice(0, 255) || 'Cancelado desde la aplicación';
  const r = await transaccion(async (cx) => {
    const [rows] = await cx.execute('SELECT * FROM viajes WHERE id=? LIMIT 1 FOR UPDATE', [id]);
    const v = rows[0];
    if (!v) return { e: [404, 'VIAJE_NO_ENCONTRADO', 'No se encontró el viaje.'] };
    const esPasajero = String(v.pasajero_id) === String(req.usuario.id);
    let c = null;
    if (v.conductor_id != null) {
      const [cs] = await cx.execute('SELECT id, usuario_id FROM conductores WHERE id=? LIMIT 1', [v.conductor_id]);
      c = cs[0] ?? null;
    }
    const esConductor = Boolean(c && String(c.usuario_id) === String(req.usuario.id) && req.usuario.rol === 'conductor');
    if (!esPasajero && !esConductor) return { e: [403, 'VIAJE_AJENO', 'No tienes permiso para cancelar este viaje.'] };
    let nuevoEstado;
    if (esPasajero && ['solicitado', 'aceptado', 'conductor_llego'].includes(v.estado)) nuevoEstado = 'cancelado_pasajero';
    else if (esConductor && ['aceptado', 'conductor_llego'].includes(v.estado)) nuevoEstado = 'cancelado_conductor';
    else return { e: [409, 'CANCELACION_NO_PERMITIDA', 'El estado actual del viaje no permite cancelarlo.'] };

    // comision_monto se limpia: un viaje cancelado no genera descuento de puntos.
    await cx.execute('UPDATE viajes SET estado=?, motivo_cancelacion=?, cancelado_en=UTC_TIMESTAMP(), comision_reservada=0, comision_monto=NULL WHERE id=?', [nuevoEstado, motivo, id]);
    if (v.conductor_id != null && Number(v.comision_reservada ?? 0) === 1) {
      const comisionReservada = v.comision_monto != null
        ? Number(v.comision_monto)
        : enteroBs(Number(v.tarifa_estimada) * Number(v.comision_porcentaje) / 100);
      const [bsRes] = await cx.execute('SELECT id,saldo_prepago,saldo_comision_reservado FROM billeteras WHERE conductor_id=? LIMIT 1 FOR UPDATE', [v.conductor_id]);
      if (bsRes[0]) {
        await cx.execute('UPDATE billeteras SET saldo_comision_reservado=GREATEST(0,saldo_comision_reservado-?) WHERE id=?', [comisionReservada, bsRes[0].id]);
        const minimo = config.puntosPorViaje;
        const libre = redondear(Number(bsRes[0].saldo_prepago) - Math.max(0, Number(bsRes[0].saldo_comision_reservado) - comisionReservada));
        await cx.execute('UPDATE conductores SET estado_operativo=? WHERE id=?', [libre >= minimo ? 'disponible' : 'bloqueado_saldo', v.conductor_id]);
      }
    }

    // Compatibilidad de una sola vez: devuelve saldo únicamente a viajes antiguos que sí
    // registraron un débito de billetera del pasajero antes de adoptar el QR directo.
    if (v.metodo_pago === 'digital') {
      const [bs] = await cx.execute('SELECT id, saldo FROM billeteras_pasajero WHERE usuario_id=? LIMIT 1 FOR UPDATE', [v.pasajero_id]);
      const bPasajero = bs[0];
      if (bPasajero) {
        const [debito] = await cx.execute('SELECT monto FROM movimientos_billetera_pasajero WHERE billetera_id=? AND idempotency_key=? LIMIT 1', [bPasajero.id, `pago:viaje:${id}`]);
        const [devolucion] = await cx.execute('SELECT id FROM movimientos_billetera_pasajero WHERE billetera_id=? AND idempotency_key=? LIMIT 1', [bPasajero.id, `reembolso:viaje:${id}`]);
        if (debito[0] && !devolucion[0]) {
          const importe = redondear(Math.abs(Number(debito[0].monto)));
          const antes = Number(bPasajero.saldo);
          const despues = redondear(antes + importe);
          await cx.execute('UPDATE billeteras_pasajero SET saldo=? WHERE id=?', [despues, bPasajero.id]);
          await cx.execute(
            `INSERT INTO movimientos_billetera_pasajero (billetera_id, tipo, monto, saldo_antes, saldo_despues, viaje_id, descripcion, idempotency_key)
             VALUES (?, 'reembolso', ?, ?, ?, ?, ?, ?)`,
            [bPasajero.id, importe, antes, despues, id, `Devolución heredada por cancelación del viaje #${id}`, `reembolso:viaje:${id}`],
          );
        }
      }
    }
    if (v.conductor_id != null) {
      await cx.execute("UPDATE conductores SET estado_operativo='disponible' WHERE id=? AND estado_operativo='en_viaje'", [v.conductor_id]);
    }

    let restriccionAplicada = false;
    if (esPasajero) {
      const maxCancelaciones = Math.max(1, Math.floor(await ajusteNumero('cancelaciones_max_dia', 3)));
      const horas = Math.max(1, Math.min(168, Math.floor(await ajusteNumero('restriccion_cancelaciones_h', 24))));
      const [cuenta] = await cx.execute(
        `SELECT COUNT(*) AS total FROM viajes
          WHERE pasajero_id=? AND estado='cancelado_pasajero'
            AND cancelado_en >= UTC_TIMESTAMP() - INTERVAL 1 DAY`,
        [req.usuario.id],
      );
      if (Number(cuenta[0]?.total) >= maxCancelaciones) {
        await cx.execute(
          `UPDATE usuarios SET restringido_hasta=UTC_TIMESTAMP() + INTERVAL ${horas} HOUR,
             restriccion_motivo='Exceso de cancelaciones de viajes' WHERE id=?`,
          [req.usuario.id],
        );
        restriccionAplicada = true;
      }
    }
    return { viaje: await obtenerDetalle(cx, id), restriccion_aplicada: restriccionAplicada };
  });
  if (responderErrorDeOperacion(res, r)) return;
  notificarEstadoViaje(id, { cancelado_por: req.usuario.rol === 'conductor' ? 'conductor' : 'pasajero' }); // Etapa 9
  return ok(res, r);
});

// GET /viajes/activo — viaje en curso del usuario (pasajero o conductor), o null.
// Permite a la app recuperar el viaje al reabrirla.
rutaViajes.get('/activo', autenticar, async (req, res) => {
  const [filas] = await db.execute(
    `SELECT v.id FROM viajes v
       LEFT JOIN conductores c ON c.id = v.conductor_id
      WHERE (v.pasajero_id = ? OR c.usuario_id = ?)
        AND v.estado IN ('solicitado','aceptado','conductor_llego','en_curso')
      ORDER BY v.solicitado_en DESC LIMIT 1`,
    [req.usuario.id, req.usuario.id],
  );
  if (!filas[0]) return ok(res, { viaje: null });
  return ok(res, { viaje: await obtenerDetalle(db, filas[0].id) });
});

// GET /viajes/:id — visible únicamente para el pasajero o conductor asignado.
rutaViajes.get('/:id', autenticar, async (req, res) => {
  const id = numeroId(req.params.id);
  if (!id) return error(res, 400, 'ID_INVALIDO', 'El identificador del viaje no es válido.');
  const viaje = await obtenerDetalle(db, id);
  if (!viaje) return error(res, 404, 'VIAJE_NO_ENCONTRADO', 'No se encontró el viaje.');
  if (!(await tienePermisoVerViaje(db, viaje, req.usuario.id))) return error(res, 404, 'VIAJE_NO_ENCONTRADO', 'No se encontró el viaje.');
  return ok(res, viaje);
});
