import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcularImporteTransportes } from '../src/servicios/calculoTarifaPura.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('ejemplo de calibración: misma ruta cuesta Bs 16 en moto y Bs 25 en auto con base abundante de Bs 3', () => {
  const ruta = { distanciaServicioM: 4500, duracionServicioS: 16 * 60, distanciaAproximacionM: 1800, duracionAproximacionS: 7 * 60 };
  const moto = calcularImporteTransportes({
    base: 3, ...ruta, precioPorKm: 1, precioTiempo5Min: 1,
    precioAproximacionPorKm: 1, precioAproximacionTiempo5Min: 1,
  });
  const auto = calcularImporteTransportes({
    base: 3, ...ruta, precioPorKm: 2, precioTiempo5Min: 1,
    precioAproximacionPorKm: 2, precioAproximacionTiempo5Min: 2,
  });
  assert.equal(moto.tarifaBs, 16);
  assert.equal(auto.tarifaBs, 25);
  assert.equal(Number.isInteger(moto.tarifaBs), true);
  assert.equal(Number.isInteger(auto.tarifaBs), true);
});

test('con oferta normal se mantiene la base de Bs 4 y cada importe de transporte es entero', () => {
  const ruta = { distanciaServicioM: 4500, duracionServicioS: 16 * 60, distanciaAproximacionM: 1800, duracionAproximacionS: 7 * 60 };
  const moto = calcularImporteTransportes({
    base: 4, ...ruta, precioPorKm: 1, precioTiempo5Min: 1,
    precioAproximacionPorKm: 1, precioAproximacionTiempo5Min: 1,
  });
  const auto = calcularImporteTransportes({
    base: 4, ...ruta, precioPorKm: 2, precioTiempo5Min: 1,
    precioAproximacionPorKm: 2, precioAproximacionTiempo5Min: 2,
  });
  assert.equal(moto.tarifaBs, 17);
  assert.equal(auto.tarifaBs, 26);
  for (const resultado of [moto, auto]) {
    for (const valor of Object.values(resultado)) assert.equal(Number.isInteger(valor), true);
  }
});

test('viajes, envíos personales y delivery comercial usan el mismo motor y cotización firmada', () => {
  const viajes = read('src/rutas/viajes.js');
  const envios = read('src/rutas/envios.js');
  const pedidos = read('src/rutas/pedidos.js');
  for (const fuente of [viajes, envios, pedidos]) {
    assert.match(fuente, /calcularTarifaDeUna/);
    assert.match(fuente, /cotizacion_token/);
  }
  assert.match(envios, /rutaEnvios\.post\('\/cotizar'/);
  assert.match(pedidos, /rutaPedidos\.post\('\/cotizar-delivery'/);
  assert.match(viajes, /rutaViajes\.post\('\/cotizar'/);
});

test('la migración es aditiva e inicializa las bases Bs 4/Bs 3 con parámetros independientes de moto y auto', () => {
  const sql = read('sql/migracion_tarifas_dinamicas_enteras.sql');
  assert.doesNotMatch(sql, /DROP\s+(DATABASE|TABLE)/i);
  assert.match(sql, /'tarifa_base_normal_bs', '4'/);
  assert.match(sql, /'tarifa_base_muchos_conductores_bs', '3'/);
  assert.match(sql, /'tarifa_aproximacion_tiempo_auto_5min_bs', '2'/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE descripcion=VALUES\(descripcion\)/);
});


test('detalle administrativo de conductor pasa el ID como parámetro SQL y no lo indexa en la cadena', () => {
  const admin = read('src/rutas/admin.js');
  assert.match(admin, /FROM motos WHERE conductor_id = \?',\s*\n\s*\[req\.params\.id\]/);
});
