import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => fs.readFileSync(path.join(root, p), 'utf8');

 test('las recargas cumplen Bs 2 por operación y mínimo de Bs 2', () => {
  const ruta = leer('src/rutas/billetera.js');
  assert.match(ruta, /OPERACIONES_POR_BS = 0\.5/);
  assert.match(ruta, /monto >= 2/);
  assert.match(ruta, /monto \/ 2 - Math\.round\(monto \/ 2\)/);
  assert.match(ruta, /operacionesPorMonto\(monto\)/);
});

test('solo conductor y comercio pueden ver operaciones', () => {
  const ruta = leer('src/rutas/billetera.js');
  assert.match(ruta, /new Set\(\['conductor', 'comercio'\]\)/);
  assert.match(ruta, /OPERACIONES_NO_DISPONIBLES/);
  const android = fs.readFileSync(path.resolve(root, '../APP_ANDROID_DEVOLADA/app/src/main/java/com/deuna/app/ui/componentes/BarraInferior.kt'), 'utf8');
  assert.match(android, /rol == "pasajero"/);
});

test('una operación se descuenta al completar viajes, envíos y ventas', () => {
  const config = leer('src/config.js');
  const viajes = leer('src/rutas/viajes.js');
  const envios = leer('src/rutas/envios.js');
  const pedidos = leer('src/rutas/pedidos.js');
  assert.match(config, /operacionesPorServicio: 1/);
  assert.match(viajes, /const comisionFinal = config\.operacionesPorServicio/);
  assert.match(envios, /const comision = config\.operacionesPorServicio/);
  assert.match(pedidos, /const comisionVenta = config\.operacionesPorServicio/);
});

test('retiros, transferencias entre usuarios y envío de dinero están bloqueados', () => {
  const operaciones = leer('src/rutas/billetera.js');
  const admin = leer('src/rutas/admin.js');
  assert.match(operaciones, /rutaOperaciones\.all\('\/retiros'/);
  assert.match(operaciones, /rutaOperaciones\.all\('\/transferencias'/);
  assert.match(operaciones, /rutaOperaciones\.all\('\/transferir'/);
  assert.match(operaciones, /rutaOperaciones\.all\('\/enviar-dinero'/);
  assert.match(admin, /rutaAdmin\.all\('\/operaciones\/retiros'/);
});

test('la migración mantiene el historial PTS y reconstruye las reservas por servicio activo', () => {
  const sql = leer('sql/migracion_operaciones_disponibles.sql');
  assert.match(sql, /FLOOR\(saldo_prepago \/ 2\)/);
  assert.match(sql, /modelo_operaciones_v1/);
  assert.match(sql, /SELECT COUNT\(\*\) FROM viajes/);
  assert.match(sql, /SELECT COUNT\(\*\) FROM pedidos/);
  assert.match(sql, /SELECT COUNT\(\*\) FROM envios/);
  assert.doesNotMatch(sql, /UPDATE movimientos_billetera\s+SET/i);
});
