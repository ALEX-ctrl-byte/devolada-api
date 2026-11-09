import { config } from '../config.js';

function parseHttpsUrl(valor) {
  try {
    const url = new URL(String(valor ?? '').trim());
    if (url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/** Imgbb ofrece URLs de página (ibb.co/ID) y URLs de imagen directa (i.ibb.co/...). */
export function esPaginaCompartidaQr(urlValor = config.qrRecargaDeunaUrl) {
  const url = parseHttpsUrl(urlValor);
  return Boolean(url && ['ibb.co', 'www.ibb.co'].includes(url.hostname.toLowerCase()));
}

function basePublicaDesdePeticion(req) {
  const hostReenviado = String(req?.get?.('x-forwarded-host') ?? '').split(',')[0].trim();
  const hostNormal = String(req?.get?.('host') ?? '').trim();
  const host = hostReenviado || hostNormal;
  if (!host) return null;

  // Los Quick Tunnels de Cloudflare llegan a Node con el dominio público o X-Forwarded-Host.
  if (/^[a-z0-9.-]+\.trycloudflare\.com(?::\d+)?$/i.test(host)) {
    return `https://${host}`;
  }

  // En un dominio estable, respetar HTTPS reenviado por el proxy; PUBLIC_API_URL es preferible.
  const protoReenviado = String(req?.get?.('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase();
  if (hostReenviado && protoReenviado === 'https' && !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    return `https://${host}`;
  }

  // Permite probar desde la misma computadora. No se usa localhost para un teléfono remoto.
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
    return protoReenviado === 'https' ? `https://${host}` : `http://${host}`;
  }

  return null;
}

/** Devuelve una URL que Coil/AsyncImage pueda cargar como imagen. */
export function urlPublicaQrRecarga(req) {
  const original = parseHttpsUrl(config.qrRecargaDeunaUrl);
  if (!original) return null;

  // Enlace directo a imagen: no necesita proxy.
  if (!esPaginaCompartidaQr(original.href)) return original.href;

  const base = config.urlPublicaApi || basePublicaDesdePeticion(req);
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/media/qr-recarga-deuna`;
}

let cacheQr = { source: '', image: '', expiresAt: 0 };

function extraerMetaImagen(html) {
  const etiquetas = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const etiqueta of etiquetas) {
    const propiedad = etiqueta.match(/\b(?:property|name)\s*=\s*["'](og:image|twitter:image)["']/i)?.[1]?.toLowerCase();
    if (!propiedad) continue;
    const contenido = etiqueta.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
    if (contenido) return contenido.replace(/&amp;/gi, '&').replace(/&#38;/g, '&');
  }
  return null;
}

/** Resuelve una página compartida de imgbb a su imagen original, con caché breve. */
export async function resolverImagenQrRecarga() {
  const source = parseHttpsUrl(config.qrRecargaDeunaUrl);
  if (!source) throw new Error('Configura QR_RECARGA_DEUNA_URL con una URL HTTPS válida.');

  if (!esPaginaCompartidaQr(source.href)) return source.href;
  if (cacheQr.source === source.href && cacheQr.image && cacheQr.expiresAt > Date.now()) {
    return cacheQr.image;
  }

  const response = await fetch(source.href, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; DeVolada-QR/1.0)' },
    signal: AbortSignal.timeout(8000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`El enlace compartido del QR respondió HTTP ${response.status}.`);

  const html = await response.text();
  const metaImagen = extraerMetaImagen(html);
  let imagen;
  try {
    imagen = new URL(metaImagen ?? '');
  } catch {
    throw new Error('No se encontró la imagen dentro del enlace compartido. Usa el enlace directo de imagen de imgbb.');
  }

  // Se limita el destino de una página imgbb para no convertir esta ruta en un redireccionador arbitrario.
  if (imagen.protocol !== 'https:' || imagen.hostname.toLowerCase() !== 'i.ibb.co') {
    throw new Error('El enlace de imgbb no devolvió una imagen directa segura. Usa el enlace directo de imagen.');
  }

  cacheQr = { source: source.href, image: imagen.href, expiresAt: Date.now() + 15 * 60 * 1000 };
  return imagen.href;
}
