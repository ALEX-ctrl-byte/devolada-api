import mysql from 'mysql2';
import { config } from './config.js';

const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  enableKeepAlive: true,       // Railway cierra conexiones inactivas: el keep-alive evita errores ECONNRESET
  keepAliveInitialDelay: 10_000,
  timezone: 'Z', // fechas JS en UTC
});

// Toda conexión trabaja en UTC (coincide con la convención del esquema)
pool.on('connection', (conexion) => {
  conexion.query("SET time_zone = '+00:00'");
});

// API con promesas: await db.execute(sql, params)  -> consultas preparadas
export const db = pool.promise();
