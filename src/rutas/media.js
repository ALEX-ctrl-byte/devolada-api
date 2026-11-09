import { Router } from 'express';
import { error } from '../respuesta.js';
import { resolverImagenQrRecarga } from '../servicios/qrRecarga.js';
import { leerImagenComercio } from '../servicios/almacenamiento.js';

export const rutaMedia = Router();
const seguro = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

// Solo publica imágenes no sensibles subidas por perfiles de comercio; los documentos de conductores siguen privados.
rutaMedia.get('/comercios/:nombre', async (req, res) => {
  const nombre = String(req.params.nombre ?? '');
  if (!seguro.test(nombre)) return error(res, 404, 'NO_ENCONTRADO', 'Imagen no encontrada.');
  try {
    const { buffer: bytes, mime } = await leerImagenComercio(nombre);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(bytes);
  } catch {
    return error(res, 404, 'NO_ENCONTRADO', 'Imagen no encontrada.');
  }
});


// QR oficial de recargas. Acepta URL directa de imagen o página compartida de imgbb.
rutaMedia.get('/qr-recarga-deuna', async (_req, res) => {
  try {
    const imagen = await resolverImagenQrRecarga();
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.redirect(302, imagen);
  } catch (err) {
    console.error('[De Volada] No se pudo resolver el QR oficial de recarga:', err?.message ?? err);
    return error(res, 502, 'QR_RECARGA_NO_DISPONIBLE', 'No se pudo cargar el QR oficial. Revisa QR_RECARGA_DEUNA_URL en el archivo .env; debe ser una URL HTTPS de imagen o una página compartida de imgbb que contenga esa imagen.');
  }
});
