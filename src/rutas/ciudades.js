import { Router } from 'express';
import { db } from '../db.js';
import { ok } from '../respuesta.js';

export const rutaCiudades = Router();

// GET /ciudades : ciudades donde De Volada opera (no es información sensible)
rutaCiudades.get('/', async (_req, res) => {
  const [filas] = await db.execute('SELECT id, nombre FROM ciudades WHERE activa = 1 ORDER BY nombre');
  ok(res, { ciudades: filas });
});
