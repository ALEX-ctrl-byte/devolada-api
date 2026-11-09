import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';
import { ajusteNumero } from '../servicios/ajustes.js';
import { config } from '../config.js';
import { obtenerRutaOSRM } from '../servicios/osrm.js';
import { calcularTarifaDeUna, enteroBs, crearTokenCotizacionTarifa, leerTokenCotizacionTarifa } from '../servicios/tarifas.js';
import { hashOtp, generarCodigoOtp, iguales } from '../seguridad.js';
import { emitirActualizacionEnvio, avisarOfertaEnvio } from '../tiempoReal.js';

export const rutaEnvios = Router();
rutaEnvios.use(autenticar);

const ID = (v) => /^\d{1,18}$/.test(String(v ?? '')) && Number(v) > 0 ? Number(v) : null;
const dinero = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const idempotencia = (v) => /^[A-Za-z0-9._:-]{8,64}$/.test(String(v ?? '').trim());
const coord = (lat, lng) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Number(lat) >= -90 && Number(lat) <= 90 && Number(lng) >= -180 && Number(lng) <= 180;
const mismoPunto = (aLat, aLng, bLat, bLng) => Math.abs(Number(aLat) - Number(bLat)) < 0.00001 && Math.abs(Number(aLng) - Number(bLng)) < 0.00001;

// Los PIN se cifran con AES-GCM usando una clave derivada de OTP_SECRET; la BD no guarda el PIN en claro.
function clavePin() { return crypto.createHash('sha256').update(`deuna-envios-pin|${process.env.OTP_SECRET ?? 'clave-solo-para-desarrollo'}`).digest(); }
function cifrarPin(pin) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', clavePin(), iv);
  const ciphertext = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
