import crypto from 'node:crypto';
import { config } from './config.js';

/** Código de 6 dígitos generado con aleatoriedad criptográfica. */
export const generarCodigoOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * Los OTP nunca se guardan en claro: se guarda un HMAC-SHA256 con la clave secreta del servidor
 * sobre telefono|proposito|codigo. Incluir el propósito evita reutilizar un código de 'login'
 * para otra operación (por ejemplo 'retiro').
 */
export const hashOtp = (telefono, proposito, codigo) =>
  crypto.createHmac('sha256', config.otpSecret).update(`${telefono}|${proposito}|${codigo}`).digest('hex');

/** Token de sesión: 32 bytes aleatorios. Al cliente va el token; a la BD solo su SHA-256. */
export const nuevoToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Comparación en tiempo constante (evita ataques por tiempo de respuesta). */
export function iguales(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Fecha UTC en formato DATETIME de MySQL ("2026-10-06 22:41:19"). */
export const fechaUtcSql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');


/** Ticket temporal que acredita que el celular fue verificado para un registro nuevo.
 * Firmado por la API y válido durante 15 minutos. La unicidad del teléfono impide reutilizarlo
 * para crear otra cuenta tras un registro exitoso.
 */
export function crearTicketRegistro(telefono, email) {
  const carga = Buffer.from(JSON.stringify({
    proposito: 'registro',
    telefono,
    email: String(email ?? '').trim().toLowerCase(),
    exp: Date.now() + 15 * 60_000,
    nonce: crypto.randomBytes(16).toString('base64url'),
  })).toString('base64url');
  const firma = crypto.createHmac('sha256', config.otpSecret).update(`registro-ticket.${carga}`).digest('base64url');
  return `${carga}.${firma}`;
}

export function validarTicketRegistro(ticket, telefono, email) {
  if (typeof ticket !== 'string' || ticket.length > 2048) return false;
  const partes = ticket.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) return false;
  const [carga, firma] = partes;
  const firmaEsperada = crypto.createHmac('sha256', config.otpSecret).update(`registro-ticket.${carga}`).digest('base64url');
  if (!iguales(firma, firmaEsperada)) return false;
  try {
    const datos = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8'));
    return datos?.proposito === 'registro'
      && datos?.telefono === telefono
      && datos?.email === String(email ?? '').trim().toLowerCase()
      && Number.isFinite(datos?.exp)
      && datos.exp > Date.now()
      && typeof datos.nonce === 'string';
  } catch {
    return false;
  }
}
