import { error } from '../respuesta.js';

/**
 * Se usa DESPUÉS de `autenticar`. Exige que el rol de la cuenta (leído de la base de datos
 * en cada petición, no del token) sea uno de los indicados.
 * Se responde 404 y no 403 para no revelar que la ruta de administración existe.
 */
export const requerirRol = (...roles) => (req, res, next) => {
  if (!req.usuario || !roles.includes(req.usuario.rol)) {
    return error(res, 404, 'NO_ENCONTRADO', 'La ruta solicitada no existe.');
  }
  next();
};
