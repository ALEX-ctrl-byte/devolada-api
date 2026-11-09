import { Router } from 'express';
import { db } from '../db.js';
import { ok } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';
import { desconectarSesion } from '../tiempoReal.js';

export const rutaSesion = Router();

// GET /yo : datos del usuario de la sesión actual (sirve para validar el token al abrir la app)
rutaSesion.get('/yo', autenticar, (req, res) => ok(res, req.usuario));

// POST /sesion/cerrar : revoca el token actual
rutaSesion.post('/sesion/cerrar', autenticar, async (req, res) => {
  await db.execute('UPDATE sesiones SET revocada_en = UTC_TIMESTAMP() WHERE id = ?', [req.sesionId]);
  desconectarSesion(req.sesionId); // Etapa 9: se corta también la conexión en vivo
  ok(res, { mensaje: 'Sesión cerrada.' });
});
