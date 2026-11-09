import { Router } from 'express';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { normalizarTelefono } from '../validador.js';
import { ajusteNumero } from '../servicios/ajustes.js';
import { obtenerUsuario } from '../servicios/usuarios.js';
import { hashToken, nuevoToken, fechaUtcSql } from '../seguridad.js';
import { urlActivacionWhatsapp } from '../servicios/activacionWhatsapp.js';
import { pinCorrecto } from '../servicios/pin.js';

export const rutaEntrar = Router();

// Límites de intentos fallidos en la última hora (tabla intentos_pin).
// Por IP el límite es más alto porque en redes móviles muchos usuarios comparten la misma IP.
const MAX_FALLOS_TELEFONO = 5;
const MAX_FALLOS_IP = 20;
const MSG_INCORRECTO = 'Teléfono o PIN incorrecto.';

/** Registro de auditoría "si existe": un fallo aquí nunca debe impedir el inicio de sesión. */
async function auditarAcceso(usuarioId, accion, ip, datos) {
  try {
    await db.execute(
      `INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, datos_antes, datos_despues, ip_origen)
       VALUES (?, ?, 'usuarios', ?, NULL, ?, ?)`,
      [usuarioId, accion, usuarioId, datos ? JSON.stringify(datos) : null, ip],
    );
  } catch (e) {
    console.warn('[De Volada] No se pudo registrar auditoría de acceso:', e.code ?? e.message);
  }
}

async function registrarFallo(telefono, ip) {
  await db.execute(
    'INSERT INTO intentos_pin (telefono, ip_origen, creado_en) VALUES (?, ?, UTC_TIMESTAMP())',
    [telefono, ip],
  );
}

// POST /entrar { telefono, pin } → { token, expira_en, usuario } (mismo formato que /otp/verificar)
rutaEntrar.post('/', async (req, res) => {
  const telefono = normalizarTelefono(req.body?.telefono);
  const pin = String(req.body?.pin ?? '');
  const ip = req.ip ?? null;

  const errores = {};
  if (telefono === null) errores.telefono = 'Ingresa un celular boliviano válido (8 dígitos, empieza con 6 o 7).';
  if (!/^\d{4}$/.test(pin)) errores.pin = 'El PIN tiene 4 números.';
  if (Object.keys(errores).length > 0) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', errores);

  // 1) Límite de intentos fallidos antes de tocar el PIN.
  const [[fallos]] = await db.execute(
    `SELECT SUM(telefono = ?) AS por_telefono, SUM(ip_origen <=> ?) AS por_ip
       FROM intentos_pin
      WHERE creado_en > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)
        AND (telefono = ? OR ip_origen <=> ?)`,
    [telefono, ip, telefono, ip],
  );
  if (Number(fallos.por_telefono ?? 0) >= MAX_FALLOS_TELEFONO || (ip && Number(fallos.por_ip ?? 0) >= MAX_FALLOS_IP)) {
    return error(res, 429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos fallidos. Espera una hora e intenta de nuevo.');
  }

  // 2) Verificación del PIN (también se ejecuta si el teléfono no existe, para no revelar cuentas).
  const [us] = await db.execute(
    'SELECT id, telefono, nombre, apellido, rol, estado, pin_hash FROM usuarios WHERE telefono = ? LIMIT 1',
    [telefono],
  );
  const usuario = us[0];
  const correcto = await pinCorrecto(pin, usuario?.pin_hash);

  if (usuario && !usuario.pin_hash) {
    // Cuenta antigua creada con OTP: el administrador debe asignarle un PIN desde el panel.
    return error(res, 403, 'PIN_NO_CONFIGURADO', 'Tu cuenta aún no tiene PIN. Escríbenos por WhatsApp para que te asignemos uno.');
  }
  if (!correcto) {
    await registrarFallo(telefono, ip);
    if (usuario) await auditarAcceso(usuario.id, 'login_pin_fallido', ip, null);
    const restantes = MAX_FALLOS_TELEFONO - (Number(fallos.por_telefono ?? 0) + 1);
    const msg = restantes > 0
      ? `${MSG_INCORRECTO} Te ${restantes === 1 ? 'queda 1 intento' : `quedan ${restantes} intentos`}.`
      : `${MSG_INCORRECTO} Espera una hora para volver a intentar.`;
    return error(res, 401, 'PIN_INCORRECTO', msg, { intentos_restantes: Math.max(restantes, 0) });
  }

  // 3) Estado de la cuenta (solo se revela a quien conoce el PIN).
  if (usuario.estado === 'pendiente') {
    const url = urlActivacionWhatsapp(usuario);
    return error(res, 403, 'CUENTA_PENDIENTE_APROBACION',
      'Tu cuenta está en revisión. Recibirás acceso cuando el administrador la apruebe.',
      url ? { whatsapp_activacion_url: url } : undefined);
  }
  if (usuario.estado !== 'activo') {
    return error(res, 403, 'CUENTA_NO_DISPONIBLE', 'Esta cuenta no está disponible.');
  }

  // 4) Sesión: igual que /otp/verificar.
  const diasSesion = await ajusteNumero('sesion_dias', 30);
  const token = nuevoToken();
  const expira = Date.now() + diasSesion * 86_400_000;
  const conexion = await db.getConnection();
  try {
    await conexion.beginTransaction();
    await conexion.execute('UPDATE usuarios SET ultimo_acceso_en = UTC_TIMESTAMP() WHERE id = ?', [usuario.id]);
    await conexion.execute(
      `INSERT INTO sesiones (usuario_id, token_hash, dispositivo, ip_origen, expira_en)
       VALUES (?, ?, ?, ?, ?)`,
      [usuario.id, hashToken(token), (req.get('user-agent') ?? '').slice(0, 150) || null, ip, fechaUtcSql(expira)],
    );
    await conexion.execute('DELETE FROM intentos_pin WHERE telefono = ?', [telefono]);
    await conexion.commit();
    const datosUsuario = await obtenerUsuario(conexion, usuario.id);
    await auditarAcceso(usuario.id, 'login_pin', ip, null);
    return ok(res, { token, expira_en: new Date(expira).toISOString(), usuario: datosUsuario });
  } catch (e) {
    await conexion.rollback().catch(() => {});
    throw e;
  } finally {
    conexion.release();
  }
});
