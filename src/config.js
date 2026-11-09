import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Carga .env desde la raíz de esta API (un nivel arriba de src), no desde process.cwd().
// Esto evita leer el archivo equivocado si Node se inicia desde otra carpeta.
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
const envResult = dotenv.config({ path: envPath });
const envFileLoaded = !envResult.error;

const nodeEnv = process.env.NODE_ENV ?? 'development';

// Railway (o DigitalOcean) entrega la conexión como URL: mysql://usuario:clave@host:puerto/base
// Orden de prioridad: DATABASE_URL > MYSQL_URL (variable nativa de Railway) > variables sueltas
// (DB_HOST... o las MYSQLHOST... que también define Railway) > valores locales de Laragon.
// En Railway basta con DATABASE_URL=${{MySQL.MYSQL_URL}} (red privada, sin TLS).
const enRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);

function configBaseDatos() {
  const base = {
    host: process.env.DB_HOST ?? process.env.MYSQLHOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? process.env.MYSQLPORT ?? 3306),
    database: process.env.DB_NAME ?? process.env.MYSQLDATABASE ?? 'devolada',
    user: process.env.DB_USER ?? process.env.MYSQLUSER ?? 'root',
    password: process.env.DB_PASSWORD ?? process.env.MYSQLPASSWORD ?? '',
  };
  let sslRequerido = /^(1|true|required)$/i.test(process.env.DB_SSL ?? '');
  const url = (process.env.DATABASE_URL || process.env.MYSQL_URL || '').trim();
  if (url) {
    const u = new URL(url);
    base.host = u.hostname;
    base.port = Number(u.port || 3306);
    base.database = decodeURIComponent(u.pathname.replace(/^\//, '')) || base.database;
    base.user = decodeURIComponent(u.username);
    base.password = decodeURIComponent(u.password);
    const modo = (u.searchParams.get('ssl-mode') ?? u.searchParams.get('sslmode') ?? '').toLowerCase();
    if (modo && modo !== 'disabled') sslRequerido = true;
  }
  if (sslRequerido) {
    // DO Managed MySQL exige TLS. Si se entrega el certificado CA (DB_CA_CERT), se verifica el servidor.
    const ca = (process.env.DB_CA_CERT ?? '').replace(/\\n/g, '\n').trim();
    base.ssl = ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
  }
  return base;
}

// Valor de 'trust proxy' de Express. Detrás de Cloudflare + balanceador de DigitalOcean usa TRUST_PROXY=true.
function valorTrustProxy(v) {
  if (v == null || v === '') return 'loopback';
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}
const debug = nodeEnv !== 'production';
const volumenRailway = (process.env.RAILWAY_VOLUME_MOUNT_PATH ?? '').trim();

export const config = {
  puerto: Number(process.env.PORT ?? 3000),
  debug,
  nodeEnv,
  adminWebOrigin: process.env.ADMIN_WEB_ORIGIN ?? 'http://localhost:5173',
  db: configBaseDatos(),
  trustProxy: valorTrustProxy(process.env.TRUST_PROXY),
  // Orígenes web permitidos para Socket.IO (además del panel). Lista separada por comas.
  corsOrigins: (process.env.CORS_ORIGIN ?? process.env.FRONTEND_URL ?? '').split(',').map((x) => x.trim()).filter(Boolean),
  // Clave secreta para firmar (HMAC) los códigos OTP antes de guardarlos.
  otpSecret: process.env.OTP_SECRET ?? 'clave-solo-para-desarrollo',
  // 'consola' = el código se imprime en la terminal de la API (solo desarrollo).
  otpProveedor: process.env.OTP_PROVEEDOR ?? 'consola',
  // WhatsApp Cloud API: usar solo con plantilla de autenticación/OTP aprobada por Meta.
  whatsappToken: (process.env.WHATSAPP_TOKEN ?? '').trim(),
  whatsappPhoneNumberId: (process.env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim(),
  whatsappTemplate: (process.env.WHATSAPP_OTP_TEMPLATE ?? '').trim(),
  whatsappLanguage: process.env.WHATSAPP_OTP_LANGUAGE ?? 'es',
  whatsappGraphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? 'v22.0',
  // Stadia Maps: la misma clave sirve para geocodificación y rutas; solo se usa en el backend.
  stadiaMapsApiKey: (process.env.STADIA_MAPS_API_KEY ?? '').trim(),
  stadiaRoutingUrl: (process.env.STADIA_ROUTING_URL ?? 'https://api.stadiamaps.com/route/v1').trim().replace(/\/$/, ''),
  // OSRM: cálculo de rutas por calles (viajes, pedidos y envíos). Por defecto el servidor público de OSRM.
  osrmBaseUrl: (process.env.OSRM_BASE_URL ?? 'https://router.project-osrm.org').trim().replace(/\/$/, ''),
  // Número de WhatsApp del administrador que recibe las solicitudes de activación (solo dígitos, sin + ni espacios).
  whatsappBusinessNumber: String(process.env.WHATSAPP_BUSINESS_NUMBER ?? '').replace(/\D/g, ''),
  // Puntos fijos que se descuentan por cada viaje, pedido o envío completado (no es porcentaje ni dinero).
  puntosPorViaje: Number(process.env.PUNTOS_POR_VIAJE ?? 2),
  envPath,
  envFileLoaded,
  // Versión vigente de los Términos y la Política de Privacidad (se guarda al aceptar)
  versionTerminos: process.env.VERSION_TERMINOS ?? '1.0',
  // Carpeta PRIVADA de documentos de conductores. Debe estar fuera de src y de cualquier ruta pública.
  // En Railway, si hay un volumen montado, se usa por defecto (así los archivos sobreviven a cada despliegue).
  carpetaDocumentos: path.resolve(process.env.DOCUMENTOS_DIR ?? (volumenRailway ? path.join(volumenRailway, 'documentos') : '../almacen-privado/documentos')),
  // Imágenes comerciales son públicas (logo/catálogo); no guardar aquí documentos privados de conductores.
  carpetaImagenesComercio: path.resolve(process.env.COMERCIO_IMAGES_DIR ?? (volumenRailway ? path.join(volumenRailway, 'comercios') : '../almacen-publico/comercios')),
  // Almacenamiento de archivos: 'disco' (desarrollo, o Railway con un Volume) o 's3' (DigitalOcean Spaces u otro S3 compatible).
  // Sin Volume el disco de Railway se borra en cada despliegue: usa un Volume o ALMACENAMIENTO_DRIVER=s3.
  almacenamiento: {
    driver: (process.env.ALMACENAMIENTO_DRIVER ?? 'disco').trim().toLowerCase(),
    spaces: {
      endpoint: (process.env.SPACES_ENDPOINT ?? '').trim().replace(/\/$/, ''),
      region: (process.env.SPACES_REGION ?? '').trim(),
      bucket: (process.env.SPACES_BUCKET ?? '').trim(),
      key: (process.env.SPACES_KEY ?? '').trim(),
      secret: (process.env.SPACES_SECRET ?? '').trim(),
    },
  },
  // En Railway, si no se define PUBLIC_API_URL se usa el dominio público que Railway genera para el servicio.
  urlPublicaApi: (process.env.PUBLIC_API_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).trim().replace(/\/$/, ''),
  // URL pública de la imagen del QR/cuenta receptora de De Volada para recargas de comisiones.
  qrRecargaDeunaUrl: (process.env.QR_RECARGA_DEUNA_URL ?? '').trim(),
};

/** Valida elementos que no pueden quedar en valores de demostración al publicar. */
export function erroresConfiguracionProduccion(c = config) {
  if (c.nodeEnv !== 'production') return [];
  const errores = [];
  if (!process.env.OTP_SECRET || String(process.env.OTP_SECRET).length < 32 || /cambia-esto|clave-solo/i.test(String(process.env.OTP_SECRET))) {
    errores.push('OTP_SECRET debe ser una clave aleatoria de al menos 32 caracteres.');
  }
  // El login normal es teléfono + PIN; el OTP es opcional. En producción: 'desactivado' (sin costo) o 'whatsapp'.
  if (!['whatsapp', 'desactivado'].includes(c.otpProveedor)) errores.push('OTP_PROVEEDOR debe ser whatsapp en producción; consola solo sirve para desarrollo (usa desactivado si no envías OTP).');
  if (c.otpProveedor === 'whatsapp' && (!c.whatsappToken || !c.whatsappPhoneNumberId || !c.whatsappTemplate)) errores.push('Configura WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID y WHATSAPP_OTP_TEMPLATE.');
  if (!/^https:\/\//i.test(c.stadiaRoutingUrl)) errores.push('STADIA_ROUTING_URL debe ser una URL HTTPS de la API de rutas de Stadia Maps.');
  if (!/^https?:\/\//i.test(c.osrmBaseUrl)) errores.push('OSRM_BASE_URL debe ser una URL http(s) válida del servidor OSRM.');
  if (!c.stadiaMapsApiKey) errores.push('STADIA_MAPS_API_KEY es obligatorio para geocodificación y cálculo de rutas en producción.');
  if (!/^https:\/\//i.test(c.urlPublicaApi)) errores.push('PUBLIC_API_URL debe ser la URL HTTPS pública de la API, sin barra final.');
  if (/\.trycloudflare\.com\/?$/i.test(c.urlPublicaApi)) errores.push('PUBLIC_API_URL no puede ser un Quick Tunnel de prueba; configura un dominio estable para producción.');
  if (!/^https:\/\//i.test(c.adminWebOrigin)) errores.push('ADMIN_WEB_ORIGIN debe ser el origen HTTPS del panel de administración.');
  if (/\.trycloudflare\.com\/?$/i.test(c.adminWebOrigin)) errores.push('ADMIN_WEB_ORIGIN no puede ser un Quick Tunnel de prueba en producción.');
  // Railway solo ofrece el usuario root, pero dentro de su red privada y aislado en su propio proyecto: se admite.
  // Fuera de Railway se exige un usuario dedicado (o ALLOW_DB_ROOT=true para aceptarlo conscientemente).
  if (!c.db.user) errores.push('El usuario de MySQL no está definido (DATABASE_URL o DB_USER).');
  else if (c.db.user.toLowerCase() === 'root' && !enRailway && !/^true$/i.test(process.env.ALLOW_DB_ROOT ?? '')) errores.push('DB_USER debe ser un usuario MySQL dedicado a la API, no root (en Railway se admite root).');
  if (!c.db.password) errores.push('DB_PASSWORD es obligatorio en producción.');
  if (!c.qrRecargaDeunaUrl || !/^https:\/\//i.test(c.qrRecargaDeunaUrl)) errores.push('QR_RECARGA_DEUNA_URL debe ser HTTPS y apuntar a la imagen del QR oficial o a una página compartida de imgbb.');
  if (!/^\d{8,15}$/.test(c.whatsappBusinessNumber)) errores.push('WHATSAPP_BUSINESS_NUMBER debe ser el número del administrador con código de país, solo dígitos (ej: 591XXXXXXXX).');
  if (!Number.isFinite(c.puntosPorViaje) || c.puntosPorViaje <= 0) errores.push('PUNTOS_POR_VIAJE debe ser un número mayor que 0.');
  if (!Number.isInteger(c.puerto) || c.puerto < 1 || c.puerto > 65535) errores.push('PORT no es un puerto válido.');
  return errores;
}

/** Valida el almacenamiento de archivos (en cualquier entorno, porque un error aquí solo aparecería en la primera subida). */
export function erroresAlmacenamiento(c = config) {
  const a = c.almacenamiento;
  if (!['disco', 's3'].includes(a.driver)) return ['ALMACENAMIENTO_DRIVER debe ser "disco" o "s3".'];
  if (a.driver !== 's3') return [];
  const e = [];
  const sp = a.spaces;
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(sp.endpoint)) e.push('SPACES_ENDPOINT debe ser https://<region>.digitaloceanspaces.com (sin el nombre del bucket ni barra final).');
  if (!sp.region) e.push('SPACES_REGION es obligatorio (por ejemplo nyc3).');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(sp.bucket)) e.push('SPACES_BUCKET no es un nombre de bucket válido (minúsculas, números y guiones).');
  if (!sp.key || !sp.secret) e.push('SPACES_KEY y SPACES_SECRET son obligatorios.');
  return e;
}

const erroresAlm = erroresAlmacenamiento();
if (erroresAlm.length) {
  throw new Error('Configuración de almacenamiento incorrecta:\n- ' + erroresAlm.join('\n- '));
}
if (config.nodeEnv === 'production' && config.almacenamiento.driver === 'disco' && !volumenRailway && !process.env.DOCUMENTOS_DIR) {
  console.warn('[De Volada] AVISO: producción con almacenamiento en disco efímero. Los archivos se pierden en cada despliegue; monta un Volume en Railway o usa ALMACENAMIENTO_DRIVER=s3.');
}

const erroresProduccion = erroresConfiguracionProduccion();
if (erroresProduccion.length) {
  throw new Error('Configuración de producción incompleta:\n- ' + erroresProduccion.join('\n- '));
}
