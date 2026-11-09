import { Router } from 'express';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';
import { config } from '../config.js';
import { urlPublicaQrRecarga } from '../servicios/qrRecarga.js';

export const rutaBilletera = Router();

const esMonto = (v) => v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v));
const dinero = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const esIdempotencia = (v) => /^[A-Za-z0-9._:-]{8,64}$/.test(String(v ?? '').trim());
const ROLES_COMISION = new Set(['conductor', 'comercio']);

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

function validarRolComision(rol) { return ROLES_COMISION.has(rol); }

async function billeteraConductor(cx, usuarioId, bloquear = false) {
  const [filas] = await cx.execute(
    `SELECT c.id AS conductor_id, c.qr_pago_url, c.qr_pago_subido_en, c.qr_pago_vence_en,
            IF(c.qr_pago_url IS NOT NULL AND c.qr_pago_vence_en > UTC_TIMESTAMP(),1,0) AS qr_vigente,
            b.id AS billetera_id, b.saldo_prepago AS saldo_comision, b.saldo_comision_reservado, b.estado
       FROM conductores c JOIN billeteras b ON b.conductor_id = c.id
      WHERE c.usuario_id = ? LIMIT 1${bloquear ? ' FOR UPDATE' : ''}`,
    [usuarioId],
  );
  return filas[0] ?? null;
}

async function billeteraComercio(cx, usuarioId, bloquear = false) {
  const [filas] = await cx.execute(
    `SELECT e.id AS empresa_id, e.saldo_comision, e.saldo_comision_reservado, e.qr_pago_url,
            e.qr_pago_subido_en, e.qr_pago_vence_en,
            IF(e.qr_pago_url IS NOT NULL AND e.qr_pago_vence_en > UTC_TIMESTAMP(),1,0) AS qr_vigente,
            e.estado_aprobacion AS estado, e.nombre_comercial
       FROM empresas e WHERE e.usuario_id = ? LIMIT 1${bloquear ? ' FOR UPDATE' : ''}`,
    [usuarioId],
  );
  return filas[0] ?? null;
}

// GET /billetera — solo conductor/comercio. Este saldo paga COMISIONES, no es una cuenta bancaria.
rutaBilletera.get('/', autenticar, async (req, res) => {
  if (!validarRolComision(req.usuario.rol)) {
    return error(res, 403, 'BILLETERA_COMISION_NO_DISPONIBLE', 'El saldo de comisiones está disponible para conductores y comercios.');
  }
  if (req.usuario.rol === 'conductor') {
    const b = await billeteraConductor(db, req.usuario.id);
    if (!b) return error(res, 409, 'BILLETERA_NO_CREADA', 'Completa la postulación para activar el saldo de comisiones.');
    return ok(res, {
      tipo: 'conductor', estado: b.estado,
      saldo_comision_bs: Number(b.saldo_comision),
      // Alias para clientes anteriores de la app; ambos campos representan SOLO saldo de comisión.
      saldo_prepago_bs: Number(b.saldo_comision),
      saldo_comision_reservado_bs: Number(b.saldo_comision_reservado ?? 0),
      saldo_comision_disponible_bs: Math.max(0, Math.round((Number(b.saldo_comision) - Number(b.saldo_comision_reservado ?? 0) + Number.EPSILON) * 100) / 100),
      qr_pago_url: b.qr_pago_url ?? null,
      qr_pago_subido_en: b.qr_pago_subido_en ?? null, qr_pago_vence_en: b.qr_pago_vence_en ?? null, qr_vigente: Number(b.qr_vigente) === 1,
      moneda: 'BOB', qr_recarga_deuna_url: urlPublicaQrRecarga(req),
      proposito: 'Saldo prepago usado únicamente para pagar comisiones De Volada. El cobro del viaje va directamente al conductor.',
    });
  }
  const b = await billeteraComercio(db, req.usuario.id);
  if (!b) return error(res, 409, 'COMERCIO_INCOMPLETO', 'Completa el perfil de tu comercio para activar el saldo de comisiones.');
  return ok(res, {
    tipo: 'comercio', estado: b.estado,
    empresa_id: Number(b.empresa_id), nombre_comercial: b.nombre_comercial,
    saldo_comision_bs: Number(b.saldo_comision), saldo_comision_reservado_bs: Number(b.saldo_comision_reservado ?? 0),
    saldo_comision_disponible_bs: Math.max(0, Math.round((Number(b.saldo_comision) - Number(b.saldo_comision_reservado ?? 0) + Number.EPSILON) * 100) / 100), qr_pago_url: b.qr_pago_url ?? null,
    qr_pago_subido_en: b.qr_pago_subido_en ?? null, qr_pago_vence_en: b.qr_pago_vence_en ?? null, qr_vigente: Number(b.qr_vigente) === 1,
    moneda: 'BOB', qr_recarga_deuna_url: urlPublicaQrRecarga(req),
    proposito: 'Saldo prepago usado únicamente para pagar comisiones De Volada. Las ventas van directamente a la cuenta del comercio.',
  });
});

