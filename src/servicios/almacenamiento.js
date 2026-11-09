import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { crearClienteSpaces } from './spaces.js';

/**
 * ÚNICO módulo que guarda y lee archivos (documentos de conductores e imágenes de comercios).
 *
 * Dos modos, según ALMACENAMIENTO_DRIVER:
 *   - disco (por defecto): carpetas locales. Sirve para desarrollo y para un VPS con disco persistente.
 *   - s3: DigitalOcean Spaces. OBLIGATORIO en App Platform, cuyo disco se borra en cada despliegue.
 *
 * Dos espacios separados:
 *   - documentos: PRIVADOS (cédula, licencia...). Solo los lee el administrador desde la API.
 *   - comercios:  imágenes comerciales (logo, productos, QR). Se sirven vía /media/comercios/...
 *
 * En la base de datos solo se guarda el NOMBRE aleatorio del archivo (nunca una ruta).
 * El bucket de Spaces debe ser PRIVADO: la API es la única que lo lee.
 */

const NOMBRE_VALIDO = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const ESPACIOS = {
  documentos: { carpeta: () => config.carpetaDocumentos, modoArchivo: 0o600, modoCarpeta: 0o700, prefijo: 'documentos/' },
  comercios: { carpeta: () => config.carpetaImagenesComercio, modoArchivo: 0o644, modoCarpeta: 0o755, prefijo: 'comercios/' },
};

let clienteS3 = null;
const usaS3 = () => config.almacenamiento.driver === 's3';
function s3() {
  clienteS3 ??= crearClienteSpaces(config.almacenamiento.spaces);
  return clienteS3;
}
/** Solo para pruebas: reemplaza el cliente de Spaces por uno simulado. */
export function inyectarClienteAlmacenamiento(cliente) { clienteS3 = cliente; }

/** Detecta el tipo REAL por los primeros bytes; ignora el nombre y el tipo que declare el cliente. */
export function detectarImagen(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: MIME.jpg };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', mime: MIME.png };
  }
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { ext: 'webp', mime: MIME.webp };
  }
  return null;
}

/** Guarda con nombre aleatorio. Devuelve el nombre. */
async function guardar(espacio, buf, ext) {
  const esp = ESPACIOS[espacio];
  if (!MIME[ext]) throw new Error('Extensión de archivo no admitida');
  const nombre = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  if (usaS3()) {
    await s3().subir(esp.prefijo + nombre, buf, MIME[ext]);
    return nombre;
  }
  await fs.mkdir(esp.carpeta(), { recursive: true, mode: esp.modoCarpeta });
  await fs.writeFile(path.join(esp.carpeta(), nombre), buf, { flag: 'wx', mode: esp.modoArchivo });
  return nombre;
}

/** Lee un archivo. Rechaza cualquier nombre que no tenga el formato exacto que genera este módulo. */
async function leer(espacio, nombre) {
  const esp = ESPACIOS[espacio];
  if (!NOMBRE_VALIDO.test(String(nombre))) throw new Error('Nombre de archivo inválido');
  const buffer = usaS3()
    ? await s3().descargar(esp.prefijo + nombre)
    : await fs.readFile(path.join(esp.carpeta(), nombre));
  return { buffer, mime: MIME[nombre.split('.').pop()] };
}

/** Borra un archivo; nunca lanza error (se usa al limpiar). */
async function borrar(espacio, nombre) {
  const esp = ESPACIOS[espacio];
  if (!NOMBRE_VALIDO.test(String(nombre))) return;
  try {
    if (usaS3()) await s3().borrar(esp.prefijo + nombre);
    else await fs.unlink(path.join(esp.carpeta(), nombre));
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error('[De Volada] No se pudo borrar un archivo almacenado:', e?.message ?? e);
  }
}

// Documentos privados de conductores
export const guardarDocumento = (buf, ext) => guardar('documentos', buf, ext);
export const leerDocumento = (nombre) => leer('documentos', nombre);
export const borrarDocumento = (nombre) => borrar('documentos', nombre);

// Imágenes de comercios (logo, productos, QR bancario)
export const guardarImagenComercio = (buf, ext) => guardar('comercios', buf, ext);
export const leerImagenComercio = (nombre) => leer('comercios', nombre);
export const borrarImagenComercio = (nombre) => borrar('comercios', nombre);
