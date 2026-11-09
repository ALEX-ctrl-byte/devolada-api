// Importa un archivo .sql (con DELIMITER, triggers, eventos y vistas) en la base indicada por la conexión.
// No necesita el cliente `mysql`: usa mysql2, que ya es dependencia del proyecto. Funciona igual en Windows.
//
// Uso (PowerShell):
//   $env:DATABASE_URL = "<MYSQL_PUBLIC_URL de Railway>"
//   npm run importar:sql -- ruta\devolada_railway.sql
//
// Seguridad: se niega a importar si la base ya tiene tablas (salvo --forzar), para no mezclar ni pisar datos.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';

/** Divide el script en sentencias respetando comillas, comentarios y DELIMITER. */
export function dividirSql(texto) {
  const sentencias = [];
  let delim = ';';
  let actual = '';
  let i = 0;
  const n = texto.length;
  const iniciaLinea = () => i === 0 || texto[i - 1] === '\n';
  while (i < n) {
    const c = texto[i];
    // DELIMITER solo al comienzo de una línea y con actual vacío
    if (iniciaLinea() && actual.trim() === '' && /^DELIMITER[ \t]/i.test(texto.slice(i, i + 10))) {
      const fin = texto.indexOf('\n', i);
      const linea = texto.slice(i, fin === -1 ? n : fin);
      delim = linea.replace(/^DELIMITER[ \t]+/i, '').trim();
      actual = '';
      i = fin === -1 ? n : fin + 1;
      continue;
    }
    // Comentarios de línea: "-- " o "#"
    if ((c === '-' && texto[i + 1] === '-' && /[\s]/.test(texto[i + 2] ?? '\n')) || c === '#') {
      const fin = texto.indexOf('\n', i);
      if (actual.trim() !== '') actual += texto.slice(i, fin === -1 ? n : fin);
      i = fin === -1 ? n : fin;
      continue;
    }
    // Comentario de bloque (los /*! ... */ son ejecutables y se conservan)
    if (c === '/' && texto[i + 1] === '*') {
      const fin = texto.indexOf('*/', i + 2);
      const bloque = texto.slice(i, fin === -1 ? n : fin + 2);
      if (texto[i + 2] === '!') actual += bloque;
      i += bloque.length;
      continue;
    }
    // Cadenas y identificadores entre comillas
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (texto[j] === '\\' && c !== '`') { j += 2; continue; }
        if (texto[j] === c) {
          if (texto[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      actual += texto.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (texto.startsWith(delim, i)) {
      if (actual.trim()) sentencias.push(actual.trim());
      actual = '';
      i += delim.length;
      continue;
    }
    actual += c;
    i++;
  }
  if (actual.trim()) sentencias.push(actual.trim());
  return sentencias;
}

async function main() {
  const args = process.argv.slice(2);
  const forzar = args.includes('--forzar');
  const archivo = args.find((a) => !a.startsWith('--'));
  const url = (process.env.DATABASE_URL || process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || '').trim();
  if (!archivo || !url) {
    console.error('Uso: DATABASE_URL=<url mysql> node herramientas/importar-sql.mjs archivo.sql [--forzar]');
    process.exit(2);
  }
  const sentencias = dividirSql(fs.readFileSync(archivo, 'utf8'));
  const u = new URL(url);
  const conexion = await mysql.createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined,
    charset: 'utf8mb4',
    multipleStatements: false,
    connectTimeout: 20_000,
  });
  try {
    const [[{ base }]] = await conexion.query('SELECT DATABASE() AS base');
    const [tablas] = await conexion.query('SHOW FULL TABLES');
    console.log(`Base destino: ${base} (${tablas.length} objetos existentes). Sentencias a ejecutar: ${sentencias.length}`);
    if (tablas.length > 0 && !forzar) {
      console.error('La base ya contiene tablas. Abortado para no pisar datos. Usa --forzar solo si estás seguro.');
      process.exit(3);
    }
    let hechas = 0;
    for (const sql of sentencias) {
      try {
        await conexion.query(sql);
      } catch (e) {
        console.error(`\nError en la sentencia #${hechas + 1}: ${e.message}\n--- ${sql.slice(0, 300)}`);
        process.exit(1);
      }
      hechas++;
      if (hechas % 25 === 0) process.stdout.write(`  ${hechas}/${sentencias.length}\r`);
    }
    const [t2] = await conexion.query('SHOW FULL TABLES');
    console.log(`\nListo: ${hechas} sentencias ejecutadas; ${t2.length} objetos en la base.`);
  } finally {
    await conexion.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
