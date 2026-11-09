import { config } from '../src/config.js';
import { db } from '../src/db.js';

const checks = [];
try {
  const [[dbInfo]] = await db.query('SELECT DATABASE() AS base, VERSION() AS version, UTC_TIMESTAMP() AS utc');
  checks.push({ prueba: 'MySQL', ok: dbInfo.base === config.db.database, detalle: dbInfo });
  const [tablas] = await db.query('SHOW TABLES');
  const nombres = tablas.map(row => Object.values(row)[0]);
  const requeridas = ['usuarios','otp','sesiones','ciudades','conductores','empresas','viajes','billeteras','movimientos_billetera','billeteras_pasajero','recargas_billetera','movimientos_billetera_pasajero','productos_comercio'];
  checks.push({ prueba: 'Tablas mínimas', ok: requeridas.every(t => nombres.includes(t)), faltantes: requeridas.filter(t => !nombres.includes(t)), encontradas: nombres.length });
  const [cols] = await db.query('SHOW COLUMNS FROM usuarios');
  const campos = cols.map(c => c.Field);
  const requeridosUsuario = ['id','telefono','nombre','apellido','email','rol','estado'];
  checks.push({ prueba: 'Columnas usuarios', ok: requeridosUsuario.every(c => campos.includes(c)), faltantes: requeridosUsuario.filter(c => !campos.includes(c)) });
} catch (e) {
  checks.push({ prueba: 'MySQL/esquema', ok: false, detalle: e.message, codigo: e.code });
}
console.log(JSON.stringify({ api: 'De Volada', baseConfigurada: config.db.database, otpProveedor: config.otpProveedor, resultados: checks }, null, 2));
await db.end();
if (checks.some(c => !c.ok)) process.exitCode = 1;
