import { config } from '../config.js';

/**
 * Único punto de entrega de OTP. `consola` es SOLO desarrollo local.
 * `whatsapp` usa WhatsApp Cloud API y una plantilla aprobada por Meta cuyo
 * cuerpo contenga una variable para el código (por ejemplo: "Tu código De Volada es {{1}}.").
 * El proveedor nunca devuelve el OTP a la aplicación.
 */
export async function enviarOtp(telefono, codigo, proposito) {
  switch (config.otpProveedor) {
    case 'consola':
      if (!config.debug) throw new Error('OTP_PROVEEDOR=consola no se permite en producción.');
      console.log(`\n==== [OTP ${proposito}] ${telefono} -> CÓDIGO: ${codigo} ====\n`);
      return;

    case 'desactivado':
      // Login por PIN: no se envían códigos (ahorra el costo de WhatsApp Cloud API).
      throw new Error('El envío de OTP está desactivado (OTP_PROVEEDOR=desactivado).');

    case 'whatsapp': {
      const { whatsappToken, whatsappPhoneNumberId, whatsappTemplate, whatsappLanguage, whatsappGraphVersion } = config;
      if (!whatsappToken || !whatsappPhoneNumberId || !whatsappTemplate) {
        throw new Error('Falta configurar WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_OTP_TEMPLATE.');
      }
      const destino = telefono.replace(/\D/g, ''); // formato internacional sin +, ej. 59171234567
      const url = `https://graph.facebook.com/${whatsappGraphVersion}/${whatsappPhoneNumberId}/messages`;
      const respuesta = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${whatsappToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          type: 'template',
          template: {
            name: whatsappTemplate,
            language: { code: whatsappLanguage },
            components: [{ type: 'body', parameters: [{ type: 'text', text: codigo }] }],
          },
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!respuesta.ok) {
        const detalle = await respuesta.text().catch(() => 'sin detalle');
        throw new Error(`WhatsApp Cloud API HTTP ${respuesta.status}: ${detalle.slice(0, 500)}`);
      }
      return;
    }

    default:
      throw new Error(`Proveedor OTP desconocido: ${config.otpProveedor}`);
  }
}
