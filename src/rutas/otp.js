import { Router } from 'express';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { normalizarTelefono } from '../validador.js';
import { ajusteNumero } from '../servicios/ajustes.js';
import { enviarOtp } from '../servicios/enviarOtp.js';
import { obtenerUsuario } from '../servicios/usuarios.js';
import {
  generarCodigoOtp, hashOtp, hashToken, nuevoToken, iguales, fechaUtcSql, crearTicketRegistro,
} from '../seguridad.js';
import { urlActivacionWhatsapp } from '../servicios/activacionWhatsapp.js';

export const rutaOtp = Router();

// Solo las cuentas aprobadas por el administrador pueden iniciar sesión.
const ESTADOS_PERMITIDOS = ['activo'];
const MSG_PENDIENTE = 'Tu cuenta está en revisión. Recibirás acceso cuando el administrador la apruebe.';

/** Error específico para cuentas registradas que esperan aprobación manual. */
function errorCuentaPendiente(res, usuario) {
  const url = urlActivacionWhatsapp(usuario);
  return error(res, 403, 'CUENTA_PENDIENTE_APROBACION', MSG_PENDIENTE, url ? { whatsapp_activacion_url: url } : undefined);
}
const MSG_TELEFONO = 'Ingresa un celular boliviano válido (8 dígitos, empieza con 6 o 7).';
const PROPOSITOS = ['login', 'registro'];

