import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignorar = new Set(['node_modules', '.git', 'dist', 'build']);
const archivos = [];
function recorrer(dir) {
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entrada.isDirectory() && ignorar.has(entrada.name)) continue;
    const ruta = path.join(dir, entrada.name);
    if (entrada.isDirectory()) recorrer(ruta);
    else if (/\.(?:js|mjs|cjs)$/.test(entrada.name)) archivos.push(ruta);
  }
}
recorrer(root);
let fallos = 0;
for (const archivo of archivos) {
  const resultado = spawnSync(process.execPath, ['--check', archivo], { encoding: 'utf8' });
  if (resultado.status !== 0) {
    fallos++;
    process.stderr.write(`\nFALLO ${path.relative(root, archivo)}\n${resultado.stderr || resultado.stdout}`);
  }
}
if (fallos) {
  console.error(`\n${fallos}/${archivos.length} archivos JavaScript/MJS con errores de sintaxis.`);
  process.exit(1);
}
console.log(`Sintaxis correcta: ${archivos.length} archivos JavaScript/MJS revisados.`);
