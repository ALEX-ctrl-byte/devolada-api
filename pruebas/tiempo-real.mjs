// Prueba de integración de la Etapa 9. Levanta la API real contra una base TEMPORAL
// (deuna_prueba_tiempo_real, ver esquema-prueba.sql) y simula pasajero, conductores y un intruso.
//   uso: npm run probar:tiempo-real        (necesita MySQL/MariaDB encendido y las credenciales de .env)
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { io as cliente } from 'socket.io-client';

dotenv.config();
const PUERTO = 3917;
const BASE = `http://127.0.0.1:${PUERTO}`;
const OTP_SECRET = 'secreto-de-prueba';
const BD = 'deuna_prueba_tiempo_real';
const cred = { host: process.env.DB_HOST ?? '127.0.0.1', port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '' };

let fallos = 0;
const comprobar = (nombre, ok, detalle = '') => { console.log(`${ok ? 'OK   ' : 'FALLO'} ${nombre}${!ok && detalle ? '  -> ' + detalle : ''}`); if (!ok) fallos++; };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ---- Base de datos temporal ----
const admin = await mysql.createConnection({ ...cred, multipleStatements: true });
await admin.query(fs.readFileSync(new URL('./esquema-prueba.sql', import.meta.url), 'utf8'));
await admin.changeUser({ database: BD });
const q = async (sql, p = []) => (await admin.execute(sql, p))[0];

const tokens = {};
async function crearUsuario(clave, rol, tel) {
  const r = await q('INSERT INTO usuarios (telefono, nombre, rol) VALUES (?,?,?)', [tel, clave, rol]);
  const token = crypto.randomBytes(32).toString('base64url');
  const s = await q("INSERT INTO sesiones (usuario_id, token_hash, expira_en) VALUES (?,?, UTC_TIMESTAMP() + INTERVAL 1 DAY)", [r.insertId, sha(token)]);
  tokens[clave] = token;
  return { id: r.insertId, sesionId: s.insertId, token };
}
async function crearConductor(clave, tel) {
  const u = await crearUsuario(clave, 'conductor', tel);
  const c = await q("INSERT INTO conductores (usuario_id, estado_aprobacion, estado_operativo, licencia_vence_en) VALUES (?, 'aprobado', 'disponible', DATE_ADD(CURDATE(), INTERVAL 1 YEAR))", [u.id]);
  await q("INSERT INTO motos (conductor_id, placa, marca, modelo) VALUES (?, 'ABC123', 'Honda', 'CG')", [c.insertId]);
  await q("INSERT INTO billeteras (conductor_id, saldo_prepago) VALUES (?, 100)", [c.insertId]);
  for (const t of ['ci_frente', 'ci_reverso', 'licencia', 'selfie', 'soat', 'tarjeta_propiedad', 'foto_moto'])
    await q("INSERT INTO documentos_conductor (conductor_id, tipo, estado) VALUES (?,?, 'aprobado')", [c.insertId, t]);
  return { ...u, conductorId: c.insertId };
}
const pasajero = await crearUsuario('pasajero', 'pasajero', '70000001');
const intruso = await crearUsuario('intruso', 'pasajero', '70000002');
const cond1 = await crearConductor('cond1', '70000011');   // cerca del origen
const cond2 = await crearConductor('cond2', '70000012');   // también cerca (verá la oferta y luego se cierra)
const lejano = await crearConductor('lejano', '70000013'); // a ~20 km: no debe enterarse

// ---- API real ----
const api = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PUERTO), NODE_ENV: 'development', OTP_SECRET, DB_NAME: BD, DB_HOST: cred.host, DB_PORT: String(cred.port), DB_USER: cred.user, DB_PASSWORD: cred.password },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
api.stdout.on('data', (d) => (log += d)); api.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 50 && !log.includes('Tiempo real'); i++) await esperar(100);
if (!log.includes('Tiempo real')) { console.error('La API no arrancó:\n' + log); process.exit(1); }