// GET /billetera/movimientos — libro de movimientos del saldo de comisión.
rutaBilletera.get('/movimientos', autenticar, async (req, res) => {
  if (!validarRolComision(req.usuario.rol)) return error(res, 403, 'BILLETERA_COMISION_NO_DISPONIBLE', 'Disponible para conductores y comercios.');
  if (req.usuario.rol === 'conductor') {
    const b = await billeteraConductor(db, req.usuario.id);
    if (!b) return error(res, 409, 'BILLETERA_NO_CREADA', 'Completa la postulación para activar tu saldo de comisiones.');
    const [movimientos] = await db.execute(
      `SELECT id, cuenta, tipo, monto, saldo_antes, saldo_despues, viaje_id, pedido_id, descripcion, creado_en
         FROM movimientos_billetera WHERE billetera_id = ? AND cuenta='prepago' ORDER BY id DESC LIMIT 60`,
      [b.billetera_id],
    );
    return ok(res, { movimientos });
  }
  const b = await billeteraComercio(db, req.usuario.id);
  if (!b) return error(res, 409, 'COMERCIO_INCOMPLETO', 'Completa el perfil de tu comercio.');
  const [movimientos] = await db.execute(
    `SELECT id, tipo, monto, saldo_antes, saldo_despues, pedido_id, recarga_id, descripcion, creado_en
       FROM movimientos_comision_comercio WHERE empresa_id = ? ORDER BY id DESC LIMIT 60`,
    [b.empresa_id],
  );
  return ok(res, { movimientos });
});

// GET /billetera/recargas — recargas propias para conductor o comercio.
rutaBilletera.get('/recargas', autenticar, async (req, res) => {
  if (!validarRolComision(req.usuario.rol)) return error(res, 403, 'BILLETERA_COMISION_NO_DISPONIBLE', 'Disponible para conductores y comercios.');
  const [recargas] = await db.execute(
    `SELECT id, monto, metodo, referencia_cliente, referencia_pago, estado, motivo_revision, solicitado_en, revisado_en
       FROM recargas_billetera WHERE usuario_id = ? ORDER BY id DESC LIMIT 30`,
    [req.usuario.id],
  );
  return ok(res, { recargas });
});

// POST /billetera/recargas — solicitud pendiente; nunca acredita fondos desde el móvil.
rutaBilletera.post('/recargas', autenticar, async (req, res) => {
  if (!validarRolComision(req.usuario.rol)) return error(res, 403, 'BILLETERA_COMISION_NO_DISPONIBLE', 'Solo conductores y comercios pueden recargar saldo de comisiones.');
  if (!esMonto(req.body?.monto)) return error(res, 422, 'DATOS_INVALIDOS', 'Ingresa un monto válido.');
  const monto = dinero(req.body.monto);
  if (monto < 10 || monto > 5000) return error(res, 422, 'MONTO_INVALIDO', 'La recarga debe ser de Bs 10 a Bs 5.000.');
  const metodo = String(req.body?.metodo ?? 'transferencia');
  if (!['qr', 'transferencia'].includes(metodo)) return error(res, 422, 'METODO_INVALIDO', 'Elige QR o transferencia.');
  const clave = String(req.body?.idempotency_key ?? '').trim();
  if (!esIdempotencia(clave)) return error(res, 422, 'IDEMPOTENCY_KEY_INVALIDA', 'La clave de solicitud no es válida.');
  const referencia = req.body?.referencia_cliente == null ? null : String(req.body.referencia_cliente).trim().slice(0, 100) || null;

  const resultado = await enTransaccion(async (cx) => {
    const [ex] = await cx.execute('SELECT * FROM recargas_billetera WHERE usuario_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE', [req.usuario.id, clave]);
    if (ex[0]) {
      if (Number(ex[0].monto) !== monto || ex[0].metodo !== metodo) return { e: [409, 'IDEMPOTENCY_KEY_REUTILIZADA', 'La clave ya se usó para una solicitud diferente.'] };
      return { recarga: ex[0], repetida: true };
    }
    if (req.usuario.rol === 'conductor') {
      const b = await billeteraConductor(cx, req.usuario.id, true);
      if (!b) return { e: [409, 'BILLETERA_NO_CREADA', 'Completa la postulación antes de recargar.'] };
    } else {
      const b = await billeteraComercio(cx, req.usuario.id, true);
      if (!b) return { e: [409, 'COMERCIO_INCOMPLETO', 'Completa el perfil del comercio antes de recargar.'] };
    }
    const [ins] = await cx.execute(
      `INSERT INTO recargas_billetera (usuario_id, monto, metodo, referencia_cliente, estado, idempotency_key)
       VALUES (?, ?, ?, ?, 'pendiente', ?)`,
      [req.usuario.id, monto, metodo, referencia, clave],
    );
    const [nueva] = await cx.execute('SELECT id, monto, metodo, referencia_cliente, estado, solicitado_en FROM recargas_billetera WHERE id=?', [ins.insertId]);
    return { recarga: nueva[0], repetida: false };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  return ok(res, {
    recarga: resultado.recarga,
    repetida: resultado.repetida,
    mensaje: 'Solicitud recibida. Transfiere el importe al QR/cuenta oficial de De Volada y el equipo acreditará el saldo tras verificar el ingreso real.',
  }, resultado.repetida ? 200 : 201);
});

// Los fondos del pasajero nunca se guardan en una billetera De Volada en este modelo.
rutaBilletera.get('/retiros', autenticar, async (req, res) => {
  return error(res, 410, 'RETIROS_NO_APLICAN', 'Los cobros de viajes y delivery van directamente al QR o efectivo del conductor; no hay ganancias depositadas en esta billetera.');
});
rutaBilletera.post('/retiros', autenticar, async (req, res) => {
  return error(res, 410, 'RETIROS_NO_APLICAN', 'El saldo De Volada es prepago para comisiones, no dinero retirable.');
});
