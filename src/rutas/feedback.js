import { Router } from 'express';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';

export const rutaFeedback = Router();
rutaFeedback.use(autenticar);

const ID = (v) => /^\d{1,18}$/.test(String(v ?? '')) && Number(v) > 0 ? Number(v) : null;
const puntajeValido = (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 5;
const categoriasSoporte = new Set(['cobro', 'conducta', 'seguridad', 'objeto_perdido', 'envio', 'app', 'otro']);

// GET /calificaciones/pendientes — solo servicios terminados donde participa el pasajero.
rutaFeedback.get('/calificaciones/pendientes', async (req, res) => {
  if (req.usuario.rol !== 'pasajero') return ok(res, { viajes: [], pedidos: [], envios: [] });
  const [viajes] = await db.execute(
    `SELECT v.id, v.finalizado_en, u.nombre AS conductor_nombre, u.apellido AS conductor_apellido
       FROM viajes v JOIN conductores c ON c.id=v.conductor_id JOIN usuarios u ON u.id=c.usuario_id
      WHERE v.pasajero_id=? AND v.estado='finalizado'
        AND NOT EXISTS (SELECT 1 FROM calificaciones k WHERE k.viaje_id=v.id AND k.calificador_id=?)
      ORDER BY v.finalizado_en DESC LIMIT 10`, [req.usuario.id, req.usuario.id],
  );
  const [pedidos] = await db.execute(
    `SELECT p.id, p.entregado_en, e.nombre_comercial
       FROM pedidos p JOIN empresas e ON e.id=p.empresa_id
      WHERE p.pasajero_id=? AND p.estado='entregado'
        AND NOT EXISTS (SELECT 1 FROM calificaciones_comercio k WHERE k.pedido_id=p.id AND k.calificador_id=?)
      ORDER BY p.entregado_en DESC LIMIT 10`, [req.usuario.id, req.usuario.id],
  );
  const [envios] = await db.execute(
    `SELECT e.id, e.entregado_en, uc.nombre AS conductor_nombre, uc.apellido AS conductor_apellido
       FROM envios e JOIN conductores c ON c.id=e.conductor_id JOIN usuarios uc ON uc.id=c.usuario_id
      WHERE (e.remitente_id=? OR e.destinatario_id=?) AND e.estado='entregado'
        AND NOT EXISTS (SELECT 1 FROM calificaciones_envios k WHERE k.envio_id=e.id AND k.calificador_id=?)
      ORDER BY e.entregado_en DESC LIMIT 10`, [req.usuario.id, req.usuario.id, req.usuario.id],
  );
  return ok(res, {
    viajes: viajes.map((v) => ({ id: Number(v.id), conductor_nombre: [v.conductor_nombre, v.conductor_apellido].filter(Boolean).join(' '), finalizado_en: v.finalizado_en })),
    pedidos: pedidos.map((p) => ({ id: Number(p.id), nombre_comercial: p.nombre_comercial, entregado_en: p.entregado_en })),
    envios: envios.map((e) => ({ id: Number(e.id), conductor_nombre: [e.conductor_nombre, e.conductor_apellido].filter(Boolean).join(' '), entregado_en: e.entregado_en })),
  });
});

// POST /calificaciones/app — una opinión de la app por usuario y versión.
rutaFeedback.post('/calificaciones/app', async (req, res) => {
  if (!puntajeValido(req.body?.puntaje)) return error(res, 422, 'PUNTAJE_INVALIDO', 'La calificación debe estar entre 1 y 5 estrellas.');
  const version = String(req.body?.app_version ?? 'desconocida').trim().slice(0, 30) || 'desconocida';
  const comentario = req.body?.comentario == null ? null : String(req.body.comentario).trim().slice(0, 500) || null;
  await db.execute(
    `INSERT INTO calificaciones_app (usuario_id, app_version, puntaje, comentario)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE puntaje=VALUES(puntaje), comentario=VALUES(comentario), actualizado_en=UTC_TIMESTAMP()`,
    [req.usuario.id, version, Number(req.body.puntaje), comentario],
  );
  return ok(res, { mensaje: 'Gracias por calificar De Volada.' });
});

// POST /calificaciones/viajes/:id — el pasajero califica al conductor de un viaje finalizado.
rutaFeedback.post('/calificaciones/viajes/:id', async (req, res) => {
  if (req.usuario.rol !== 'pasajero') return error(res, 403, 'ROL_NO_ADMITIDO', 'Solo un pasajero puede calificar un viaje.');
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'VIAJE_NO_ENCONTRADO', 'No se encontró el viaje.');
  if (!puntajeValido(req.body?.puntaje)) return error(res, 422, 'PUNTAJE_INVALIDO', 'La calificación debe estar entre 1 y 5 estrellas.');
  const [vs] = await db.execute(
    `SELECT v.id, v.conductor_id, c.usuario_id AS conductor_usuario_id
       FROM viajes v JOIN conductores c ON c.id=v.conductor_id
      WHERE v.id=? AND v.pasajero_id=? AND v.estado='finalizado' LIMIT 1`, [id, req.usuario.id],
  );
  const v = vs[0];
  if (!v) return error(res, 404, 'VIAJE_NO_CALIFICABLE', 'Solo puedes calificar un viaje tuyo que haya finalizado.');
  try {
    await db.execute(
      'INSERT INTO calificaciones (viaje_id, calificador_id, calificado_id, puntaje, comentario) VALUES (?, ?, ?, ?, ?)',
      [id, req.usuario.id, v.conductor_usuario_id, Number(req.body.puntaje), req.body.comentario == null ? null : String(req.body.comentario).trim().slice(0, 500) || null],
    );
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return error(res, 409, 'YA_CALIFICADO', 'Ya calificaste este viaje.');
    throw e;
  }
  return ok(res, { mensaje: 'Gracias por calificar al conductor.' }, 201);
});

