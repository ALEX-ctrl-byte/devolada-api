import { Router } from 'express';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';
import { urlPublicaQrRecarga } from '../servicios/qrRecarga.js';

// El archivo conserva su nombre histórico interno; el contrato público vigente es /operaciones.
export const rutaOperaciones = Router();
export const rutaBilletera = rutaOperaciones;

const esMonto = (v) => v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v));
const dinero = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const esIdempotencia = (v) => /^[A-Za-z0-9._:-]{8,64}$/.test(String(v ?? '').trim());
const ROLES_OPERACIONES = new Set(['conductor', 'comercio']);
const OPERACIONES_POR_BS = 0.5; // Bs 2 = 1 operación.

async function enTransaccion(fn) {
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

function validarRol(rol) { return ROLES_OPERACIONES.has(rol); }
function operacionesPorMonto(montoBs) { return Math.floor((Number(montoBs) + Number.EPSILON) * OPERACIONES_POR_BS); }
function esRecargaValida(montoBs) {
  const monto = dinero(montoBs);
  return monto >= 2 && monto <= 5000 && Math.abs(monto / 2 - Math.round(monto / 2)) < 0.000001;
}

async function datosOperacionesConductor(cx, usuarioId, bloquear = false) {
  const [filas] = await cx.execute(
    `SELECT c.id AS conductor_id, c.qr_pago_url, c.qr_pago_subido_en, c.qr_pago_vence_en,
            IF(c.qr_pago_url IS NOT NULL AND c.qr_pago_vence_en > UTC_TIMESTAMP(),1,0) AS qr_vigente,
            b.id AS cuenta_id, b.saldo_prepago AS operaciones_total,
            b.saldo_comision_reservado AS operaciones_reservadas, b.estado
       FROM conductores c JOIN billeteras b ON b.conductor_id = c.id
      WHERE c.usuario_id = ? LIMIT 1${bloquear ? ' FOR UPDATE' : ''}`,
    [usuarioId],
  );
  return filas[0] ?? null;
}

async function datosOperacionesComercio(cx, usuarioId, bloquear = false) {
  const [filas] = await cx.execute(
    `SELECT e.id AS empresa_id, e.saldo_comision AS operaciones_total,
            e.saldo_comision_reservado AS operaciones_reservadas, e.qr_pago_url,
            e.qr_pago_subido_en, e.qr_pago_vence_en,
            IF(e.qr_pago_url IS NOT NULL AND e.qr_pago_vence_en > UTC_TIMESTAMP(),1,0) AS qr_vigente,
            e.estado_aprobacion AS estado, e.nombre_comercial
       FROM empresas e WHERE e.usuario_id = ? LIMIT 1${bloquear ? ' FOR UPDATE' : ''}`,
    [usuarioId],
  );
  return filas[0] ?? null;
}

function respuestaCuenta(datos, tipo, req) {
  const total = Math.max(0, Math.floor(Number(datos.operaciones_total ?? 0)));
  const reservadas = Math.max(0, Math.floor(Number(datos.operaciones_reservadas ?? 0)));
  return {
    tipo,
    estado: datos.estado,
    ...(tipo === 'comercio' ? { empresa_id: Number(datos.empresa_id), nombre_comercial: datos.nombre_comercial } : {}),
    operaciones_total: total,
    operaciones_reservadas: reservadas,
    operaciones_disponibles: Math.max(0, total - reservadas),
    qr_pago_url: datos.qr_pago_url ?? null,
    qr_pago_subido_en: datos.qr_pago_subido_en ?? null,
    qr_pago_vence_en: datos.qr_pago_vence_en ?? null,
    qr_vigente: Number(datos.qr_vigente) === 1,
    qr_recarga_deuna_url: urlPublicaQrRecarga(req),
    politica: 'Una operación se consume por cada viaje, envío/delivery o venta completada. Las operaciones no son dinero y no se pueden retirar ni transferir.',
  };
}

// GET /operaciones — cuenta operativa exclusiva para conductores y comercios.
rutaOperaciones.get('/', autenticar, async (req, res) => {
  if (!validarRol(req.usuario.rol)) {
    return error(res, 403, 'OPERACIONES_NO_DISPONIBLES', 'Las operaciones están disponibles únicamente para conductores y comercios.');
  }
  if (req.usuario.rol === 'conductor') {
    const datos = await datosOperacionesConductor(db, req.usuario.id);
    if (!datos) return error(res, 409, 'OPERACIONES_NO_ACTIVADAS', 'Completa la postulación para activar tus operaciones.');
    return ok(res, respuestaCuenta(datos, 'conductor', req));
  }
  const datos = await datosOperacionesComercio(db, req.usuario.id);
  if (!datos) return error(res, 409, 'COMERCIO_INCOMPLETO', 'Completa el perfil de tu comercio para activar sus operaciones.');
  return ok(res, respuestaCuenta(datos, 'comercio', req));
});

// GET /operaciones/movimientos — historial de acreditaciones y consumos operativos.
rutaOperaciones.get('/movimientos', autenticar, async (req, res) => {
  if (!validarRol(req.usuario.rol)) return error(res, 403, 'OPERACIONES_NO_DISPONIBLES', 'Disponible únicamente para conductores y comercios.');
  if (req.usuario.rol === 'conductor') {
    const datos = await datosOperacionesConductor(db, req.usuario.id);
    if (!datos) return error(res, 409, 'OPERACIONES_NO_ACTIVADAS', 'Completa la postulación para activar tus operaciones.');
    const [movimientos] = await db.execute(
      `SELECT id, tipo, monto AS operaciones, saldo_antes AS operaciones_antes,
              saldo_despues AS operaciones_despues, viaje_id, pedido_id, descripcion, creado_en
         FROM movimientos_billetera WHERE billetera_id = ? AND cuenta='prepago'
          AND creado_en >= (SELECT actualizado_en FROM configuracion WHERE clave='modelo_operaciones_v1' AND valor='aplicado')
        ORDER BY id DESC LIMIT 60`,
      [datos.cuenta_id],
    );
    return ok(res, { movimientos });
  }
  const datos = await datosOperacionesComercio(db, req.usuario.id);
  if (!datos) return error(res, 409, 'COMERCIO_INCOMPLETO', 'Completa el perfil del comercio.');
  const [movimientos] = await db.execute(
    `SELECT id, tipo, monto AS operaciones, saldo_antes AS operaciones_antes,
            saldo_despues AS operaciones_despues, pedido_id, recarga_id, descripcion, creado_en
       FROM movimientos_comision_comercio WHERE empresa_id = ?
      AND creado_en >= (SELECT actualizado_en FROM configuracion WHERE clave='modelo_operaciones_v1' AND valor='aplicado')
      ORDER BY id DESC LIMIT 60`,
    [datos.empresa_id],
  );
  return ok(res, { movimientos });
});

// GET /operaciones/recargas — importes depositados en Bs y su equivalencia de operaciones.
rutaOperaciones.get('/recargas', autenticar, async (req, res) => {
  if (!validarRol(req.usuario.rol)) return error(res, 403, 'OPERACIONES_NO_DISPONIBLES', 'Disponible únicamente para conductores y comercios.');
  const [recargas] = await db.execute(
    `SELECT id, monto AS monto_bs, FLOOR(monto / 2) AS operaciones_a_acreditar,
            metodo, referencia_cliente, referencia_pago, estado, motivo_revision,
            solicitado_en, revisado_en
       FROM recargas_billetera WHERE usuario_id = ? ORDER BY id DESC LIMIT 30`,
    [req.usuario.id],
  );
  return ok(res, { recargas });
});

// POST /operaciones/recargas — la solicitud nunca acredita operaciones desde el móvil.
rutaOperaciones.post('/recargas', autenticar, async (req, res) => {
  if (!validarRol(req.usuario.rol)) return error(res, 403, 'OPERACIONES_NO_DISPONIBLES', 'Solo conductores y comercios pueden solicitar recargas.');
  const montoEntrada = req.body?.monto_bs ?? req.body?.monto;
  if (!esMonto(montoEntrada)) return error(res, 422, 'DATOS_INVALIDOS', 'Ingresa un monto válido en bolivianos.');
  const monto = dinero(montoEntrada);
  if (!esRecargaValida(monto)) {
    return error(res, 422, 'MONTO_INVALIDO', 'La recarga debe ser de Bs 2 a Bs 5.000 y en múltiplos de Bs 2.');
  }
  const metodo = String(req.body?.metodo ?? 'transferencia');
  if (!['qr', 'transferencia'].includes(metodo)) return error(res, 422, 'METODO_INVALIDO', 'Elige QR o transferencia bancaria a la cuenta oficial.');
  const clave = String(req.body?.idempotency_key ?? '').trim();
  if (!esIdempotencia(clave)) return error(res, 422, 'IDEMPOTENCY_KEY_INVALIDA', 'La clave de solicitud no es válida.');
  const referencia = req.body?.referencia_cliente == null ? null : String(req.body.referencia_cliente).trim().slice(0, 100) || null;
  const operaciones = operacionesPorMonto(monto);

  const resultado = await enTransaccion(async (cx) => {
    const [ex] = await cx.execute('SELECT * FROM recargas_billetera WHERE usuario_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE', [req.usuario.id, clave]);
    if (ex[0]) {
      if (Number(ex[0].monto) !== monto || ex[0].metodo !== metodo) return { e: [409, 'IDEMPOTENCY_KEY_REUTILIZADA', 'La clave ya se usó para una solicitud diferente.'] };
      return { recarga: ex[0], repetida: true };
    }
    if (req.usuario.rol === 'conductor') {
      const datos = await datosOperacionesConductor(cx, req.usuario.id, true);
      if (!datos) return { e: [409, 'OPERACIONES_NO_ACTIVADAS', 'Completa la postulación antes de recargar.'] };
    } else {
      const datos = await datosOperacionesComercio(cx, req.usuario.id, true);
      if (!datos) return { e: [409, 'COMERCIO_INCOMPLETO', 'Completa el perfil del comercio antes de recargar.'] };
    }
    const [ins] = await cx.execute(
      `INSERT INTO recargas_billetera (usuario_id, monto, metodo, referencia_cliente, estado, idempotency_key)
       VALUES (?, ?, ?, ?, 'pendiente', ?)`,
      [req.usuario.id, monto, metodo, referencia, clave],
    );
    const [nueva] = await cx.execute(
      `SELECT id, monto AS monto_bs, FLOOR(monto / 2) AS operaciones_a_acreditar,
              metodo, referencia_cliente, estado, solicitado_en
         FROM recargas_billetera WHERE id=?`, [ins.insertId],
    );
    return { recarga: nueva[0], repetida: false };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  return ok(res, {
    recarga: resultado.recarga,
    repetida: resultado.repetida,
    operaciones_a_acreditar: operaciones,
    mensaje: `Solicitud recibida. Tras verificar el depósito real de Bs ${monto.toFixed(2)}, se acreditarán ${operaciones} operaciones.`,
  }, resultado.repetida ? 200 : 201);
});

// Política explícita: no existe retiro, envío de dinero ni transferencia de operaciones entre usuarios.
const noDisponible = (_req, res) => error(res, 410, 'OPERACION_FINANCIERA_NO_DISPONIBLE', 'De Volada no permite retirar, enviar dinero ni transferir operaciones entre usuarios. Los pagos de viajes y ventas se realizan directamente al conductor o comercio.');
rutaOperaciones.all('/retiros', autenticar, noDisponible);
rutaOperaciones.all('/transferencias', autenticar, noDisponible);
rutaOperaciones.all('/transferir', autenticar, noDisponible);
rutaOperaciones.all('/enviar-dinero', autenticar, noDisponible);
