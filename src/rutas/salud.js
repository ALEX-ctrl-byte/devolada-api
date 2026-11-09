import { createRequire } from 'node:module';
import { Router } from 'express';
import { db } from '../db.js';
import { ok } from '../respuesta.js';

const { version } = createRequire(import.meta.url)('../../package.json');

export const rutaSalud = Router();

// GET /salud : comprueba que la API responde y que MySQL está conectado
rutaSalud.get('/', async (_req, res) => {
  await db.query('SELECT 1');
  ok(res, {
    api: 'De Volada API',
    version,
    base_datos: 'conectada',
    hora_utc: new Date().toISOString(),
  });
});
