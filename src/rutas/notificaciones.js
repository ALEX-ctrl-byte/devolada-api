import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';

export const rutaNotificaciones = Router();
rutaNotificaciones.use(autenticar);

rutaNotificaciones.post('/dispositivos', async (req, res) => {
  const token = String(req.body?.token ?? '').trim();
  const plataforma = String(req.body?.plataforma ?? 'android').trim().toLowerCase();
  if (token.length < 80 || token.length > 4096 || plataforma !== 'android') {
    return error(res, 422, 'TOKEN_NOTIFICACION_INVALIDO', 'El token de notificaciones no es válido.');
  }
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await db.execute(
    `INSERT INTO notificaciones_dispositivos (usuario_id, token, token_hash, plataforma, actualizado_en)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE usuario_id=VALUES(usuario_id), token=VALUES(token), plataforma=VALUES(plataforma), actualizado_en=UTC_TIMESTAMP()`,
    [req.usuario.id, token, hash, plataforma],
  );
  return ok(res, { registrado: true, mensaje: 'Este dispositivo recibirá notificaciones de De Volada.' });
});

rutaNotificaciones.delete('/dispositivos', async (req, res) => {
  const token = String(req.body?.token ?? '').trim();
  if (token.length < 80 || token.length > 4096) {
    return error(res, 422, 'TOKEN_NOTIFICACION_INVALIDO', 'El token del dispositivo no es válido.');
  }
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const [r] = await db.execute('DELETE FROM notificaciones_dispositivos WHERE usuario_id=? AND token_hash=?', [req.usuario.id, hash]);
  return ok(res, { eliminado: Number(r.affectedRows) > 0 });
});
