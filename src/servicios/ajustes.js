import { db } from '../db.js';

/** Lee un parámetro numérico de la tabla `configuracion`; si no existe usa el valor por defecto. */
export async function ajusteNumero(clave, defecto) {
  const [filas] = await db.execute('SELECT valor FROM configuracion WHERE clave = ?', [clave]);
  const n = Number(filas[0]?.valor);
  return Number.isFinite(n) ? n : defecto;
}
