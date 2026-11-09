import crypto from 'node:crypto';

/**
 * Cliente mínimo para DigitalOcean Spaces (compatible con S3). Solo implementa lo que
 * necesita la API: subir, descargar y borrar un objeto. Firma AWS Signature V4 con
 * node:crypto y usa fetch (Node 18+), por lo que NO añade dependencias al proyecto.
 *
 * Los objetos se crean PRIVADOS (sin ACL pública). Las imágenes de comercios se sirven
 * desde la propia API (/media/comercios/...), así el bucket nunca se expone.
 */

const sha256hex = (datos) => crypto.createHash('sha256').update(datos).digest('hex');
const hmac = (clave, datos) => crypto.createHmac('sha256', clave).update(datos).digest();
const HASH_VACIO = sha256hex('');

const codificar = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const rutaCanonica = (clave) => `/${String(clave).split('/').map(codificar).join('/')}`;

/**
 * Calcula la cabecera Authorization (AWS SigV4). Función pura, verificada con el
 * ejemplo oficial de la documentación de AWS (ver pruebas/almacenamiento.test.mjs).
 * `headers` debe incluir 'host'; todos los headers recibidos se firman.
 */
export function firmarSigV4({ metodo, ruta, query = '', headers, hashCuerpo, region, servicio = 's3', claveAcceso, secreto, fecha }) {
  const amzFecha = fecha.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z
  const dia = amzFecha.slice(0, 8);
  const todos = { ...headers, 'x-amz-date': amzFecha, 'x-amz-content-sha256': hashCuerpo };
  const nombres = Object.keys(todos).map((n) => n.toLowerCase()).sort();
  const valores = Object.fromEntries(Object.entries(todos).map(([n, v]) => [n.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const cabecerasCanonicas = nombres.map((n) => `${n}:${valores[n]}\n`).join('');
  const firmadas = nombres.join(';');
  const canonica = [metodo, ruta, query, cabecerasCanonicas, firmadas, hashCuerpo].join('\n');
  const alcance = `${dia}/${region}/${servicio}/aws4_request`;
  const aFirmar = ['AWS4-HMAC-SHA256', amzFecha, alcance, sha256hex(canonica)].join('\n');
  const kFecha = hmac(`AWS4${secreto}`, dia);
  const kRegion = hmac(kFecha, region);
  const kServicio = hmac(kRegion, servicio);
  const kFirma = hmac(kServicio, 'aws4_request');
  const firma = crypto.createHmac('sha256', kFirma).update(aFirmar).digest('hex');
  return {
    amzFecha,
    firma,
    authorization: `AWS4-HMAC-SHA256 Credential=${claveAcceso}/${alcance}, SignedHeaders=${firmadas}, Signature=${firma}`,
  };
}

export function crearClienteSpaces(cfg, { fetchImpl = globalThis.fetch, ahora = () => new Date(), timeoutMs = 20_000 } = {}) {
  const { endpoint, region, bucket, key: claveAcceso, secret: secreto } = cfg;
  const host = `${bucket}.${new URL(endpoint).host}`; // estilo virtual-host: mi-bucket.nyc3.digitaloceanspaces.com

  async function pedir(metodo, objeto, { cuerpo = null, tipo = null } = {}) {
    const ruta = rutaCanonica(objeto);
    const hashCuerpo = cuerpo ? sha256hex(cuerpo) : HASH_VACIO;
    const headers = { host };
    if (tipo) headers['content-type'] = tipo;
    const { amzFecha, authorization } = firmarSigV4({
      metodo, ruta, headers, hashCuerpo, region, claveAcceso, secreto, fecha: ahora(),
    });
    const enviar = { 'x-amz-date': amzFecha, 'x-amz-content-sha256': hashCuerpo, authorization };
    if (tipo) enviar['content-type'] = tipo;
    const resp = await fetchImpl(`https://${host}${ruta}`, {
      method: metodo,
      headers: enviar,
      body: cuerpo ?? undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return resp;
  }

  async function fallo(resp, accion) {
    let codigo = '';
    try { codigo = ((await resp.text()).match(/<Code>([^<]+)<\/Code>/) ?? [])[1] ?? ''; } catch { /* sin cuerpo */ }
    const e = new Error(`Spaces ${accion} falló (HTTP ${resp.status}${codigo ? ` ${codigo}` : ''})`);
    e.status = resp.status;
    e.code = resp.status === 404 ? 'ENOENT' : 'SPACES_ERROR';
    return e;
  }

  return {
    async subir(objeto, buffer, tipo) {
      const resp = await pedir('PUT', objeto, { cuerpo: buffer, tipo });
      if (!resp.ok) throw await fallo(resp, 'subida');
    },
    async descargar(objeto) {
      const resp = await pedir('GET', objeto);
      if (!resp.ok) throw await fallo(resp, 'descarga');
      return Buffer.from(await resp.arrayBuffer());
    },
    async borrar(objeto) {
      const resp = await pedir('DELETE', objeto);
      if (!resp.ok && resp.status !== 404) throw await fallo(resp, 'borrado');
    },
  };
}
