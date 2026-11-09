import bcrypt from 'bcryptjs';

// PIN de 4 dígitos para iniciar sesión (sin OTP). Se guarda solo el hash bcrypt.
// bcryptjs es JavaScript puro: no necesita compilación nativa en Windows/Laragon ni en Linux.
const RONDAS = 10;

// Hash válido de un PIN aleatorio: se compara contra él cuando el teléfono no existe,
// para que la respuesta tarde lo mismo y no revele qué números están registrados.
const HASH_SEÑUELO = bcrypt.hashSync('no-es-un-pin-' + Math.random(), RONDAS);

/** Devuelve un mensaje de error o null si el PIN es aceptable. */
export function errorPin(valor) {
  const pin = String(valor ?? '');
  if (!/^\d{4}$/.test(pin)) return 'El PIN debe tener exactamente 4 números.';
  if (/^(\d)\1{3}$/.test(pin) || pin === '1234' || pin === '4321') {
    return 'Ese PIN es muy fácil de adivinar. Elige otro (no uses 1111, 1234, etc.).';
  }
  return null;
}

export function hashPin(pin) {
  return bcrypt.hash(String(pin), RONDAS);
}

/** Compara en tiempo similar exista o no el hash. */
export async function pinCorrecto(pin, hash) {
  const ok = await bcrypt.compare(String(pin ?? ''), hash || HASH_SEÑUELO);
  return Boolean(hash) && ok;
}