// POST /otp/solicitar { telefono, proposito: "login" | "registro" }
rutaOtp.post('/solicitar', async (req, res) => {
  const telefono = normalizarTelefono(req.body?.telefono);
  const proposito = String(req.body?.proposito ?? 'login');
  const email = proposito === 'registro' ? String(req.body?.email ?? '').trim().toLowerCase() : null;
  if (telefono === null) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', { telefono: MSG_TELEFONO });
  }
  if (!PROPOSITOS.includes(proposito)) {
    return error(res, 422, 'DATOS_INVALIDOS', 'El propósito de verificación no es válido.', { proposito: 'Usa login o registro.' });
  }
  if (proposito === 'registro' && !/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(email ?? '')) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Ingresa un correo electrónico válido.', { email: 'Ingresa un correo electrónico válido.' });
  }

  const cooldown = await ajusteNumero('otp_cooldown_segundos', 60);
  const generica = {
    mensaje: proposito === 'registro' ? 'Número verificado parcialmente; ingresa el código enviado para continuar con tu cuenta.' : 'Te enviamos un código si la cuenta puede iniciar sesión.',
    reenvio_en_segundos: cooldown,
  };

  if (req.ip) {
    const maxPorIp = await ajusteNumero('otp_max_por_ip_hora', 15);
    const [[porIp]] = await db.execute(
      `SELECT COUNT(*) AS total FROM otp
        WHERE ip_origen = ? AND creado_en > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)`,
      [req.ip],
    );
    if (Number(porIp.total) >= maxPorIp) {
      return error(res, 429, 'DEMASIADOS_ENVIOS', 'Se pidieron demasiados códigos desde esta conexión. Intenta más tarde.');
    }
  }
  const maxDiario = await ajusteNumero('otp_max_diarios_global', 300);
  const [[global]] = await db.execute(
    'SELECT COUNT(*) AS total FROM otp WHERE creado_en > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)',
  );
  if (Number(global.total) >= maxDiario) {
    console.warn('[De Volada] ALERTA: se alcanzó el tope diario de códigos OTP (' + maxDiario + ').');
    return error(res, 503, 'ENVIO_NO_DISPONIBLE', 'El envío de códigos no está disponible por ahora. Intenta más tarde.');
  }

  const [usuarios] = await db.execute('SELECT id, estado, telefono, nombre, apellido, rol FROM usuarios WHERE telefono = ?', [telefono]);
  const usuario = usuarios[0];
  if (proposito === 'registro') {
    if (usuario) return error(res, 409, 'TELEFONO_REGISTRADO', 'Este número ya tiene una cuenta. Elige Iniciar sesión.');
    const [emails] = await db.execute('SELECT id FROM usuarios WHERE email = ? LIMIT 1', [email]);
    if (emails[0]) return error(res, 409, 'EMAIL_REGISTRADO', 'Este correo electrónico ya está registrado.', { email: 'Usa otro correo electrónico.' });
  } else {
    if (!usuario) return error(res, 404, 'CUENTA_NO_ENCONTRADA', 'No encontramos una cuenta con ese celular. Elige Registrarme para crearla.');
    // No se envía OTP a cuentas pendientes: ahorra mensajes y da un aviso claro.
    if (usuario.estado === 'pendiente') return errorCuentaPendiente(res, usuario);
    if (!ESTADOS_PERMITIDOS.includes(usuario.estado)) {
      return error(res, 403, 'CUENTA_NO_DISPONIBLE', 'Esta cuenta no está disponible.');
    }
  }

  const maxPorHora = await ajusteNumero('otp_max_envios_hora', 5);
  const [[uso]] = await db.execute(
    `SELECT COUNT(*) AS total,
            TIMESTAMPDIFF(SECOND, MAX(creado_en), UTC_TIMESTAMP()) AS desde_ultimo
       FROM otp
      WHERE telefono = ? AND creado_en > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)`,
    [telefono],
  );
  if (Number(uso.total) >= maxPorHora) {
    return error(res, 429, 'DEMASIADOS_ENVIOS', 'Pediste demasiados códigos. Intenta de nuevo en una hora.');
  }
  if (uso.desde_ultimo !== null && Number(uso.desde_ultimo) < cooldown) {
    const faltan = cooldown - Number(uso.desde_ultimo);
    return error(res, 429, 'ESPERA_REENVIO', `Espera ${faltan} segundos para pedir otro código.`);
  }

  const expiraMin = await ajusteNumero('otp_expira_minutos', 5);
  const maxIntentos = await ajusteNumero('otp_max_intentos', 5);
  const codigo = generarCodigoOtp();
  await db.execute(
    'UPDATE otp SET invalidado_en = UTC_TIMESTAMP() WHERE telefono = ? AND usado_en IS NULL AND invalidado_en IS NULL',
    [telefono],
  );
  const [ins] = await db.execute(
    `INSERT INTO otp (telefono, codigo_hash, proposito, max_intentos, expira_en, ip_origen)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [telefono, hashOtp(telefono, proposito, codigo), proposito, maxIntentos, fechaUtcSql(Date.now() + expiraMin * 60_000), req.ip ?? null],
  );

  try {
    await enviarOtp(telefono, codigo, proposito);
  } catch (e) {
    console.error('[De Volada] Falló el envío de OTP:', e.message);
    await db.execute('UPDATE otp SET invalidado_en = UTC_TIMESTAMP() WHERE id = ?', [ins.insertId]);
    return error(res, 502, 'ENVIO_FALLIDO', 'No pudimos enviar el código. Intenta de nuevo.');
  }

  return ok(res, generica);
});

// POST /otp/verificar { telefono, codigo, proposito }
rutaOtp.post('/verificar', async (req, res) => {
  const telefono = normalizarTelefono(req.body?.telefono);
  const codigo = String(req.body?.codigo ?? '').trim();
  const propositoSolicitado = String(req.body?.proposito ?? 'login');
  const emailRegistro = propositoSolicitado === 'registro' ? String(req.body?.email ?? '').trim().toLowerCase() : null;

  const errores = {};
  if (telefono === null) errores.telefono = MSG_TELEFONO;
  if (!/^\d{6}$/.test(codigo)) errores.codigo = 'El código tiene 6 dígitos.';
  if (!PROPOSITOS.includes(propositoSolicitado)) errores.proposito = 'Usa login o registro.';
  if (propositoSolicitado === 'registro' && !/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(emailRegistro ?? '')) errores.email = 'Ingresa un correo electrónico válido.';
  if (Object.keys(errores).length > 0) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', errores);

  const diasSesion = await ajusteNumero('sesion_dias', 30);
  const conexion = await db.getConnection();
  try {
    await conexion.beginTransaction();
    const [filas] = await conexion.execute(
      `SELECT id, codigo_hash, proposito, intentos, max_intentos
         FROM otp
        WHERE telefono = ? AND proposito IN ('registro','login')
          AND usado_en IS NULL AND invalidado_en IS NULL
          AND expira_en > UTC_TIMESTAMP()
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [telefono],
    );
    const otp = filas[0];
    if (!otp) {
      await conexion.rollback();
      return error(res, 400, 'CODIGO_INVALIDO', 'El código es incorrecto o venció. Pide uno nuevo.');
    }
    if (otp.proposito !== propositoSolicitado) {
      await conexion.rollback();
      return error(res, 400, 'PROPOSITO_INCORRECTO', 'Este código corresponde a otro proceso. Solicita uno nuevo.');
    }
    if (otp.intentos >= otp.max_intentos) {
      await conexion.execute('UPDATE otp SET usado_en = UTC_TIMESTAMP() WHERE id = ?', [otp.id]);
      await conexion.commit();
      return error(res, 429, 'INTENTOS_AGOTADOS', 'Superaste los intentos. Pide un código nuevo.');
    }
    if (!iguales(otp.codigo_hash, hashOtp(telefono, otp.proposito, codigo))) {
      const intentos = otp.intentos + 1;
      const restantes = otp.max_intentos - intentos;
      await conexion.execute('UPDATE otp SET intentos = intentos + 1 WHERE id = ?', [otp.id]);
      if (restantes <= 0) await conexion.execute('UPDATE otp SET usado_en = UTC_TIMESTAMP() WHERE id = ?', [otp.id]);
      await conexion.commit();
      const msg = restantes <= 0 ? 'Código incorrecto. Pide un código nuevo.' : `Código incorrecto. Te quedan ${restantes} ${restantes === 1 ? 'intento' : 'intentos'}.`;
      return error(res, 400, 'CODIGO_INVALIDO', msg);
    }

    await conexion.execute('UPDATE otp SET usado_en = UTC_TIMESTAMP() WHERE id = ?', [otp.id]);

    // Registro: la cuenta aún no existe. Solo emitimos un ticket firmado y temporal;
    // la cuenta se crea después de que el usuario complete sus datos y acepte los términos.
    if (otp.proposito === 'registro') {
      const [emailOcupado] = await conexion.execute('SELECT id FROM usuarios WHERE email = ? LIMIT 1', [emailRegistro]);
      if (emailOcupado[0]) {
        await conexion.commit();
        return error(res, 409, 'EMAIL_REGISTRADO', 'Este correo electrónico ya está registrado. Usa otro correo.', { email: 'Usa otro correo electrónico.' });
      }
      await conexion.commit();
      return ok(res, { ticket_registro: crearTicketRegistro(telefono, emailRegistro), expira_en: new Date(Date.now() + 15 * 60_000).toISOString() });
    }

    const [us] = await conexion.execute(
      'SELECT id, telefono, nombre, apellido, rol, estado FROM usuarios WHERE telefono = ? FOR UPDATE',
      [telefono],
    );
    const usuario = us[0];
    if (usuario?.estado === 'pendiente') {
      await conexion.commit();
      return errorCuentaPendiente(res, usuario);
    }
    if (!usuario || !ESTADOS_PERMITIDOS.includes(usuario.estado)) {
      await conexion.commit();
      return error(res, 403, 'CUENTA_NO_DISPONIBLE', 'Esta cuenta no está disponible.');
    }

    await conexion.execute(
      `UPDATE usuarios SET telefono_verificado = 1, ultimo_acceso_en = UTC_TIMESTAMP() WHERE id = ?`,
      [usuario.id],
    );
    const token = nuevoToken();
    const expira = Date.now() + diasSesion * 86_400_000;
    await conexion.execute(
      `INSERT INTO sesiones (usuario_id, token_hash, dispositivo, ip_origen, expira_en)
       VALUES (?, ?, ?, ?, ?)`,
      [usuario.id, hashToken(token), (req.get('user-agent') ?? '').slice(0, 150) || null, req.ip ?? null, fechaUtcSql(expira)],
    );
    await conexion.commit();
    return ok(res, { token, expira_en: new Date(expira).toISOString(), usuario: await obtenerUsuario(conexion, usuario.id) });
  } catch (e) {
    await conexion.rollback().catch(() => {});
    throw e;
  } finally {
    conexion.release();
  }
});
