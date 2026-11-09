import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { firmarSigV4, crearClienteSpaces } from '../src/servicios/spaces.js';
import { config, erroresAlmacenamiento } from '../src/config.js';
import {
  guardarDocumento, leerDocumento, borrarDocumento,
  guardarImagenComercio, leerImagenComercio, borrarImagenComercio,
  inyectarClienteAlmacenamiento, detectarImagen,
} from '../src/servicios/almacenamiento.js';

const CLAVE = 'AKIAIOSFODNN7EXAMPLE';
const SECRETO = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 9)]);

// ---------- 1) Firma SigV4: ejemplos oficiales de la documentación de AWS S3 ----------
test('SigV4 coincide con el ejemplo oficial de AWS (GET con Range)', () => {
  const r = firmarSigV4({
    metodo: 'GET', ruta: '/test.txt',
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
    hashCuerpo: sha(''), region: 'us-east-1', claveAcceso: CLAVE, secreto: SECRETO,
    fecha: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(r.firma, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(r.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
});

test('SigV4 coincide con el ejemplo oficial de AWS (PUT con $ en la ruta)', () => {
  const cuerpo = 'Welcome to Amazon S3.';
  const r = firmarSigV4({
    metodo: 'PUT', ruta: '/test%24file.text',
    headers: { host: 'examplebucket.s3.amazonaws.com', date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    hashCuerpo: sha(cuerpo), region: 'us-east-1', claveAcceso: CLAVE, secreto: SECRETO,
    fecha: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(r.firma, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

// ---------- 2) Cliente contra un "Spaces" simulado que VERIFICA la firma recibida ----------
function spacesSimulado() {
  const objetos = new Map();
  const llamadas = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const cuerpo = init.body ? Buffer.from(init.body) : Buffer.alloc(0);
    llamadas.push({ metodo: init.method, host: u.host, ruta: u.pathname });
    // El servidor recalcula la firma con lo que REALMENTE recibió.
    assert.equal(h['x-amz-content-sha256'], sha(cuerpo), 'el hash declarado debe ser el del cuerpo enviado');
    const firmados = { host: u.host };
    if (h['content-type']) firmados['content-type'] = h['content-type'];
    const esperado = firmarSigV4({
      metodo: init.method, ruta: u.pathname, headers: firmados, hashCuerpo: h['x-amz-content-sha256'],
      region: 'nyc3', claveAcceso: 'CLAVE_DO', secreto: 'SECRETO_DO',
      fecha: new Date(Date.UTC(2026, 10, 7, 12, 0, 0)),
    });
    if (h.authorization !== esperado.authorization) return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
    const clave = decodeURIComponent(u.pathname.slice(1));
    if (init.method === 'PUT') { objetos.set(clave, cuerpo); return new Response(null, { status: 200 }); }
    if (init.method === 'GET') return objetos.has(clave) ? new Response(objetos.get(clave), { status: 200 }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    if (init.method === 'DELETE') { objetos.delete(clave); return new Response(null, { status: 204 }); }
    return new Response('', { status: 405 });
  };
  return { objetos, llamadas, fetchImpl };
}
const CFG = { endpoint: 'https://nyc3.digitaloceanspaces.com', region: 'nyc3', bucket: 'devolada-archivos', key: 'CLAVE_DO', secret: 'SECRETO_DO' };
const AHORA = () => new Date(Date.UTC(2026, 10, 7, 12, 0, 0));

test('cliente Spaces: subir, descargar y borrar con firma válida y host estilo virtual-host', async () => {
  const sim = spacesSimulado();
  const c = crearClienteSpaces(CFG, { fetchImpl: sim.fetchImpl, ahora: AHORA });
  await c.subir('documentos/a.jpg', JPG, 'image/jpeg');
  assert.deepEqual(await c.descargar('documentos/a.jpg'), JPG);
  await c.borrar('documentos/a.jpg');
  await assert.rejects(() => c.descargar('documentos/a.jpg'), (e) => e.code === 'ENOENT' && e.status === 404);
  assert.ok(sim.llamadas.every((l) => l.host === 'devolada-archivos.nyc3.digitaloceanspaces.com'));
});

test('cliente Spaces: una firma incorrecta (credenciales malas) falla con el código del servidor', async () => {
  const sim = spacesSimulado();
  const c = crearClienteSpaces({ ...CFG, secret: 'OTRO' }, { fetchImpl: sim.fetchImpl, ahora: AHORA });
  await assert.rejects(() => c.subir('x/a.jpg', JPG, 'image/jpeg'), /403 SignatureDoesNotMatch/);
});

test('cliente Spaces: borrar un objeto inexistente no es error', async () => {
  const sim = spacesSimulado();
  const c = crearClienteSpaces(CFG, { fetchImpl: sim.fetchImpl, ahora: AHORA });
  await c.borrar('documentos/no-existe.jpg');
});

// ---------- 3) almacenamiento.js en modo s3 (cliente simulado) ----------
test('modo s3: documentos e imágenes de comercio van a prefijos distintos y se leen de vuelta', async () => {
  const sim = spacesSimulado();
  inyectarClienteAlmacenamiento(crearClienteSpaces(CFG, { fetchImpl: sim.fetchImpl, ahora: AHORA }));
  const antes = config.almacenamiento.driver; config.almacenamiento.driver = 's3';
  try {
    const doc = await guardarDocumento(JPG, 'jpg');
    const img = await guardarImagenComercio(PNG, 'png');
    assert.match(doc, /^[a-f0-9]{32}\.jpg$/); assert.match(img, /^[a-f0-9]{32}\.png$/);
    assert.deepEqual([...sim.objetos.keys()].sort(), [`comercios/${img}`, `documentos/${doc}`].sort());
    const d = await leerDocumento(doc); assert.deepEqual(d.buffer, JPG); assert.equal(d.mime, 'image/jpeg');
    const i = await leerImagenComercio(img); assert.deepEqual(i.buffer, PNG); assert.equal(i.mime, 'image/png');
    // Un documento privado NO se puede leer como imagen pública (espacios separados)
    await assert.rejects(() => leerImagenComercio(doc));
    await borrarDocumento(doc); await borrarImagenComercio(img);
    assert.equal(sim.objetos.size, 0);
  } finally { config.almacenamiento.driver = antes; inyectarClienteAlmacenamiento(null); }
});

test('modo s3: rechaza nombres que no sean los generados (sin path traversal) y borrar nunca lanza', async () => {
  const sim = spacesSimulado();
  inyectarClienteAlmacenamiento(crearClienteSpaces(CFG, { fetchImpl: sim.fetchImpl, ahora: AHORA }));
  const antes = config.almacenamiento.driver; config.almacenamiento.driver = 's3';
  try {
    for (const malo of ['../documentos/a.jpg', 'a.jpg', `${'a'.repeat(32)}.exe`, `${'a'.repeat(32)}.jpg/../x`, '']) {
      await assert.rejects(() => leerDocumento(malo), /inválido/);
      await borrarDocumento(malo); // no lanza
    }
    assert.equal(sim.llamadas.length, 0, 'un nombre inválido no debe llegar a Spaces');
    inyectarClienteAlmacenamiento({ subir: async () => { throw new Error('x'); }, descargar: async () => { throw new Error('x'); }, borrar: async () => { throw new Error('caído'); } });
    await borrarDocumento(`${'b'.repeat(32)}.png`); // error de red al borrar: se registra, no se propaga
  } finally { config.almacenamiento.driver = antes; inyectarClienteAlmacenamiento(null); }
});

// ---------- 4) almacenamiento.js en modo disco ----------
test('modo disco: guarda, lee y borra en las carpetas configuradas, con permisos restringidos para documentos', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dv-alm-'));
  const prev = { d: config.carpetaDocumentos, c: config.carpetaImagenesComercio, drv: config.almacenamiento.driver };
  config.carpetaDocumentos = path.join(base, 'priv', 'docs'); config.carpetaImagenesComercio = path.join(base, 'pub', 'com');
  config.almacenamiento.driver = 'disco';
  try {
    const doc = await guardarDocumento(JPG, 'jpg');
    const img = await guardarImagenComercio(PNG, 'png');
    assert.ok((await fs.stat(path.join(config.carpetaDocumentos, doc))).isFile());
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(config.carpetaDocumentos, doc))).mode & 0o777, 0o600);
    assert.deepEqual((await leerDocumento(doc)).buffer, JPG);
    assert.deepEqual((await leerImagenComercio(img)).buffer, PNG);
    await assert.rejects(() => leerImagenComercio(doc)); // el documento no está en la carpeta pública
    await borrarDocumento(doc); await borrarImagenComercio(img); await borrarImagenComercio(img); // 2.º borrado: sin error
    assert.deepEqual(await fs.readdir(config.carpetaDocumentos), []);
  } finally {
    config.carpetaDocumentos = prev.d; config.carpetaImagenesComercio = prev.c; config.almacenamiento.driver = prev.drv;
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('detectarImagen sigue reconociendo por bytes reales', () => {
  assert.equal(detectarImagen(JPG).ext, 'jpg'); assert.equal(detectarImagen(PNG).ext, 'png');
  assert.equal(detectarImagen(Buffer.from('<?php echo 1; ?>........')), null);
});

// ---------- 5) Validación de configuración ----------
test('erroresAlmacenamiento valida el driver y las variables de Spaces', () => {
  const con = (driver, spaces) => ({ almacenamiento: { driver, spaces } });
  assert.deepEqual(erroresAlmacenamiento(con('disco', {})), []);
  assert.equal(erroresAlmacenamiento(con('nube', {})).length, 1);
  const vacio = erroresAlmacenamiento(con('s3', { endpoint: '', region: '', bucket: '', key: '', secret: '' }));
  assert.ok(vacio.length >= 4);
  assert.deepEqual(erroresAlmacenamiento(con('s3', { ...CFG })), []);
});

test('erroresAlmacenamiento detecta endpoints mal copiados del panel de DigitalOcean', () => {
  const malos = [
    'https://nyc3.digitaloceanspaces.com/',                     // barra final
    'https://nyc3.digitaloceanspaces.com/devolada-archivos',    // con el bucket en la ruta
    'nyc3.digitaloceanspaces.com',                              // sin https://
    'http://nyc3.digitaloceanspaces.com',                       // sin cifrado
  ];
  for (const endpoint of malos) {
    const e = erroresAlmacenamiento({ almacenamiento: { driver: 's3', spaces: { ...CFG, endpoint } } });
    assert.equal(e.length, 1, `debería rechazar: ${endpoint}`);
  }
});
