import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('envíos requieren destinatario con cuenta activa y teléfono verificado', () => {
  const src = read('src/rutas/envios.js');
  assert.match(src, /telefono=\? AND telefono_verificado=1 AND estado='activo'/);
  assert.match(src, /DESTINATARIO_NO_VERIFICADO/);
});

test('PIN de recogida requiere GPS reciente a 200m y deja de ser válido tras recoger', () => {
  const src = read('src/rutas/envios.js');
  assert.match(src, /distanciaRecogida>200/);
  assert.match(src, /gpsReciente\(cx,cs\[0\]\?\.id\)/);
  assert.match(src, /codigo_recogida_hash=NULL,codigo_recogida_cifrado=NULL/);
});

test('PIN de entrega es exclusivo del destinatario, vence en 15 minutos y tiene intentos limitados', () => {
  const src = read('src/rutas/envios.js');
  assert.match(src, /esDestinatario && incluirPinEntrega && e\.estado === 'en_punto_entrega'/);
  assert.match(src, /INTERVAL 15 MINUTE/);
  assert.match(src, /intentos_codigo_entrega/);
  assert.match(src, /distancia>200/);
});

test('migración de envíos, vehículos y soporte es aditiva y contempla soporte de envío', () => {
  const sql = read('sql/migracion_soporte_calificaciones_vehiculos_envios.sql');
  assert.doesNotMatch(sql, /DROP\s+(DATABASE|TABLE)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS envios/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS calificaciones_envios/i);
  assert.match(sql, /categoria ENUM\([\s\S]*?'envio'/i);
  assert.match(sql, /ADD COLUMN envio_id BIGINT UNSIGNED NULL/i);
  assert.match(sql, /saldo_comision_reservado/);
});
