// Asigna (o cambia) el PIN de 4 dígitos de la cuenta admin.
// Uso:  node herramientas/pin-admin.mjs 7XXXXXXX 2580
import 'dotenv/config';
import { db } from '../src/db.js';
import { errorPin, hashPin } from '../src/servicios/pin.js';
import { normalizarTelefono } from '../src/validador.js';

const [, , telArg, pin] = process.argv;
const telefono = normalizarTelefono(telArg);
if (!telefono) { console.error('Teléfono inválido. Ej: node herramientas/pin-admin.mjs 71234567 2580'); process.exit(1); }
const e = errorPin(pin);
if (e) { console.error(e); process.exit(1); }

const [r] = await db.execute(
  "UPDATE usuarios SET pin_hash = ?, estado = 'activo' WHERE telefono = ? AND rol = 'admin'",
  [await hashPin(pin), telefono],
);
console.log(r.affectedRows ? `PIN del admin ${telefono} guardado. Ya puedes entrar al panel.` : 'No hay ningún admin con ese teléfono.');
process.exit(0);
