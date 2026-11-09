import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('la migración de ciudades no borra la base y deja activas solo La Paz y El Alto', () => {
  const sql = leer('sql/migracion_ciudades_lanzamiento.sql');
  assert.match(sql, /nombre IN \('La Paz', 'El Alto'\) THEN 1 ELSE 0 END/i);
  assert.doesNotMatch(sql, /DROP\s+DATABASE|DROP\s+TABLE/i);
});

test('configuración de producción rechaza el proveedor OTP de consola y secretos ausentes', () => {
  const js = leer('src/config.js');
  assert.match(js, /OTP_PROVEEDOR debe ser whatsapp en producción/i);
  assert.match(js, /OTP_SECRET debe ser una clave aleatoria/i);
  assert.match(js, /DB_USER debe ser un usuario MySQL dedicado/i);
  assert.match(js, /PUBLIC_API_URL no puede ser un Quick Tunnel/i);
});

test('la URL Android se configura fuera del código Kotlin', () => {
  const gradle = fs.readFileSync(path.resolve(root, '../DeUna/app/build.gradle.kts'), 'utf8');
  const kotlin = fs.readFileSync(path.resolve(root, '../DeUna/app/src/main/java/com/deuna/app/data/ApiConfig.kt'), 'utf8');
  assert.match(gradle, /DEUNA_API_BASE_URL/);
  assert.match(gradle, /Configura DEUNA_API_BASE_URL/);
  assert.doesNotMatch(gradle, /between-thereafter-powerful-foreign\.trycloudflare\.com/);
  assert.match(kotlin, /BuildConfig\.DEUNA_API_BASE_URL/);
  assert.doesNotMatch(kotlin, /trycloudflare\.com/);
  assert.match(gradle, /MAPBOX_PUBLIC_TOKEN/);
  assert.match(gradle, /resValue\([\s\S]*?\"mapbox_access_token\"/);
  assert.equal(fs.existsSync(path.resolve(root, '../DeUna/app/src/main/res/values/mapbox_access_token.xml')), false, 'el recurso Mapbox debe generarse desde la configuración local, no usar un token placeholder');
});

test('el panel contiene cola de reembolsos y controles de ciudad', (t) => {
  const candidatos = [path.resolve(root, '../panel/src/App.jsx'), path.resolve(root, '../../../admin/panel/src/App.jsx')];
  const rutaPanel = candidatos.find((p) => fs.existsSync(p));
  if (!rutaPanel) return t.skip('El panel web no venía en los ZIP adjuntos; esta comprobación queda pendiente de recibir ese proyecto.');
  const js = fs.readFileSync(rutaPanel, 'utf8');
  assert.match(js, /reembolsos/);
  assert.match(js, /Ciudades/);
});

test('el cliente no puede cancelar pedido tras aceptación comercial y el conductor suelta asignación sin cancelar compra', () => {
  const pedidos = leer('src/rutas/pedidos.js');
  assert.match(pedidos, /if \(p\.estado !== 'creado'\) \{\s*return \{ e: \[409, 'PEDIDO_NO_CANCELABLE'/);
  assert.match(pedidos, /rutaPedidos\.post\('\/:id\/soltar'/);
});

test('documentos de conductor: carga, aprobación y despacho exigen la misma lista', () => {
  const conductor = leer('src/rutas/conductor.js');
  const admin = leer('src/rutas/admin.js');
  const viajes = leer('src/rutas/viajes.js');
  const pedidos = leer('src/rutas/pedidos.js');
  const tipos = ['ci_frente','ci_reverso','selfie','licencia_frente','licencia_reverso','selfie_licencia','soat','tarjeta_propiedad','foto_placa','foto_moto'];
  for (const tipo of tipos) {
    for (const [nombre, texto] of [['subida',conductor],['admin',admin],['viajes',viajes],['delivery',pedidos]]) {
      assert.ok(texto.includes(tipo), `${tipo} falta en la regla de ${nombre}`);
    }
  }
  assert.doesNotMatch(viajes.match(/const TIPOS_DOCUMENTO_OBLIGATORIOS = \[([\s\S]*?)\];/)?.[1] ?? '', /'licencia'/);
});


test('rutas declaradas por Android existen en las rutas HTTP montadas por la API', () => {
  const apiSrc = path.join(root, 'src');
  const app = leer('src/app.js');
  const nombresArchivo = {
    rutaSalud: 'rutas/salud.js', rutaRegistro: 'rutas/registro.js', rutaOtp: 'rutas/otp.js',
    rutaSesion: 'rutas/sesion.js', rutaCiudades: 'rutas/ciudades.js', rutaPerfil: 'rutas/perfil.js',
    rutaConductor: 'rutas/conductor.js', rutaAdmin: 'rutas/admin.js', rutaViajes: 'rutas/viajes.js',
    rutaComercio: 'rutas/comercio.js', rutaMedia: 'rutas/media.js',
    rutaComerciosPublicos: 'rutas/comerciosPublicos.js', rutaBilletera: 'rutas/billetera.js', rutaPedidos: 'rutas/pedidos.js',
    rutaFeedback: 'rutas/feedback.js', rutaEnvios: 'rutas/envios.js', rutaUbicaciones: 'rutas/ubicaciones.js',
    rutaEntrar: 'rutas/entrar.js', rutaRegistroPin: 'rutas/registroPin.js', rutaCuenta: 'rutas/cuenta.js',
  };
  const montajes = new Map();
  for (const m of app.matchAll(/app\.use\((?:'([^']*)',\s*)?conCaptura\((ruta\w+)\)\)/g)) {
    const [, prefijo, nombre] = m;
    if (nombresArchivo[nombre]) montajes.set(nombresArchivo[nombre], prefijo || '');
  }
  const patronesServidor = new Set();
  const normalizar = (ruta) => ruta.replace(/:\w+/g, '{x}').replace(/\{[^}]+\}/g, '{x}').replace(/\/$/, '') || '/';
  for (const [archivo, prefijo] of montajes) {
    const fuente = fs.readFileSync(path.join(apiSrc, archivo), 'utf8');
    for (const m of fuente.matchAll(/ruta\w+\.(get|post|put|patch|delete)\(\s*(['"])(.*?)\2/gi)) {
      const [, metodo, , ruta] = m;
      const completa = `${prefijo.replace(/\/$/, '')}/${ruta.replace(/^\//, '')}`.replace(/\/{2,}/g, '/');
      patronesServidor.add(`${metodo.toUpperCase()} ${normalizar(completa)}`);
    }
  }
  const contratoAndroid = fs.readFileSync(path.resolve(root, '../DeUna/app/src/main/java/com/deuna/app/data/DeUnaApi.kt'), 'utf8');
  const ausentes = [];
  for (const m of contratoAndroid.matchAll(/@(GET|POST|PUT|PATCH|DELETE|retrofit2\.http\.DELETE)\("([^"]+)"\)/g)) {
    let metodo = m[1].toUpperCase().replace('RETROFIT2.HTTP.DELETE', 'DELETE');
    const ruta = normalizar('/' + m[2].split('?')[0].replace(/^\//, ''));
    if (!patronesServidor.has(`${metodo} ${ruta}`)) ausentes.push(`${metodo} ${ruta}`);
  }
  assert.deepEqual(ausentes, [], `Rutas Android sin endpoint equivalente: ${ausentes.join(', ')}`);
});