const llamar = async (clave, metodo, ruta, cuerpo) => {
  const r = await fetch(BASE + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[clave]}` }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, ...j };
};
const ORIGEN = { lat: -16.5000, lng: -68.1500 };
const DESTINO = { lat: -16.5100, lng: -68.1200 };
const cotizacion = (usuarioId) => {
  const datos = { v: 1, usuario_id: usuarioId, origen: ORIGEN, destino: DESTINO, distancia_m: 3400, duracion_estimada_s: 600,
    tarifa_estimada: 6.8, comision_porcentaje: 10, expira_en: Math.floor(Date.now() / 1000) + 120 };
  const parte = Buffer.from(JSON.stringify(datos)).toString('base64url');
  return `${parte}.${crypto.createHmac('sha256', OTP_SECRET).update(parte).digest('hex')}`;
};
const posicion = (clave, lat, lng, extra = {}) => llamar(clave, 'POST', '/viajes/ubicacion-conductor', { latitud: lat, longitud: lng, precision_m: 5, ...extra });

// ---- Sockets ----
function conectar(clave, token = tokens[clave]) {
  const eventos = [];
  const s = cliente(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
  for (const e of ['oferta:nueva', 'oferta:cerrada', 'viaje:estado', 'viaje:ubicacion', 'listo']) s.on(e, (d) => eventos.push({ e, d }));
  s.eventos = eventos;
  s.cuenta = (nombre, filtro = () => true) => eventos.filter((x) => x.e === nombre && filtro(x.d)).length;
  return new Promise((res) => { s.on('connect', () => res(s)); s.on('connect_error', (err) => { s.error = err.message; res(s); }); });
}

try {
  // 1) Autenticación
  const sinToken = await conectar('x', 'no-es-un-token-valido-de-sesion');
  comprobar('un token falso NO puede conectarse', !sinToken.connected && sinToken.error === 'SESION_INVALIDA', sinToken.error);
  const sPas = await conectar('pasajero'); const sInt = await conectar('intruso');
  const sC1 = await conectar('cond1'); const sC2 = await conectar('cond2'); const sLej = await conectar('lejano');
  comprobar('pasajero y conductores se conectan con su token de sesión', [sPas, sC1, sC2, sLej, sInt].every((s) => s.connected));

  // 2) Conductores publican su posición; el lejano está a ~20 km
  await posicion('cond1', -16.5010, -68.1505);
  await posicion('cond2', -16.5020, -68.1510);
  await posicion('lejano', -16.3200, -68.1500);

  // 3) El pasajero pide el viaje -> conductores cercanos reciben el aviso al instante
  const crear = await llamar('pasajero', 'POST', '/viajes', { cotizacion_token: cotizacion(pasajero.id), idempotency_key: 'prueba-viaje-0001', metodo_pago: 'efectivo' });
  comprobar('el pasajero crea el viaje', crear.http === 201, JSON.stringify(crear));
  const viajeId = crear.datos?.viaje?.id;
  await esperar(500);
  comprobar('conductor cercano 1 recibe "oferta:nueva"', sC1.cuenta('oferta:nueva', (d) => d.viaje_id === viajeId) === 1);
  comprobar('conductor cercano 2 recibe "oferta:nueva"', sC2.cuenta('oferta:nueva', (d) => d.viaje_id === viajeId) === 1);
  comprobar('conductor a 20 km NO recibe la oferta', sLej.cuenta('oferta:nueva') === 0);
  comprobar('el intruso NO recibe la oferta', sInt.cuenta('oferta:nueva') === 0);

  // 4) El conductor 1 acepta -> pasajero se entera; conductor 2 ve cerrarse la oferta
  const acepta = await llamar('cond1', 'POST', `/viajes/${viajeId}/aceptar`);
  comprobar('el conductor 1 acepta el viaje', acepta.http === 200, JSON.stringify(acepta));
  await esperar(500);
  comprobar('el pasajero recibe "viaje:estado" = aceptado', sPas.cuenta('viaje:estado', (d) => d.estado === 'aceptado') === 1);
  comprobar('el conductor 2 recibe "oferta:cerrada"', sC2.cuenta('oferta:cerrada', (d) => d.viaje_id === viajeId) === 1);
  comprobar('el intruso NO recibe estados del viaje ajeno', sInt.cuenta('viaje:estado') === 0);

  // 5) Posición en vivo (sin enviar el id del viaje: el servidor lo deduce)
  const p1 = await posicion('cond1', -16.5008, -68.1502);
  comprobar('POST /viajes/ubicacion-conductor devuelve el viaje activo', p1.datos?.viaje_id === viajeId, JSON.stringify(p1));
  await esperar(400);
  const ubi = sPas.eventos.filter((x) => x.e === 'viaje:ubicacion');
  comprobar('el pasajero recibe la posición del conductor en vivo', ubi.length === 1 && Math.abs(ubi[0].d.lat - -16.5008) < 1e-6, JSON.stringify(ubi));
  const guardadas = (await q('SELECT COUNT(*) AS n FROM ubicaciones_viaje WHERE viaje_id=?', [viajeId]))[0].n;
  comprobar('la posición queda guardada en el recorrido (ubicaciones_viaje)', Number(guardadas) === 1);
  await posicion('cond1', -16.5007, -68.1501, { es_mock: true });
  await esperar(300);
  comprobar('una ubicación SIMULADA (es_mock) no se envía al pasajero', sPas.cuenta('viaje:ubicacion') === 1);
  comprobar('el intruso NO recibe la posición del conductor', sInt.cuenta('viaje:ubicacion') === 0);
  const unirse = await new Promise((r) => sInt.emit('viaje:unirse', viajeId, r));
  comprobar('el intruso no puede unirse a la sala del viaje', unirse?.ok === false, JSON.stringify(unirse));
  await posicion('cond1', -16.5006, -68.1500);
  await esperar(300);
  comprobar('...y tampoco recibe nada después de intentarlo', sInt.cuenta('viaje:ubicacion') === 0);

  // 6) Reconexión del pasajero a mitad del viaje: vuelve solo a su sala
  sPas.disconnect(); await esperar(200);
  const sPas2 = await conectar('pasajero');
  await posicion('cond1', -16.5005, -68.1500);
  await esperar(300);
  comprobar('tras reconectarse, el pasajero sigue recibiendo la posición', sPas2.cuenta('viaje:ubicacion') >= 1);

  // 7) Ciclo: llegada -> casco -> iniciar -> finalizar, cada paso llega al pasajero
  comprobar('llegada', (await llamar('cond1', 'POST', `/viajes/${viajeId}/llegada`)).http === 200);
  comprobar('confirmar casco', (await llamar('pasajero', 'POST', `/viajes/${viajeId}/confirmar-casco`)).http === 200);
  comprobar('iniciar', (await llamar('cond1', 'POST', `/viajes/${viajeId}/iniciar`)).http === 200);
  await posicion('cond1', DESTINO.lat, DESTINO.lng);
  const fin = await llamar('cond1', 'POST', `/viajes/${viajeId}/finalizar`);
  comprobar('finalizar', fin.http === 200, JSON.stringify(fin));
  await esperar(500);
  const estados = sPas2.eventos.filter((x) => x.e === 'viaje:estado').map((x) => x.d.estado);
  comprobar(`el pasajero vio los estados en vivo: ${estados.join(' > ')}`, ['conductor_llego', 'en_curso', 'finalizado'].every((e) => estados.includes(e)));
  const antes = sPas2.cuenta('viaje:ubicacion');
  await posicion('cond1', -16.5101, -68.1201); await esperar(300);
  comprobar('terminado el viaje, ya no se comparte la posición', sPas2.cuenta('viaje:ubicacion') === antes);

  // 8) Cancelación: el pasajero cancela y los conductores cercanos ven cerrarse la oferta
  await posicion('cond1', -16.5010, -68.1505); await posicion('cond2', -16.5020, -68.1510);
  const crear2 = await llamar('pasajero', 'POST', '/viajes', { cotizacion_token: cotizacion(pasajero.id), idempotency_key: 'prueba-viaje-0002', metodo_pago: 'efectivo' });
  const v2 = crear2.datos?.viaje?.id; await esperar(400);
  const c2antes = sC2.cuenta('oferta:cerrada');
  await llamar('pasajero', 'POST', `/viajes/${v2}/cancelar`, {}); await esperar(400);
  comprobar('al cancelar una solicitud, el conductor cercano recibe "oferta:cerrada"', sC2.cuenta('oferta:cerrada') === c2antes + 1);

  // 9) Cierre de sesión corta el socket
  await llamar('pasajero', 'POST', '/sesion/cerrar'); await esperar(400);
  comprobar('al cerrar sesión se corta la conexión en vivo', !sPas2.connected);
} catch (e) {
  console.error('Error en la prueba:', e); fallos++;
} finally {
  api.kill(); await admin.query(`DROP DATABASE IF EXISTS ${BD}`); await admin.end();
  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) con FALLO`);
  process.exit(fallos === 0 ? 0 : 1);
}
