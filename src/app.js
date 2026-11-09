import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { error } from './respuesta.js';
import { rutaSalud } from './rutas/salud.js';
import { rutaRegistro } from './rutas/registro.js';
import { rutaOtp } from './rutas/otp.js';
import { rutaEntrar } from './rutas/entrar.js';
import { rutaRegistroPin } from './rutas/registroPin.js';
import { rutaSesion } from './rutas/sesion.js';
import { rutaCuenta } from './rutas/cuenta.js';
import { rutaCiudades } from './rutas/ciudades.js';
import { rutaPerfil } from './rutas/perfil.js';
import { rutaConductor } from './rutas/conductor.js';
import { rutaAdmin } from './rutas/admin.js';
import { rutaViajes } from './rutas/viajes.js';
import { rutaComercio } from './rutas/comercio.js';
import { rutaMedia } from './rutas/media.js';
import { rutaComerciosPublicos } from './rutas/comerciosPublicos.js';
import { rutaBilletera } from './rutas/billetera.js';
import { rutaPedidos } from './rutas/pedidos.js';
import { rutaFeedback } from './rutas/feedback.js';
import { rutaEnvios } from './rutas/envios.js';
import { rutaUbicaciones } from './rutas/ubicaciones.js';

// Express 4 no captura errores de funciones async; este envoltorio los pasa al manejador global.
function conCaptura(router) {
  for (const capa of router.stack) {
    if (!capa.route) continue;
    for (const sub of capa.route.stack) {
      const original = sub.handle;
      sub.handle = (req, res, next) => Promise.resolve(original(req, res, next)).catch(next);
    }
  }
  return router;
}

export const app = express();
app.disable('x-powered-by');
// Detrás de Cloudflare + DigitalOcean (o del túnel local), confiar en X-Forwarded-For para obtener la IP real.
// Configurable con TRUST_PROXY; por defecto solo loopback.
app.set('trust proxy', config.trustProxy);
app.use(helmet());
// CORS acotado para el panel React. En producción configura ADMIN_WEB_ORIGIN
// con el origen HTTPS exacto del panel; no se habilita '*' con Authorization.
app.use((req, res, next) => {
  const origen = req.get('origin');
  const desarrolloPermitido = config.debug && /^http:\/\/(localhost|127\.0\.0\.1):(5173|4173)$/.test(origen ?? '');
  if (origen && (origen === config.adminWebOrigin || desarrolloPermitido)) {
    res.setHeader('Access-Control-Allow-Origin', origen);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(express.json({ limit: '20kb' }));

// Límites por IP (en redes móviles muchos usuarios comparten IP: revisar antes del lanzamiento)
const limite = (windowMs, max) => rateLimit({
  windowMs,
  limit: max,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => error(res, 429, 'DEMASIADAS_PETICIONES', 'Demasiadas solicitudes. Intenta de nuevo en un momento.'),
});
app.use(limite(60_000, 120));                 // general: 120 por minuto
app.use('/otp', limite(60_000, 20));          // 20 por minuto
app.use('/registro', limite(3_600_000, 30));  // 30 por hora
app.use('/registro-pin', limite(3_600_000, 30)); // 30 por hora
app.use('/entrar', limite(60_000, 20));       // 20 por minuto (además: 5 PIN fallidos/hora por teléfono)
app.use('/ubicaciones', limite(60_000, 30)); // autocompletado con pausa en Android: máximo 30/min por IP

app.use('/salud', conCaptura(rutaSalud));
app.use('/ubicaciones', conCaptura(rutaUbicaciones));
app.use('/api/health', conCaptura(rutaSalud)); // alias de salud para diagnóstico
app.use('/registro', conCaptura(rutaRegistro));
app.use('/registro-pin', conCaptura(rutaRegistroPin)); // registro sin OTP: define PIN, cuenta pendiente
app.use('/entrar', conCaptura(rutaEntrar));            // login principal: teléfono + PIN
app.use('/otp', conCaptura(rutaOtp));                  // OTP: se conserva para uso futuro, la app ya no lo usa
app.use(conCaptura(rutaSesion)); // /yo y /sesion/cerrar
app.use('/cuenta', limite(3_600_000, 10), conCaptura(rutaCuenta)); // DELETE /cuenta: eliminación de cuenta (Google Play)
app.use('/ciudades', conCaptura(rutaCiudades));
app.use(conCaptura(rutaPerfil)); // PUT /perfil
app.use('/conductor', conCaptura(rutaConductor));
app.use('/admin', conCaptura(rutaAdmin));
app.use('/viajes', conCaptura(rutaViajes));
app.use('/comercio', conCaptura(rutaComercio));
app.use('/media', conCaptura(rutaMedia)); // solo logos e imágenes públicas de comercios
app.use('/comercios', conCaptura(rutaComerciosPublicos)); // directorio público: solo comercios aprobados
app.use('/billetera', conCaptura(rutaBilletera)); // saldo prepago exclusivo de comisiones para conductores y comercios
app.use('/pedidos', conCaptura(rutaPedidos)); // pedidos de comercio, asignación de delivery y cobros directos al receptor
app.use(conCaptura(rutaFeedback)); // rutas con prefijos /calificaciones y /soporte ya declarados en el router
app.use('/envios', conCaptura(rutaEnvios));

// Ruta inexistente
app.use((_req, res) => error(res, 404, 'NO_ENCONTRADO', 'La ruta solicitada no existe.'));

// Manejador global de errores
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return error(res, 400, 'JSON_INVALIDO', 'El cuerpo de la solicitud debe ser JSON válido.');
  }
  if (err.type === 'entity.too.large') {
    return error(res, 413, 'CUERPO_MUY_GRANDE', 'La solicitud es demasiado grande.');
  }
  console.error('[De Volada]', err);
  const detalles = config.debug ? { debug: err.message } : undefined;
  return error(res, 500, 'ERROR_INTERNO', 'Ocurrió un error en el servidor.', detalles);
});
