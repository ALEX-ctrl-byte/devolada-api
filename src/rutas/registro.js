import { Router } from 'express';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { normalizarTelefono, validarFechaNacimiento } from '../validador.js';
import { ajusteNumero } from '../servicios/ajustes.js';
import { config } from '../config.js';
import { obtenerUsuario } from '../servicios/usuarios.js';
import { validarTicketRegistro } from '../seguridad.js';
import { urlActivacionWhatsapp } from '../servicios/activacionWhatsapp.js';

export const rutaRegistro = Router();

// POST /registro
// El teléfono debe haberse verificado primero en /otp/verificar (proposito=registro).
// La cuenta nace en estado 'pendiente': el usuario envía un WhatsApp al administrador y
// solo después de la aprobación manual desde el panel puede iniciar sesión. No se emite token.
// Cuerpo: { telefono, ticket_registro, nombre, apellido, email, fecha_nacimiento, sexo, rol, acepto_terminos }
rutaRegistro.post('/', (req, res) => registrarUsuario(req, res, { exigirTicket: true }));

/**
 * Lógica común de registro. La usan POST /registro (con ticket OTP, legado) y
 * POST /registro-pin (sin OTP: el teléfono lo verifica el administrador por WhatsApp).
 * `pinHash`: hash bcrypt del PIN de inicio de sesión, o null.
 */
export async function registrarUsuario(req, res, { exigirTicket, pinHash = null, erroresExtra = {} }) {
  const entrada = req.body;
  if (entrada === null || typeof entrada !== 'object' || Array.isArray(entrada)) {
    return error(res, 400, 'JSON_INVALIDO', 'El cuerpo de la solicitud debe ser un objeto JSON.');
  }

  const errores = { ...erroresExtra };
  const telefono = normalizarTelefono(entrada.telefono);
  if (telefono === null) errores.telefono = 'Ingresa un celular boliviano válido (8 dígitos, empieza con 6 o 7).';
  const email = String(entrada.email ?? '').trim().toLowerCase();
  if (exigirTicket && (!telefono || !validarTicketRegistro(String(entrada.ticket_registro ?? ''), telefono, email))) {
    errores.ticket_registro = 'La verificación del celular venció o no es válida. Verifica tu número nuevamente.';
  }

  const nombre = String(entrada.nombre ?? '').trim();
  if (nombre.length < 2 || nombre.length > 100) errores.nombre = 'El nombre debe tener entre 2 y 100 caracteres.';

  const apellido = String(entrada.apellido ?? '').trim();
  if (apellido.length < 2 || apellido.length > 100) errores.apellido = 'Ingresa tus apellidos (mínimo 2 caracteres).';

  if (email.length > 150 || !/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(email)) {
    errores.email = 'Ingresa un correo electrónico válido.';
  }

  const ciudadId = Number(entrada.ciudad_id);
  if (!Number.isSafeInteger(ciudadId) || ciudadId < 1) errores.ciudad_id = 'Selecciona una ciudad válida.';
  else {
    const [ciudades] = await db.execute('SELECT id FROM ciudades WHERE id = ? AND activa = 1 LIMIT 1', [ciudadId]);
    if (!ciudades[0]) errores.ciudad_id = 'La ciudad seleccionada no está activa.';
  }

  const rol = String(entrada.rol ?? '');
  if (!['pasajero', 'conductor', 'comercio'].includes(rol)) {
    errores.rol = 'El rol debe ser "pasajero", "conductor" o "comercio".';
  }

  const edadMinima = await ajusteNumero('edad_minima', 18);
  const fecha = validarFechaNacimiento(entrada.fecha_nacimiento, edadMinima);
  if (fecha.error) errores.fecha_nacimiento = fecha.error;

  const sexos = ['femenino', 'masculino', 'prefiero_no_decir'];
  const sexo = String(entrada.sexo ?? '');
  if (!sexos.includes(sexo)) errores.sexo = 'Elige una opción.';

  if (entrada.acepto_terminos !== true) {
    errores.acepto_terminos = 'Debes aceptar los términos y la política de privacidad.';
  }

  if (Object.keys(errores).length > 0) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', errores);
  }

  const ip = req.ip ?? null;
  if (ip) {
    const maxPorHora = await ajusteNumero('registro_max_por_ip_hora', 10);
    const [[uso]] = await db.execute(
      `SELECT COUNT(*) AS total FROM usuarios
        WHERE ip_registro = ? AND creado_en > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)`,
      [ip],
    );
    if (Number(uso.total) >= maxPorHora) {
      return error(res, 429, 'DEMASIADOS_REGISTROS', 'Se hicieron demasiados registros desde esta conexión. Intenta más tarde.');
    }
  }

  const conexion = await db.getConnection();
  try {
    await conexion.beginTransaction();
    // Con PIN el teléfono aún no está verificado: lo confirma el administrador al recibir el WhatsApp.
    const columnaPin = pinHash ? ', pin_hash' : '';
    const valorPin = pinHash ? ', ?' : '';
    const [resultado] = await conexion.execute(
      `INSERT INTO usuarios
         (telefono, nombre, apellido, email, rol, fecha_nacimiento, sexo, ciudad_id, estado,
          telefono_verificado, ip_registro, acepto_terminos_en, version_terminos, ultimo_acceso_en${columnaPin})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, UTC_TIMESTAMP(), ?, UTC_TIMESTAMP()${valorPin})`,
      [telefono, nombre, apellido, email, rol, fecha.fecha, sexo, ciudadId, exigirTicket ? 1 : 0, ip, config.versionTerminos,
        ...(pinHash ? [pinHash] : [])],
    );

    const usuario = await obtenerUsuario(conexion, resultado.insertId);
    await conexion.commit();
    // Sin token de sesión: la cuenta queda en revisión hasta que un administrador la apruebe.
    return ok(res, {
      estado: 'pendiente',
      usuario,
      whatsapp_activacion_url: urlActivacionWhatsapp({ telefono, nombre, apellido, rol }),
      mensaje: 'Tu cuenta fue creada y está en revisión. Envía el mensaje de WhatsApp para solicitar la activación.',
    }, 201);
  } catch (e) {
    await conexion.rollback().catch(() => {});
    if (e.code === 'ER_DUP_ENTRY') {
      if (String(e.message).includes('uq_usuarios_email') || String(e.message).toLowerCase().includes('email')) {
        return error(res, 409, 'EMAIL_REGISTRADO', 'Este correo electrónico ya está registrado.', { email: 'Usa otro correo electrónico.' });
      }
      return error(res, 409, 'TELEFONO_REGISTRADO', 'Este número ya tiene una cuenta. Inicia sesión.', { telefono: 'Este número ya tiene una cuenta.' });
    }
    throw e;
  } finally {
    conexion.release();
  }
}
