import { Router } from 'express';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';
import { ajusteNumero } from '../servicios/ajustes.js';
import { obtenerUsuario } from '../servicios/usuarios.js';
import { validarFechaNacimiento } from '../validador.js';

export const rutaPerfil = Router();

const SEXOS = ['femenino', 'masculino', 'prefiero_no_decir'];

// PUT /perfil   { ciudad_id, fecha_nacimiento: "YYYY-MM-DD", sexo, nombre?, apellido? }
// Completa (o corrige) los datos del perfil de la sesión actual. Sirve para pasajeros y conductores.
rutaPerfil.put('/perfil', autenticar, async (req, res) => {
  const b = req.body ?? {};
  const errores = {};

  // Ciudad: debe existir y estar activa
  const ciudadId = Number(b.ciudad_id);
  if (!Number.isInteger(ciudadId) || ciudadId <= 0) {
    errores.ciudad_id = 'Elige tu ciudad.';
  } else {
    const [c] = await db.execute('SELECT id FROM ciudades WHERE id = ? AND activa = 1', [ciudadId]);
    if (!c[0]) errores.ciudad_id = 'Esa ciudad no está disponible.';
  }

  // Fecha de nacimiento (se guarda la fecha, no la edad: la edad se calcula al consultar)
  const edadMinima = await ajusteNumero('edad_minima', 18);
  const fecha = validarFechaNacimiento(b.fecha_nacimiento, edadMinima);
  if (fecha.error) errores.fecha_nacimiento = fecha.error;

  // Sexo
  const sexo = String(b.sexo ?? '');
  if (!SEXOS.includes(sexo)) errores.sexo = 'Elige una opción.';

  // Nombre y apellido: opcionales aquí, pero si vienen deben ser válidos
  const nombre = b.nombre === undefined ? req.usuario.nombre : String(b.nombre).trim();
  if (nombre.length < 2 || nombre.length > 100) {
    errores.nombre = 'El nombre debe tener entre 2 y 100 caracteres.';
  }
  const apellido = b.apellido === undefined ? req.usuario.apellido : String(b.apellido ?? '').trim();
  if (!apellido || apellido.length < 2 || apellido.length > 100) {
    errores.apellido = 'El apellido debe tener entre 2 y 100 caracteres.';
  }

  // Con la postulación en revisión o aprobada, nombre y fecha de nacimiento deben coincidir con
  // la cédula revisada: no se pueden cambiar desde la app (los cambios pasan por soporte).
  if (Object.keys(errores).length === 0) {
    const [cs] = await db.execute('SELECT estado_aprobacion FROM conductores WHERE usuario_id = ?', [req.usuario.id]);
    if (cs[0] && ['en_revision', 'aprobado'].includes(cs[0].estado_aprobacion)) {
      const msg = 'No se puede cambiar mientras tu postulación esté en revisión o aprobada. Contacta a soporte.';
      if (nombre !== req.usuario.nombre) errores.nombre = msg;
      if (apellido !== req.usuario.apellido) errores.apellido = msg;
      if (fecha.fecha !== req.usuario.fecha_nacimiento) errores.fecha_nacimiento = msg;
    }
  }

  if (Object.keys(errores).length > 0) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', errores);
  }

  await db.execute(
    `UPDATE usuarios
        SET ciudad_id = ?, fecha_nacimiento = ?, sexo = ?, nombre = ?, apellido = ?
      WHERE id = ?`,
    [ciudadId, fecha.fecha, sexo, nombre, apellido, req.usuario.id],
  );

  return ok(res, await obtenerUsuario(db, req.usuario.id));
});