// POST /calificaciones/envios/:id — remitente o destinatario califica al conductor tras una entrega verificada.
rutaFeedback.post('/calificaciones/envios/:id', async (req, res) => {
  if (req.usuario.rol !== 'pasajero') return error(res, 403, 'ROL_NO_ADMITIDO', 'Solo una cuenta pasajera puede calificar este envío.');
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'ENVIO_NO_ENCONTRADO', 'No se encontró el envío.');
  if (!puntajeValido(req.body?.puntaje)) return error(res, 422, 'PUNTAJE_INVALIDO', 'La calificación debe estar entre 1 y 5 estrellas.');
  const [filas] = await db.execute(
    `SELECT e.id, c.usuario_id AS conductor_usuario_id
       FROM envios e JOIN conductores c ON c.id=e.conductor_id
      WHERE e.id=? AND (e.remitente_id=? OR e.destinatario_id=?) AND e.estado='entregado' LIMIT 1`,
    [id, req.usuario.id, req.usuario.id],
  );
  const envio = filas[0];
  if (!envio) return error(res, 404, 'ENVIO_NO_CALIFICABLE', 'Solo puedes calificar un envío propio que haya sido entregado.');
  if (String(envio.conductor_usuario_id) === String(req.usuario.id)) return error(res, 422, 'CALIFICACION_INVALIDA', 'No puedes calificar tu propia cuenta.');
  try {
    await db.execute(
      'INSERT INTO calificaciones_envios (envio_id, calificador_id, calificado_id, puntaje, comentario) VALUES (?, ?, ?, ?, ?)',
      [id, req.usuario.id, envio.conductor_usuario_id, Number(req.body.puntaje), req.body.comentario == null ? null : String(req.body.comentario).trim().slice(0, 500) || null],
    );
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return error(res, 409, 'YA_CALIFICADO', 'Ya calificaste este envío.');
    throw e;
  }
  return ok(res, { mensaje: 'Gracias por calificar al repartidor.' }, 201);
});

// POST /calificaciones/pedidos/:id — el pasajero califica el comercio tras recibir el pedido.
rutaFeedback.post('/calificaciones/pedidos/:id', async (req, res) => {
  if (req.usuario.rol !== 'pasajero') return error(res, 403, 'ROL_NO_ADMITIDO', 'Solo un pasajero puede calificar un comercio.');
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  if (!puntajeValido(req.body?.puntaje)) return error(res, 422, 'PUNTAJE_INVALIDO', 'La calificación debe estar entre 1 y 5 estrellas.');
  const [ps] = await db.execute(
    `SELECT p.id, p.empresa_id FROM pedidos p WHERE p.id=? AND p.pasajero_id=? AND p.estado='entregado' LIMIT 1`,
    [id, req.usuario.id],
  );
  if (!ps[0]) return error(res, 404, 'PEDIDO_NO_CALIFICABLE', 'Solo puedes calificar un pedido tuyo que haya sido entregado.');
  try {
    await db.execute(
      'INSERT INTO calificaciones_comercio (pedido_id, calificador_id, empresa_id, puntaje, comentario) VALUES (?, ?, ?, ?, ?)',
      [id, req.usuario.id, ps[0].empresa_id, Number(req.body.puntaje), req.body.comentario == null ? null : String(req.body.comentario).trim().slice(0, 500) || null],
    );
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return error(res, 409, 'YA_CALIFICADO', 'Ya calificaste este pedido.');
    throw e;
  }
  return ok(res, { mensaje: 'Gracias por calificar el comercio.' }, 201);
});

