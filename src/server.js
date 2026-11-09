import http from 'node:http';
import { app } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { iniciarTiempoReal } from './tiempoReal.js';
import { expirarPedidosPendientes } from './rutas/pedidos.js';

// Etapa 9: Express y Socket.IO comparten el mismo servidor HTTP y el mismo puerto.
// Sin indicar host, Node escucha en IPv4 e IPv6 a la vez.
// Así funcionan "localhost" (IPv4 o IPv6), el túnel USB de adb, el emulador (10.0.2.2) y el WiFi.
const servidor = http.createServer(app);
iniciarTiempoReal(servidor);

// Limpieza de pedidos que llevan 15 minutos sin aceptación del comercio. La caducidad
// se ejecuta en servidor, aunque ningún cliente tenga la app abierta.
const intervaloCaducidadPedidos = setInterval(() => {
  expirarPedidosPendientes().catch((e) => console.error('[pedidos] error en caducidad automática:', e.message));
}, 30_000);
intervaloCaducidadPedidos.unref?.();
setTimeout(() => {
  expirarPedidosPendientes().catch((e) => console.error('[pedidos] error en caducidad inicial:', e.message));
}, 2_000).unref?.();

servidor.listen(config.puerto, () => {
  console.log(`De Volada API escuchando en el puerto ${config.puerto}  ->  http://localhost:${config.puerto}`);
  console.log(`Archivo .env: ${config.envFileLoaded ? 'cargado' : 'NO encontrado'} (${config.envPath})`);
  console.log(`Rutas Stadia Maps: ${config.stadiaRoutingUrl}`);
  console.log(`Stadia Maps: ${config.stadiaMapsApiKey ? 'clave configurada' : 'clave NO configurada'}`);
  console.log('Tiempo real (Socket.IO): activo');
});

// Railway envía SIGTERM en cada redespliegue: se cierra con orden (sin cortar consultas a medias).
let cerrando = false;
async function apagar(senal) {
  if (cerrando) return;
  cerrando = true;
  console.log(`[De Volada] ${senal} recibido: cerrando...`);
  clearInterval(intervaloCaducidadPedidos);
  const forzar = setTimeout(() => process.exit(1), 10_000);
  forzar.unref?.();
  servidor.close();
  try { await db.end(); } catch { /* ya cerrado */ }
  process.exit(0);
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
