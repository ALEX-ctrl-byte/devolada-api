import { Router } from 'express';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';

export const rutaComerciosPublicos = Router();

// Solo muestra comercios que un administrador haya aprobado y cuyo responsable siga activo.
rutaComerciosPublicos.get('/', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  const ciudad = String(req.query.ciudad ?? '').trim().slice(0, 80);
  const filtros = ["e.estado_aprobacion = 'aprobado'", "u.estado = 'activo'", '(e.saldo_comision - e.saldo_comision_reservado) > 0', "e.qr_pago_url IS NOT NULL", 'e.qr_pago_vence_en > UTC_TIMESTAMP()'];
  const params = [];
  if (q) {
    filtros.push('(e.nombre_comercial LIKE ? OR e.rubro LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (ciudad) {
    filtros.push('ci.nombre = ?');
    params.push(ciudad);
  }
  const [comercios] = await db.execute(
    `SELECT e.id, e.nombre_comercial, e.logo_url, e.rubro, e.telefono_contacto, e.direccion,
            e.latitud, e.longitud,
            (SELECT COUNT(*) FROM productos_comercio p WHERE p.empresa_id = e.id AND p.activo = 1) AS productos_activos
       FROM empresas e JOIN usuarios u ON u.id = e.usuario_id
       LEFT JOIN ciudades ci ON ci.id = u.ciudad_id
      WHERE ${filtros.join(' AND ')} ORDER BY e.nombre_comercial ASC LIMIT 100`,
    params,
  );
  return ok(res, { comercios });
});

rutaComerciosPublicos.get('/:id/productos', async (req, res) => {
  if (!/^\d{1,18}$/.test(String(req.params.id))) return error(res, 404, 'NO_ENCONTRADO', 'Comercio no encontrado.');
  const [comercios] = await db.execute(
    `SELECT id, nombre_comercial, logo_url, rubro, telefono_contacto, direccion, latitud, longitud
       FROM empresas WHERE id = ? AND estado_aprobacion = 'aprobado' AND (saldo_comision - saldo_comision_reservado) > 0 AND qr_pago_url IS NOT NULL AND qr_pago_vence_en > UTC_TIMESTAMP() LIMIT 1`,
    [req.params.id],
  );
  if (!comercios[0]) return error(res, 404, 'COMERCIO_NO_PUBLICADO', 'Este comercio todavía no está publicado.');
  const [productos] = await db.execute(
    `SELECT id, nombre, categoria, descripcion, precio, stock, imagen_url
       FROM productos_comercio WHERE empresa_id = ? AND activo = 1 ORDER BY nombre ASC`,
    [req.params.id],
  );
  return ok(res, { comercio: comercios[0], productos });
});
