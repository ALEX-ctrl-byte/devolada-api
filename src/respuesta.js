/**
 * Formato único de respuestas:
 *   éxito: { ok: true,  datos: {...} }
 *   error: { ok: false, error: { codigo, mensaje, detalles? } }
 */
export function ok(res, datos, estado = 200) {
  return res.status(estado).json({ ok: true, datos });
}

export function error(res, estado, codigo, mensaje, detalles) {
  const cuerpo = { codigo, mensaje };
  if (detalles && Object.keys(detalles).length > 0) cuerpo.detalles = detalles;
  return res.status(estado).json({ ok: false, error: cuerpo });
}
