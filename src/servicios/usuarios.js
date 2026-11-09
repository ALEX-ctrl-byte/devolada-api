/** Formato único del usuario que ve la app. `perfil_completo` se calcula, no se guarda. */
export function formatearUsuario(f) {
  return {
    id: f.id,
    telefono: f.telefono,
    nombre: f.nombre,
    apellido: f.apellido ?? null,
    rol: f.rol,
    estado: f.estado,
    ciudad_id: f.ciudad_id ?? null,
    ciudad: f.ciudad ?? null,
    fecha_nacimiento: f.fecha_nacimiento ?? null,
    sexo: f.sexo ?? null,
    perfil_completo: Boolean(f.nombre && f.apellido && f.ciudad_id && f.fecha_nacimiento && f.sexo),
  };
}

/** `ejecutor` puede ser el pool (db) o una conexión de transacción. */
export async function obtenerUsuario(ejecutor, id) {
  const [filas] = await ejecutor.execute(
    `SELECT u.id, u.telefono, u.nombre, u.apellido, u.rol, u.estado, u.ciudad_id,
            c.nombre AS ciudad, u.sexo,
            DATE_FORMAT(u.fecha_nacimiento, '%Y-%m-%d') AS fecha_nacimiento
       FROM usuarios u
       LEFT JOIN ciudades c ON c.id = u.ciudad_id
      WHERE u.id = ?`,
    [id],
  );
  return filas[0] ? formatearUsuario(filas[0]) : null;
}