// POST /soporte/tickets — usa reclamos como centro de soporte y deja el caso visible al administrador.
rutaFeedback.post('/soporte/tickets', async (req, res) => {
  const categoria = String(req.body?.categoria ?? 'app');
  const descripcion = String(req.body?.descripcion ?? '').trim();
  const viajeId = req.body?.viaje_id == null || req.body.viaje_id === '' ? null : ID(req.body.viaje_id);
  const pedidoId = req.body?.pedido_id == null || req.body.pedido_id === '' ? null : ID(req.body.pedido_id);
  const envioId = req.body?.envio_id == null || req.body.envio_id === '' ? null : ID(req.body.envio_id);
  if (!categoriasSoporte.has(categoria)) return error(res, 422, 'CATEGORIA_INVALIDA', 'Selecciona una categoría válida.');
  if (descripcion.length < 10 || descripcion.length > 4000) return error(res, 422, 'DESCRIPCION_INVALIDA', 'Describe el caso con entre 10 y 4.000 caracteres.');
  if (req.body?.viaje_id != null && req.body.viaje_id !== '' && !viajeId) return error(res, 422, 'VIAJE_INVALIDO', 'El viaje indicado no es válido.');
  if (req.body?.pedido_id != null && req.body.pedido_id !== '' && !pedidoId) return error(res, 422, 'PEDIDO_INVALIDO', 'El pedido indicado no es válido.');
  if (req.body?.envio_id != null && req.body.envio_id !== '' && !envioId) return error(res, 422, 'ENVIO_INVALIDO', 'El envío indicado no es válido.');
  if ([viajeId, pedidoId, envioId].filter(Boolean).length > 1) return error(res, 422, 'REFERENCIA_AMBIGUA', 'Indica solo un servicio para este ticket.');
  if (viajeId) {
    const [rows] = await db.execute('SELECT v.id FROM viajes v LEFT JOIN conductores c ON c.id=v.conductor_id WHERE v.id=? AND (v.pasajero_id=? OR c.usuario_id=?) LIMIT 1', [viajeId, req.usuario.id, req.usuario.id]);
    if (!rows[0]) return error(res, 403, 'VIAJE_NO_AUTORIZADO', 'No puedes abrir un reclamo sobre un viaje ajeno.');
  }
  if (envioId) {
    const [rows] = await db.execute(
      `SELECT e.id FROM envios e LEFT JOIN conductores c ON c.id=e.conductor_id
        WHERE e.id=? AND (e.remitente_id=? OR e.destinatario_id=? OR c.usuario_id=?) LIMIT 1`,
      [envioId, req.usuario.id, req.usuario.id, req.usuario.id],
    );
    if (!rows[0]) return error(res, 403, 'ENVIO_NO_AUTORIZADO', 'No puedes abrir un reclamo sobre un envío ajeno.');
  }
  if (pedidoId) {
    const [rows] = await db.execute(
      `SELECT p.id FROM pedidos p LEFT JOIN empresas e ON e.id=p.empresa_id LEFT JOIN conductores c ON c.id=p.conductor_id
        WHERE p.id=? AND (p.pasajero_id=? OR e.usuario_id=? OR c.usuario_id=?) LIMIT 1`,
      [pedidoId, req.usuario.id, req.usuario.id, req.usuario.id],
    );
    if (!rows[0]) return error(res, 403, 'PEDIDO_NO_AUTORIZADO', 'No puedes abrir un reclamo sobre un pedido ajeno.');
  }
  const [r] = await db.execute(
    'INSERT INTO reclamos (usuario_id, viaje_id, pedido_id, envio_id, categoria, descripcion) VALUES (?, ?, ?, ?, ?, ?)',
    [req.usuario.id, viajeId, pedidoId, envioId, categoria, descripcion],
  );
  return ok(res, { ticket_id: Number(r.insertId), estado: 'abierto', mensaje: 'Tu solicitud fue enviada a soporte.' }, 201);
});

rutaFeedback.get('/soporte/tickets', async (req, res) => {
  const [tickets] = await db.execute(
    `SELECT id, viaje_id, pedido_id, envio_id, categoria, descripcion, estado, respuesta, creado_en, resuelto_en
       FROM reclamos WHERE usuario_id=? ORDER BY creado_en DESC LIMIT 50`, [req.usuario.id],
  );
  return ok(res, { tickets: tickets.map((t) => ({ ...t, id: Number(t.id), viaje_id: t.viaje_id == null ? null : Number(t.viaje_id), pedido_id: t.pedido_id == null ? null : Number(t.pedido_id), envio_id: t.envio_id == null ? null : Number(t.envio_id) })) });
});
