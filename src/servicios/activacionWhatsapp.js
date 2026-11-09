import { config } from '../config.js';

/**
 * Construye el enlace wa.me con el mensaje de solicitud de activación de cuenta.
 * Devuelve null si WHATSAPP_BUSINESS_NUMBER no está configurado.
 */
export function urlActivacionWhatsapp({ telefono, nombre, apellido, rol }) {
  if (!config.whatsappBusinessNumber) return null;
  const mensaje = `Hola, solicito activar mi cuenta De Volada. Teléfono: ${telefono} | Nombre: ${nombre} ${apellido ?? ''} | Rol: ${rol}`;
  return `https://wa.me/${config.whatsappBusinessNumber}?text=${encodeURIComponent(mensaje)}`;
}
