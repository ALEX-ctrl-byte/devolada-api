import { db } from '../db.js';
import { error } from '../respuesta.js';
import { hashToken } from '../seguridad.js';
import { formatearUsuario } from '../servicios/usuarios.js';

/**
 * Exige "Authorization: Bearer <token>". Si es válido, deja en la petición:
 *   req.usuario  -> usuario con datos de perfil (ver formatearUsuario)
 *   req.sesionId -> id de la fila en `sesiones`
 */
export async function autenticar(req, res, next) {
  const m = (req.get('authorization') ?? '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return error(res, 401, 'NO_AUTENTICADO', 'Debes iniciar sesión.');

  const [filas] = await db.execute(
    `SELECT s.id AS sesion_id, u.id, u.telefono, u.nombre, u.apellido, u.rol, u.estado,
            u.ciudad_id, c.nombre AS ciudad, u.sexo,
            DATE_FORMAT(u.fecha_nacimiento, '%Y-%m-%d') AS fecha_nacimiento
       FROM sesiones s
       JOIN usuarios u ON u.id = s.usuario_id
       LEFT JOIN ciudades c ON c.id = u.ciudad_id
      WHERE s.token_hash = ? AND s.revocada_en IS NULL AND s.expira_en > UTC_TIMESTAMP()
      LIMIT 1`,
    [hashToken(m[1])],
  );
  const f = filas[0];
  if (!f) return error(res, 401, 'SESION_INVALIDA', 'Tu sesión expiró. Inicia sesión de nuevo.');
  if (f.estado !== 'activo') {
    return error(res, 403, 'CUENTA_NO_DISPONIBLE', 'Esta cuenta no está disponible.');
  }

  req.sesionId = f.sesion_id;
  req.usuario = formatearUsuario(f);
  next();
}