function descifrarPin(valor) {
  if (!valor) return null;
  try {
    const data = Buffer.from(valor, 'base64url');
    if (data.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', clavePin(), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  } catch { return null; }
}
function hashPin(telefono, uso, pin) { return hashOtp(telefono, uso, pin); }
function compararPin(telefono, uso, pin, hash) { return iguales(hashPin(telefono, uso, pin), hash ?? ''); }
function distanciaMetros(lat1, lng1, lat2, lng2) {
  const rad = (n) => n * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat/2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng/2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
async function tx(fn) {
  const cx = await db.getConnection();
  try {
    await cx.beginTransaction();
    const result = await fn(cx);
    if (result?.e) { await cx.rollback(); return result; }
    await cx.commit(); return result;
  } catch (e) { await cx.rollback().catch(() => {}); throw e; }
  finally { cx.release(); }
}
async function gpsReciente(cx, conductorId) {
  const [rows] = await cx.execute(
    `SELECT latitud,longitud,es_mock,actualizado_en FROM conductor_ubicacion
      WHERE conductor_id=? AND es_mock=0 AND actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND LIMIT 1 FOR UPDATE`, [conductorId],
  );
  return rows[0] ? { lat: Number(rows[0].latitud), lng: Number(rows[0].longitud) } : null;
}
async function datosEnvio(id) {
  const [rows] = await db.execute(
    `SELECT e.*, ur.nombre AS remitente_nombre, ur.telefono AS remitente_telefono,
            ud.nombre AS destinatario_nombre, ud.telefono AS destinatario_telefono,
            c.usuario_id AS conductor_usuario_id, uc.nombre AS conductor_nombre, uc.apellido AS conductor_apellido,
            m.placa AS vehiculo_placa, m.marca AS vehiculo_marca, m.modelo AS vehiculo_modelo, m.color AS vehiculo_color
       FROM envios e JOIN usuarios ur ON ur.id=e.remitente_id JOIN usuarios ud ON ud.id=e.destinatario_id
       LEFT JOIN conductores c ON c.id=e.conductor_id LEFT JOIN usuarios uc ON uc.id=c.usuario_id
       LEFT JOIN motos m ON m.conductor_id=e.conductor_id WHERE e.id=? LIMIT 1`, [id],
  );
  return rows[0] ?? null;
}
function mostrarEnvio(e, usuarioId, incluirPinEntrega = false) {
  const esRemitente = String(e.remitente_id) === String(usuarioId);
  const esDestinatario = String(e.destinatario_id) === String(usuarioId);
  const esConductor = String(e.conductor_usuario_id ?? '') === String(usuarioId);
  const salida = {
    id: Number(e.id), estado: e.estado, tipo_vehiculo: e.tipo_vehiculo, descripcion_paquete: e.descripcion_paquete,
    recogida_nombre: e.recogida_nombre, recogida_telefono: esRemitente || esConductor ? e.recogida_telefono : null,
    recogida_direccion: e.recogida_direccion, recogida_lat: Number(e.recogida_lat), recogida_lng: Number(e.recogida_lng),
    entrega_nombre: e.entrega_nombre, entrega_telefono: esRemitente || esConductor ? e.entrega_telefono : null,
    entrega_direccion: e.entrega_direccion, entrega_lat: Number(e.entrega_lat), entrega_lng: Number(e.entrega_lng),
    distancia_m: e.distancia_m == null ? null : Number(e.distancia_m), duracion_estimada_s: e.duracion_estimada_s == null ? null : Number(e.duracion_estimada_s),
    distancia_aproximacion_m: e.distancia_aproximacion_m == null ? null : Number(e.distancia_aproximacion_m), duracion_aproximacion_s: e.duracion_aproximacion_s == null ? null : Number(e.duracion_aproximacion_s),
    detalle_tarifa: typeof e.detalle_tarifa_json === 'string' ? (() => { try { return JSON.parse(e.detalle_tarifa_json); } catch { return null; } })() : (e.detalle_tarifa_json ?? null), tarifa_estimada: enteroBs(e.tarifa_estimada),
    comision_monto: enteroBs(e.comision_monto), metodo_pago: e.metodo_pago, creado_en: e.creado_en,
    asignado_en: e.asignado_en, recogido_en: e.recogido_en, llegada_en: e.llegada_en, entregado_en: e.entregado_en,
    remitente_nombre: e.remitente_nombre, destinatario_nombre: e.destinatario_nombre,
    conductor_nombre: e.conductor_usuario_id ? [e.conductor_nombre, e.conductor_apellido].filter(Boolean).join(' ') : null,
    vehiculo_placa: e.vehiculo_placa ?? null, vehiculo_marca: e.vehiculo_marca ?? null,
    vehiculo_modelo: e.vehiculo_modelo ?? null, vehiculo_color: e.vehiculo_color ?? null,
    qr_conductor_url: esRemitente && e.estado !== 'entregado' && e.metodo_pago === 'qr' ? e.qr_conductor_snapshot : null,
    codigo_recogida: esRemitente && ['solicitado','asignado'].includes(e.estado) ? descifrarPin(e.codigo_recogida_cifrado) : null,
    codigo_entrega: esDestinatario && incluirPinEntrega && e.estado === 'en_punto_entrega' && e.codigo_entrega_expira_en && new Date(e.codigo_entrega_expira_en).getTime() > Date.now() ? descifrarPin(e.codigo_entrega_cifrado) : null,
    puede_cancelar: esRemitente && e.estado === 'solicitado',
  };
  if (!esRemitente && !esDestinatario && !esConductor) return null;
  // No divulgar ubicación exacta del punto de recojo a la persona destinataria antes de que el conductor acepte.
  if (esDestinatario && !esConductor) { salida.recogida_lat = null; salida.recogida_lng = null; salida.recogida_direccion = 'Disponible cuando el envío sea asignado'; }
  return salida;
}


// POST /envios/cotizar — calcula y firma el precio de un envío personal antes de confirmar.
rutaEnvios.post('/cotizar', async (req, res) => {
  if (req.usuario.rol !== 'pasajero') return error(res, 403, 'ROL_NO_ADMITIDO', 'Solo las cuentas pasajeras pueden cotizar un envío.');
  const b = req.body ?? {};
  const tipoVehiculo = String(b.tipo_vehiculo ?? 'moto').trim().toLowerCase();
  const oLat = Number(b.recogida_lat), oLng = Number(b.recogida_lng), dLat = Number(b.entrega_lat), dLng = Number(b.entrega_lng);
  if (!coord(oLat, oLng) || !coord(dLat, dLng) || mismoPunto(oLat, oLng, dLat, dLng) || !['moto', 'auto'].includes(tipoVehiculo)) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Selecciona recogida, destino y vehículo para cotizar el envío.');
  }
  let ruta;
  try { ruta = await obtenerRutaOSRM({ lat: oLat, lng: oLng }, { lat: dLat, lng: dLng }); }
  catch (e) { return error(res, e.estadoHttp ?? 502, e.codigo ?? 'RUTA_NO_DISPONIBLE', e.message ?? 'No se pudo calcular la ruta del envío.'); }
  let calculo;
  try {
    calculo = await calcularTarifaDeUna({ tipoServicio: 'envio_persona_a_persona', tipoVehiculo, origen: { lat: oLat, lng: oLng }, rutaServicio: ruta });
  } catch (e) {
    console.error('[tarifas] no se pudo cotizar envío personal', e.message);
    return error(res, 503, 'TARIFA_NO_DISPONIBLE', 'No se pudo calcular la tarifa del envío. Intenta nuevamente.');
  }
  const ahora = Math.floor(Date.now() / 1000);
  const tarifaBs = enteroBs(calculo.tarifa_bs);
  const comisionPorcentaje = Math.max(0, Math.min(100, await ajusteNumero('comision_porcentaje_delivery', 10)));
  // Sistema de puntos: descuento fijo por envío completado (comisionPorcentaje queda como histórico).
  const comisionBs = config.puntosPorViaje;
  const tokenDatos = {
    v: 1, tipo_servicio: 'envio_persona_a_persona', usuario_id: Number(req.usuario.id), tipo_vehiculo: tipoVehiculo,
    origen: { lat: Number(oLat), lng: Number(oLng) }, destino: { lat: Number(dLat), lng: Number(dLng) },
    distancia_m: Number(ruta.distancia_m), duracion_estimada_s: Number(ruta.duracion_estimada_s),
    tarifa_bs: tarifaBs, comision_porcentaje: comisionPorcentaje, comision_bs: comisionBs,
    detalle_tarifa: calculo.detalle, expira_en: ahora + 180,
  };
  return ok(res, {
    cotizacion_token: crearTokenCotizacionTarifa(tokenDatos),
    expira_en: new Date((ahora + 180) * 1000).toISOString(),
    tipo_vehiculo: tipoVehiculo, distancia_m: tokenDatos.distancia_m,
    duracion_estimada_min: Math.max(1, Math.round(tokenDatos.duracion_estimada_s / 60)),
    tarifa_estimada_bs: tokenDatos.tarifa_bs, comision_estimada_bs: tokenDatos.comision_bs, comision_puntos: tokenDatos.comision_bs,
    comision_porcentaje: tokenDatos.comision_porcentaje, detalle_tarifa: tokenDatos.detalle_tarifa, moneda: 'BOB',
  });
});

rutaEnvios.post('/', async (req, res) => {
  if (req.usuario.rol !== 'pasajero') return error(res, 403, 'ROL_NO_ADMITIDO', 'Solo las cuentas pasajeras pueden solicitar un envío.');
  const b = req.body ?? {};
  const descripcion = String(b.descripcion_paquete ?? '').trim().slice(0, 255);
  const nombreRecojo = String(b.recogida_nombre ?? `${req.usuario.nombre ?? ''} ${req.usuario.apellido ?? ''}`.trim()).trim().slice(0, 120);
  const telRecojo = String(b.recogida_telefono ?? req.usuario.telefono).trim();
  const dirRecojo = String(b.recogida_direccion ?? '').trim().slice(0, 255);
  const nombreEntrega = String(b.entrega_nombre ?? '').trim().slice(0, 120);
  const telEntrega = String(b.entrega_telefono ?? '').trim();
  const dirEntrega = String(b.entrega_direccion ?? '').trim().slice(0, 255);
  const tipoVehiculo = String(b.tipo_vehiculo ?? 'moto');
  const metodoPago = String(b.metodo_pago ?? 'efectivo');
  const key = String(b.idempotency_key ?? '').trim();
  const oLat = Number(b.recogida_lat), oLng = Number(b.recogida_lng), dLat = Number(b.entrega_lat), dLng = Number(b.entrega_lng);
  if (descripcion.length < 3 || nombreRecojo.length < 2 || !/^\+591\d{8}$/.test(telRecojo) || dirRecojo.length < 5
      || !coord(oLat,oLng) || nombreEntrega.length < 2 || !/^\+591\d{8}$/.test(telEntrega) || dirEntrega.length < 5
      || !coord(dLat,dLng) || mismoPunto(oLat,oLng,dLat,dLng) || !['moto','auto'].includes(tipoVehiculo)
      || !['efectivo','qr'].includes(metodoPago) || !idempotencia(key)) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Completa descripción, contactos bolivianos, ambas direcciones seleccionadas en el mapa, vehículo y clave de solicitud.');
  }
  const [destinatarios] = await db.execute(
    `SELECT id, nombre, telefono FROM usuarios WHERE telefono=? AND telefono_verificado=1 AND estado='activo' LIMIT 1`, [telEntrega],
  );
  const destino = destinatarios[0];
  if (!destino) return error(res, 422, 'DESTINATARIO_NO_VERIFICADO', 'El destinatario debe tener una cuenta De Volada activa con ese número verificado. Pídele que se registre o compruebe su celular.');
  if (String(destino.id) === String(req.usuario.id)) return error(res, 422, 'DESTINATARIO_INVALIDO', 'El destinatario debe ser otra cuenta.');
  let ruta;
  let calculoTarifa;
  let cotizacionConfirmada = null;
  if (b.cotizacion_token) {
    const cotizacion = leerTokenCotizacionTarifa(b.cotizacion_token);
    const coincide = cotizacion && !cotizacion.expirada
      && cotizacion.tipo_servicio === 'envio_persona_a_persona'
      && cotizacion.usuario_id === Number(req.usuario.id)
      && cotizacion.tipo_vehiculo === tipoVehiculo
      && Math.abs(Number(cotizacion.origen?.lat) - oLat) < 0.000001
      && Math.abs(Number(cotizacion.origen?.lng) - oLng) < 0.000001
      && Math.abs(Number(cotizacion.destino?.lat) - dLat) < 0.000001
      && Math.abs(Number(cotizacion.destino?.lng) - dLng) < 0.000001;
    if (!coincide) return error(res, 409, cotizacion?.expirada ? 'COTIZACION_CADUCADA' : 'COTIZACION_INVALIDA', 'La tarifa cambió o la cotización venció. Actualiza el precio antes de solicitar el envío.');
    cotizacionConfirmada = cotizacion;
    ruta = { distancia_m: Number(cotizacion.distancia_m), duracion_estimada_s: Number(cotizacion.duracion_estimada_s) };
    calculoTarifa = { tarifa_bs: enteroBs(cotizacion.tarifa_bs), detalle: cotizacion.detalle_tarifa };
  } else {
    try { ruta = await obtenerRutaOSRM({ lat: oLat, lng: oLng }, { lat: dLat, lng: dLng }); }
    catch (e) { return error(res, e.estadoHttp ?? 502, e.codigo ?? 'RUTA_NO_DISPONIBLE', e.message ?? 'No se pudo calcular la ruta del envío.'); }
    try {
      calculoTarifa = await calcularTarifaDeUna({ tipoServicio: 'envio_persona_a_persona', tipoVehiculo, origen: { lat: oLat, lng: oLng }, rutaServicio: ruta });
    } catch (e) {
      console.error('[tarifas] no se pudo cotizar envío personal', e.message);
      return error(res, 503, 'TARIFA_NO_DISPONIBLE', 'No se pudo calcular la tarifa del envío. Intenta nuevamente.');
    }
  }
  const tarifa = enteroBs(calculoTarifa.tarifa_bs);
  const porcentaje = cotizacionConfirmada
    ? Math.max(0, Math.min(100, Number(cotizacionConfirmada.comision_porcentaje)))
    : Math.max(0, Math.min(100, await ajusteNumero('comision_porcentaje_delivery', 10)));
  // Sistema de puntos: siempre config.puntosPorViaje puntos por envío completado.
  const comision = config.puntosPorViaje;
  const pickupPin = generarCodigoOtp();
  const result = await tx(async (cx) => {
    const [ex] = await cx.execute('SELECT id, estado, codigo_recogida_cifrado FROM envios WHERE remitente_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE', [req.usuario.id, key]);
    if (ex[0]) return { repetido: ex[0] };
    const [ins] = await cx.execute(
      `INSERT INTO envios (remitente_id,destinatario_id,tipo_vehiculo,descripcion_paquete,recogida_nombre,recogida_telefono,recogida_direccion,recogida_lat,recogida_lng,
        entrega_nombre,entrega_telefono,entrega_direccion,entrega_lat,entrega_lng,distancia_m,duracion_estimada_s,distancia_aproximacion_m,duracion_aproximacion_s,detalle_tarifa_json,
        tarifa_estimada,comision_porcentaje,comision_monto,metodo_pago,codigo_recogida_hash,codigo_recogida_cifrado,idempotency_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.usuario.id,destino.id,tipoVehiculo,descripcion,nombreRecojo,telRecojo,dirRecojo,oLat,oLng,nombreEntrega,telEntrega,dirEntrega,dLat,dLng,
       ruta.distancia_m,ruta.duracion_estimada_s,calculoTarifa.detalle.distancia_aproximacion_m,calculoTarifa.detalle.duracion_aproximacion_s,JSON.stringify(calculoTarifa.detalle),
       tarifa,porcentaje,comision,metodoPago,hashPin(telRecojo,'envio-recogida',pickupPin),cifrarPin(pickupPin),key],
    );
    return { id: Number(ins.insertId), pickupPin };
  });
  if (result.repetido) {
    const e = await datosEnvio(result.repetido.id);
    return ok(res, { envio: mostrarEnvio(e, req.usuario.id), mensaje: 'Esta solicitud ya había sido registrada.' });
  }
  await avisarOfertaEnvio(result.id);
  const e = await datosEnvio(result.id);
  return ok(res, { envio: mostrarEnvio(e, req.usuario.id), codigo_recogida: result.pickupPin, detalle_tarifa: calculoTarifa.detalle, mensaje: 'Envío solicitado. Comparte el código de recogida solo con la persona que entregará el paquete al conductor.' }, 201);
});

rutaEnvios.get('/mios', async (req, res) => {
  const [rows] = await db.execute(
    `SELECT e.*, c.usuario_id AS conductor_usuario_id, uc.nombre AS conductor_nombre, uc.apellido AS conductor_apellido,
            m.placa AS vehiculo_placa,m.marca AS vehiculo_marca,m.modelo AS vehiculo_modelo,m.color AS vehiculo_color,
            ur.nombre AS remitente_nombre,ur.telefono AS remitente_telefono,ud.nombre AS destinatario_nombre,ud.telefono AS destinatario_telefono
       FROM envios e JOIN usuarios ur ON ur.id=e.remitente_id JOIN usuarios ud ON ud.id=e.destinatario_id
       LEFT JOIN conductores c ON c.id=e.conductor_id LEFT JOIN usuarios uc ON uc.id=c.usuario_id LEFT JOIN motos m ON m.conductor_id=c.id
      WHERE e.remitente_id=? ORDER BY e.creado_en DESC LIMIT 50`, [req.usuario.id],
  );
  return ok(res, { envios: rows.map((e) => mostrarEnvio(e, req.usuario.id)) });
});

rutaEnvios.get('/recibidos', async (req, res) => {
  const [rows] = await db.execute(
    `SELECT e.*, c.usuario_id AS conductor_usuario_id, uc.nombre AS conductor_nombre, uc.apellido AS conductor_apellido,
            m.placa AS vehiculo_placa,m.marca AS vehiculo_marca,m.modelo AS vehiculo_modelo,m.color AS vehiculo_color,
            ur.nombre AS remitente_nombre,ur.telefono AS remitente_telefono,ud.nombre AS destinatario_nombre,ud.telefono AS destinatario_telefono
       FROM envios e JOIN usuarios ur ON ur.id=e.remitente_id JOIN usuarios ud ON ud.id=e.destinatario_id
       LEFT JOIN conductores c ON c.id=e.conductor_id LEFT JOIN usuarios uc ON uc.id=c.usuario_id LEFT JOIN motos m ON m.conductor_id=c.id
      WHERE e.destinatario_id=? ORDER BY e.creado_en DESC LIMIT 50`, [req.usuario.id],
  );
  return ok(res, { envios: rows.map((e) => mostrarEnvio(e, req.usuario.id, true)) });
});

rutaEnvios.get('/conductor/ofertas', async (req,res) => {
  if (req.usuario.rol !== 'conductor') return error(res,403,'ROL_NO_ADMITIDO','Solo los conductores pueden consultar envíos disponibles.');
  const [drivers] = await db.execute(
    `SELECT c.id AS conductor_id,c.estado_aprobacion,c.estado_operativo,c.licencia_vence_en,m.id AS vehiculo_id,m.tipo_vehiculo,b.saldo_prepago,b.saldo_comision_reservado,b.estado AS billetera_estado,
            cu.latitud,cu.longitud,cu.es_mock,cu.actualizado_en,u.restringido_hasta,c.qr_pago_url,c.qr_pago_vence_en
       FROM conductores c JOIN usuarios u ON u.id=c.usuario_id JOIN motos m ON m.conductor_id=c.id JOIN billeteras b ON b.conductor_id=c.id
       LEFT JOIN conductor_ubicacion cu ON cu.conductor_id=c.id WHERE c.usuario_id=? LIMIT 1`,[req.usuario.id]);
  const d = drivers[0];
  if (!d || d.estado_aprobacion !== 'aprobado' || d.estado_operativo !== 'disponible' || d.billetera_estado !== 'activa' || d.tipo_vehiculo == null) return ok(res,{envios:[]});
  if (d.restringido_hasta && new Date(d.restringido_hasta).getTime() > Date.now()) return ok(res,{envios:[]});
  if (Number(d.es_mock) === 1 || !d.actualizado_en || new Date(d.actualizado_en).getTime() < Date.now()-120000) return ok(res,{envios:[]});
  const requeridos = d.tipo_vehiculo === 'auto'
    ? ['ci_frente','ci_reverso','selfie','licencia_frente','licencia_reverso','selfie_licencia','soat','tarjeta_propiedad','foto_placa','foto_auto_frente','foto_auto_atras','foto_auto_lateral','ruat']
    : ['ci_frente','ci_reverso','selfie','licencia_frente','licencia_reverso','selfie_licencia','soat','tarjeta_propiedad','foto_placa','foto_moto'];
  const [docs] = await db.execute(`SELECT DISTINCT tipo FROM documentos_conductor WHERE conductor_id=? AND estado='aprobado' AND (vence_en IS NULL OR vence_en >= DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR))`,[d.conductor_id]);
  if (requeridos.some(t => !docs.some(doc => doc.tipo === t))) return ok(res,{envios:[]});
  const [activos] = await db.execute("SELECT id FROM viajes WHERE conductor_id=? AND estado IN ('aceptado','conductor_llego','en_curso','requiere_revision') UNION ALL SELECT id FROM pedidos WHERE conductor_id=? AND estado IN ('asignado','recogido','en_camino','requiere_revision') UNION ALL SELECT id FROM envios WHERE conductor_id=? AND estado IN ('asignado','recogido','en_camino','en_punto_entrega','requiere_revision') LIMIT 1",[d.conductor_id,d.conductor_id,d.conductor_id]);
  if (activos.length) return ok(res,{envios:[]});
  const disponible = Math.max(0,Number(d.saldo_prepago)-Number(d.saldo_comision_reservado ?? 0));
  const radio = Math.max(1,Math.min(20,await ajusteNumero('radio_busqueda_delivery_km',5)));
  const [rows] = await db.execute(
    `SELECT e.id,e.tipo_vehiculo,e.descripcion_paquete,e.recogida_nombre,e.recogida_direccion,e.recogida_lat,e.recogida_lng,e.entrega_nombre,e.entrega_direccion,e.entrega_lat,e.entrega_lng,e.distancia_m,e.tarifa_estimada,e.comision_monto,e.metodo_pago,e.creado_en
       FROM envios e WHERE e.estado='solicitado' AND e.tipo_vehiculo=? AND (e.metodo_pago<>'qr' OR (? IS NOT NULL AND ? > UTC_TIMESTAMP()))
         AND ST_Distance_Sphere(POINT(?,?),POINT(e.recogida_lng,e.recogida_lat)) <= ?
       ORDER BY e.creado_en ASC LIMIT 30`,[d.tipo_vehiculo,d.qr_pago_url,d.qr_pago_vence_en,Number(d.longitud),Number(d.latitud),radio*1000]);
  // Sistema de puntos: solo se requiere cubrir los puntos del envío.
  return ok(res,{envios: rows.filter(e => disponible >= Number(e.comision_monto)).map(e=>({...e,id:Number(e.id),distancia_m:e.distancia_m==null?null:Number(e.distancia_m),tarifa_estimada:enteroBs(e.tarifa_estimada),comision_monto:enteroBs(e.comision_monto)}))});
});

rutaEnvios.get('/conductor/activos', async (req,res) => {
  if (req.usuario.rol !== 'conductor') return error(res,403,'ROL_NO_ADMITIDO','Solo los conductores pueden consultar sus envíos activos.');
  const [rows] = await db.execute(
    `SELECT e.*, c.usuario_id AS conductor_usuario_id, uc.nombre AS conductor_nombre, uc.apellido AS conductor_apellido,
            m.placa AS vehiculo_placa,m.marca AS vehiculo_marca,m.modelo AS vehiculo_modelo,m.color AS vehiculo_color,
            ur.nombre AS remitente_nombre,ur.telefono AS remitente_telefono,ud.nombre AS destinatario_nombre,ud.telefono AS destinatario_telefono
       FROM envios e JOIN usuarios ur ON ur.id=e.remitente_id JOIN usuarios ud ON ud.id=e.destinatario_id
       JOIN conductores c ON c.id=e.conductor_id LEFT JOIN usuarios uc ON uc.id=c.usuario_id LEFT JOIN motos m ON m.conductor_id=c.id
      WHERE c.usuario_id=? AND e.estado IN ('asignado','recogido','en_camino','en_punto_entrega') ORDER BY e.asignado_en ASC LIMIT 10`,[req.usuario.id]);
  return ok(res,{envios:rows.map(e=>mostrarEnvio(e,req.usuario.id))});
});

rutaEnvios.post('/:id/aceptar', async (req,res) => {
  if (req.usuario.rol !== 'conductor') return error(res,403,'ROL_NO_ADMITIDO','Solo un conductor puede aceptar el envío.');
  const id=ID(req.params.id); if(!id) return error(res,404,'ENVIO_NO_ENCONTRADO','No se encontró el envío.');
  const result = await tx(async (cx) => {
    const [es] = await cx.execute('SELECT * FROM envios WHERE id=? FOR UPDATE',[id]); const e=es[0];
    if(!e || e.estado!=='solicitado') return {e:[409,'ENVIO_NO_DISPONIBLE','Este envío ya no está disponible.']};
    const [cs] = await cx.execute(
      `SELECT c.id AS conductor_id,c.estado_aprobacion,c.estado_operativo,c.licencia_vence_en,c.qr_pago_url,c.qr_pago_vence_en,
              m.id AS vehiculo_id,m.tipo_vehiculo,b.id AS billetera_id,b.saldo_prepago,b.saldo_comision_reservado,b.estado AS billetera_estado,
              u.restringido_hasta,cu.latitud,cu.longitud,cu.es_mock,cu.actualizado_en
         FROM conductores c JOIN usuarios u ON u.id=c.usuario_id JOIN motos m ON m.conductor_id=c.id JOIN billeteras b ON b.conductor_id=c.id
         LEFT JOIN conductor_ubicacion cu ON cu.conductor_id=c.id WHERE c.usuario_id=? LIMIT 1 FOR UPDATE`,[req.usuario.id]);
    const c=cs[0];
    if(!c || c.estado_aprobacion!=='aprobado' || c.estado_operativo!=='disponible' || c.billetera_estado!=='activa' || c.tipo_vehiculo!==e.tipo_vehiculo) return {e:[409,'CONDUCTOR_NO_DISPONIBLE','Tu cuenta o vehículo no está habilitado para este envío.']};
    if(c.restringido_hasta && new Date(c.restringido_hasta).getTime()>Date.now()) return {e:[403,'CUENTA_RESTRINGIDA','Tu cuenta tiene una restricción temporal.']};
    if(c.es_mock===1 || !c.actualizado_en || new Date(c.actualizado_en).getTime()<Date.now()-120000) return {e:[409,'GPS_NO_RECIENTE','Actualiza tu ubicación GPS antes de aceptar.']};
    if(e.metodo_pago==='qr' && (!c.qr_pago_url || !c.qr_pago_vence_en || new Date(c.qr_pago_vence_en).getTime()<=Date.now())) return {e:[409,'QR_NO_VIGENTE','Configura un QR bancario vigente en tu perfil antes de aceptar este envío.']};
    const docsReq=c.tipo_vehiculo==='auto'?['ci_frente','ci_reverso','selfie','licencia_frente','licencia_reverso','selfie_licencia','soat','tarjeta_propiedad','foto_placa','foto_auto_frente','foto_auto_atras','foto_auto_lateral','ruat']:['ci_frente','ci_reverso','selfie','licencia_frente','licencia_reverso','selfie_licencia','soat','tarjeta_propiedad','foto_placa','foto_moto'];
    const [docs]=await cx.execute("SELECT DISTINCT tipo FROM documentos_conductor WHERE conductor_id=? AND estado='aprobado' AND (vence_en IS NULL OR vence_en >= DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR))",[c.conductor_id]);
    const set=new Set(docs.map(x=>x.tipo)); if(docsReq.some(t=>!set.has(t))) return {e:[403,'DOCUMENTOS_NO_VIGENTES','Faltan documentos de vehículo aprobados y vigentes.']};
    const [act] = await cx.execute("SELECT id FROM viajes WHERE conductor_id=? AND estado IN ('aceptado','conductor_llego','en_curso','requiere_revision') UNION ALL SELECT id FROM pedidos WHERE conductor_id=? AND estado IN ('asignado','recogido','en_camino','requiere_revision') UNION ALL SELECT id FROM envios WHERE conductor_id=? AND estado IN ('asignado','recogido','en_camino','en_punto_entrega','requiere_revision') LIMIT 1",[c.conductor_id,c.conductor_id,c.conductor_id]);
    if(act.length) return {e:[409,'SERVICIO_ACTIVO','Termina tu servicio activo antes de aceptar un envío.']};
    const libre=Math.max(0,Number(c.saldo_prepago)-Number(c.saldo_comision_reservado??0));
    // Sistema de puntos: se reservan exactamente los puntos fijados al crear el envío.
    const requerido=dinero(Number(e.comision_monto));
    if(libre<requerido) return {e:[409,'SALDO_INSUFICIENTE',`No tienes puntos suficientes para aceptar este envío. Necesitas ${requerido} puntos disponibles; recarga puntos para seguir recibiendo servicios.`,{disponible_bs:libre,requerido_bs:requerido,puntos_disponibles:libre,puntos_requeridos:requerido}]};
    await cx.execute('UPDATE billeteras SET saldo_comision_reservado=saldo_comision_reservado+? WHERE id=?',[Number(e.comision_monto),c.billetera_id]);
    await cx.execute("UPDATE envios SET estado='asignado',conductor_id=?,asignado_en=UTC_TIMESTAMP(),qr_conductor_snapshot=?,comision_reservada=1 WHERE id=? AND estado='solicitado'",[c.conductor_id,c.qr_pago_url,id]);
    await cx.execute("UPDATE conductores SET estado_operativo='en_viaje' WHERE id=?",[c.conductor_id]);
    return {id};
  });
  if(result.e) return error(res,...result.e);
  await emitirActualizacionEnvio(id);
  return ok(res,{id,estado:'asignado',mensaje:'Envío asignado. Dirígete al lugar de recogida y solicita el código al remitente.'});
});

rutaEnvios.post('/:id/recogido', async (req,res) => {
  if(req.usuario.rol!=='conductor') return error(res,403,'ROL_NO_ADMITIDO','Solo el conductor asignado puede recoger.');
  const id=ID(req.params.id); const pin=String(req.body?.codigo ?? '').trim();
  if(!id) return error(res,404,'ENVIO_NO_ENCONTRADO','No se encontró el envío.');
  if(!/^\d{6}$/.test(pin)) return error(res,422,'CODIGO_INVALIDO','Ingresa el código de recogida de seis dígitos que te entrega el remitente.');
  const result=await tx(async(cx)=>{
    const [rs]=await cx.execute('SELECT e.*,c.usuario_id AS conductor_usuario_id FROM envios e LEFT JOIN conductores c ON c.id=e.conductor_id WHERE e.id=? FOR UPDATE',[id]);const e=rs[0];
    if(!e || String(e.conductor_usuario_id)!==String(req.usuario.id)) return {e:[404,'ENVIO_NO_ENCONTRADO','No se encontró un envío asignado a tu cuenta.']};
    if(e.estado!=='asignado') return {e:[409,'ESTADO_INVALIDO','El envío no está esperando recogida.']};
    if(Number(e.intentos_codigo_recogida)>=5) return {e:[423,'CODIGO_RECOGIDA_BLOQUEADO','Se agotaron los intentos de recogida. El envío requiere revisión.']};
    const [cs]=await cx.execute('SELECT id FROM conductores WHERE usuario_id=? LIMIT 1',[req.usuario.id]);
    const gps=await gpsReciente(cx,cs[0]?.id); if(!gps) return {e:[409,'GPS_NO_VALIDO','No hay ubicación GPS reciente y auténtica del conductor.']};
    const distanciaRecogida=distanciaMetros(gps.lat,gps.lng,Number(e.recogida_lat),Number(e.recogida_lng));
    if(distanciaRecogida>200) return {e:[409,'LEJOS_DE_RECOGIDA','Debes estar a 200 metros o menos del punto de recogida para validar el código.',{distancia_m:Math.round(distanciaRecogida)}]};
    if(!compararPin(e.recogida_telefono,'envio-recogida',pin,e.codigo_recogida_hash)) {
      const n=Number(e.intentos_codigo_recogida)+1;
      await cx.execute("UPDATE envios SET intentos_codigo_recogida=?,estado=IF(? >= 5,'requiere_revision',estado),codigo_recogida_cifrado=IF(? >= 5,NULL,codigo_recogida_cifrado) WHERE id=?",[n,n,n,id]);
      return {incorrecto:[403,'CODIGO_RECOGIDA_INCORRECTO',n>=5?'Código incorrecto. Se agotaron los intentos y el envío requiere revisión.':`Código incorrecto. Quedan ${5-n} intentos.`],id,revision:n>=5};
    }
    await cx.execute("UPDATE envios SET estado='en_camino',recogido_en=UTC_TIMESTAMP(),codigo_recogida_hash=NULL,codigo_recogida_cifrado=NULL WHERE id=?",[id]);
    return {id};
  });
  if(result.e) return error(res,...result.e);
  if(result.incorrecto) { if(result.revision) await emitirActualizacionEnvio(id); return error(res,...result.incorrecto); }
  await emitirActualizacionEnvio(id);
  return ok(res,{id,estado:'en_camino',mensaje:'Recogida verificada. Ya puedes dirigirte al destinatario.'});
});

rutaEnvios.post('/:id/llegada', async (req,res) => {
  if(req.usuario.rol!=='conductor') return error(res,403,'ROL_NO_ADMITIDO','Solo el conductor asignado puede marcar llegada.');
  const id=ID(req.params.id); if(!id) return error(res,404,'ENVIO_NO_ENCONTRADO','No se encontró el envío.');
  const result=await tx(async(cx)=>{
    const [rs]=await cx.execute('SELECT e.*,c.usuario_id AS conductor_usuario_id FROM envios e LEFT JOIN conductores c ON c.id=e.conductor_id WHERE e.id=? FOR UPDATE',[id]);const e=rs[0];
    if(!e || String(e.conductor_usuario_id)!==String(req.usuario.id)) return {e:[404,'ENVIO_NO_ENCONTRADO','No se encontró un envío asignado a tu cuenta.']};
    if(e.estado!=='en_camino') return {e:[409,'ESTADO_INVALIDO','Primero confirma la recogida y sal hacia el destino.']};
    const [cs]=await cx.execute('SELECT id FROM conductores WHERE usuario_id=? LIMIT 1',[req.usuario.id]);
    const gps=await gpsReciente(cx,cs[0]?.id); if(!gps) return {e:[409,'GPS_NO_VALIDO','No hay ubicación GPS reciente y auténtica del conductor.']};
    const distancia=distanciaMetros(gps.lat,gps.lng,Number(e.entrega_lat),Number(e.entrega_lng));
    if(distancia>200) return {e:[409,'LEJOS_DEL_DESTINO','Debes estar a 200 metros o menos del punto de entrega.',{distancia_m:Math.round(distancia)}]};
    const code=generarCodigoOtp();
    await cx.execute("UPDATE envios SET estado='en_punto_entrega',llegada_en=UTC_TIMESTAMP(),codigo_entrega_hash=?,codigo_entrega_cifrado=?,codigo_entrega_expira_en=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 15 MINUTE),intentos_codigo_entrega=0 WHERE id=?",
      [hashPin(e.entrega_telefono,`envio-entrega:${id}`,code),cifrarPin(code),id]);
    return {id};
  });
  if(result.e) return error(res,...result.e);
  await emitirActualizacionEnvio(id,{notificacion:'El repartidor llegó. Abre De Volada para ver tu código de entrega.'});
  return ok(res,{id,estado:'en_punto_entrega',mensaje:'Llegada validada. El código de entrega ya está disponible únicamente en la cuenta De Volada del destinatario.'});
});

rutaEnvios.post('/:id/entregar', async (req,res) => {
  if(req.usuario.rol!=='conductor') return error(res,403,'ROL_NO_ADMITIDO','Solo el conductor asignado puede confirmar la entrega.');
  const id=ID(req.params.id); const pin=String(req.body?.codigo ?? '').trim();
  if(!id) return error(res,404,'ENVIO_NO_ENCONTRADO','No se encontró el envío.');
  if(!/^\d{6}$/.test(pin)) return error(res,422,'CODIGO_INVALIDO','Ingresa el código de entrega de seis dígitos que muestra la app del destinatario.');
  const result=await tx(async(cx)=>{
    const [rs]=await cx.execute('SELECT e.*,c.usuario_id AS conductor_usuario_id FROM envios e LEFT JOIN conductores c ON c.id=e.conductor_id WHERE e.id=? FOR UPDATE',[id]);const e=rs[0];
    if(!e || String(e.conductor_usuario_id)!==String(req.usuario.id)) return {e:[404,'ENVIO_NO_ENCONTRADO','No se encontró un envío asignado a tu cuenta.']};
    if(e.estado!=='en_punto_entrega') return {e:[409,'ESTADO_INVALIDO','El destinatario debe estar presente y el conductor debe marcar llegada.']};
    if(!e.codigo_entrega_expira_en || new Date(e.codigo_entrega_expira_en).getTime()<=Date.now()) return {e:[410,'CODIGO_VENCIDO','El código de entrega venció. Usa soporte para verificar la entrega de forma segura.']};
    if(Number(e.intentos_codigo_entrega)>=5) return {e:[423,'CODIGO_BLOQUEADO','Se agotaron los intentos. El envío quedó bloqueado para revisión.']};
    if(!compararPin(e.entrega_telefono,`envio-entrega:${id}`,pin,e.codigo_entrega_hash)) {
      const n=Number(e.intentos_codigo_entrega)+1;
      await cx.execute("UPDATE envios SET intentos_codigo_entrega=?,estado=IF(? >= 5,'requiere_revision',estado),codigo_entrega_cifrado=IF(? >= 5,NULL,codigo_entrega_cifrado) WHERE id=?",[n,n,n,id]);
      return {incorrecto:[403,'CODIGO_ENTREGA_INCORRECTO',n>=5?'Código incorrecto. Se agotaron los intentos y el envío requiere revisión.':`Código incorrecto. Quedan ${5-n} intentos.`],id,revision:n>=5};
    }
    const [cs]=await cx.execute('SELECT id FROM conductores WHERE usuario_id=? LIMIT 1 FOR UPDATE',[req.usuario.id]);
    const [bs]=await cx.execute('SELECT id,saldo_prepago,saldo_comision_reservado FROM billeteras WHERE conductor_id=? LIMIT 1 FOR UPDATE',[cs[0]?.id]);
    const wallet=bs[0]; if(!wallet) return {e:[409,'BILLETERA_NO_CREADA','No encontramos tu billetera de comisiones.']};
    const saldo=Number(wallet.saldo_prepago), reserva=Number(wallet.saldo_comision_reservado??0), comision=Number(e.comision_monto);
    if(Number(e.comision_reservada)!==1 || reserva < comision || saldo < comision) {
      await cx.execute("UPDATE envios SET estado='requiere_revision' WHERE id=?",[id]);
      await cx.execute("UPDATE conductores SET estado_operativo='bloqueado_saldo' WHERE id=?",[cs[0].id]);
      return {revision:true,id,mensaje:'Entrega recibida; el movimiento de comisión necesita conciliación administrativa.'};
    }
    const despues=dinero(saldo-comision);
    await cx.execute('UPDATE billeteras SET saldo_prepago=?,saldo_comision_reservado=GREATEST(0,saldo_comision_reservado-?) WHERE id=?',[despues,comision,wallet.id]);
    if(comision>0) await cx.execute("INSERT INTO movimientos_billetera (billetera_id,cuenta,tipo,monto,saldo_antes,saldo_despues,pedido_id,descripcion,idempotency_key) VALUES (?,'prepago','comision',?,?,?,?,?,?)",
      [wallet.id,-comision,saldo,despues,null,`Comisión envío #${id}: -${comision} pts`,`comision:envio:${id}`]);
    await cx.execute("UPDATE envios SET estado='entregado',entregado_en=UTC_TIMESTAMP(),comision_reservada=0,codigo_entrega_hash=NULL,codigo_entrega_cifrado=NULL WHERE id=?",[id]);
    await cx.execute("UPDATE conductores SET estado_operativo=IF(? >= ?, 'disponible','bloqueado_saldo') WHERE id=? AND estado_operativo='en_viaje'",[dinero(saldo-comision),config.puntosPorViaje,cs[0].id]);
    return {id,estado:'entregado'};
  });
  if(result.e) return error(res,...result.e);
  if(result.incorrecto) { if(result.revision) await emitirActualizacionEnvio(id); return error(res,...result.incorrecto); }
  await emitirActualizacionEnvio(id);
  return ok(res,result.revision ? result : {id,estado:'entregado',mensaje:'Entrega verificada. El código solo pudo usarse una vez y la comisión quedó registrada.'});
});

rutaEnvios.post('/:id/cancelar', async (req,res) => {
  if(req.usuario.rol!=='pasajero') return error(res,403,'ROL_NO_ADMITIDO','Solo el remitente puede cancelar la solicitud sin conductor.');
  const id=ID(req.params.id);if(!id)return error(res,404,'ENVIO_NO_ENCONTRADO','No se encontró el envío.');
  const result=await tx(async(cx)=>{
    const [rs]=await cx.execute('SELECT id,estado,remitente_id FROM envios WHERE id=? FOR UPDATE',[id]);const e=rs[0];
    if(!e || String(e.remitente_id)!==String(req.usuario.id)) return {e:[404,'ENVIO_NO_ENCONTRADO','No se encontró tu envío.']};
    if(e.estado!=='solicitado') return {e:[409,'ENVIO_NO_CANCELABLE','Solo puedes cancelar antes de que un conductor lo acepte. Contacta a soporte si ya fue asignado.']};
    await cx.execute("UPDATE envios SET estado='cancelado',codigo_recogida_hash=NULL,codigo_recogida_cifrado=NULL WHERE id=?",[id]);
    return {id};
  });
  if(result.e)return error(res,...result.e);
  await emitirActualizacionEnvio(id);return ok(res,{id,estado:'cancelado',mensaje:'Solicitud cancelada.'});
});
