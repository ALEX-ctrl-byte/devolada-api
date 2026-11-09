/**
 * Normaliza un celular boliviano a formato internacional (+591XXXXXXXX).
 * Acepta: 71234567, 59171234567, +591 7123 4567, etc.
 * Devuelve null si no es válido (celulares bolivianos empiezan con 6 o 7).
 */
export function normalizarTelefono(valor) {
  const limpio = String(valor ?? '').replace(/[\s\-()]/g, '');
  const m = limpio.match(/^(?:\+?591)?([67]\d{7})$/);
  return m ? `+591${m[1]}` : null;
}

/** Edad en años cumplidos a la fecha `hoy` (fechaIso = "YYYY-MM-DD"). */
export function edadEn(fechaIso, hoy = new Date()) {
  const [a, m, d] = fechaIso.split('-').map(Number);
  let edad = hoy.getUTCFullYear() - a;
  const mes = hoy.getUTCMonth() + 1;
  const dia = hoy.getUTCDate();
  if (mes < m || (mes === m && dia < d)) edad -= 1;
  return edad;
}

/** Valida "YYYY-MM-DD", que sea una fecha real, no futura y con la edad mínima. */
export function validarFechaNacimiento(valor, edadMinima) {
  const texto = String(valor ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    return { error: 'Ingresa tu fecha de nacimiento (día, mes y año).' };
  }
  const [a, m, d] = texto.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) {
    return { error: 'La fecha no es válida.' };
  }
  const edad = edadEn(texto);
  if (edad < 0) return { error: 'La fecha no puede ser futura.' };
  if (edad > 100) return { error: 'La fecha no es válida.' };
  if (edad < edadMinima) return { error: `Debes tener al menos ${edadMinima} años para usar De Volada.` };
  return { fecha: texto, edad };
}
