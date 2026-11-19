import { Router } from 'express';

// Páginas públicas exigidas por Google Play: política de privacidad, términos y eliminación de cuenta.
// Sin inicio de sesión. Los textos coinciden con los de la app (TextosLegales.kt, versión 2.3).
export const rutaLegal = Router();

const VERSION = '2.3';
const VIGENCIA = '15 de noviembre de 2026';
const CONTACTO_CORREO = 'rmodbus@gmail.com';
const CONTACTO_WHATSAPP = '+591 57181665';

const PRIVACIDAD = `
1. Responsable y contacto. El responsable indicado para el tratamiento de datos es Alexandra Belen Saavedra Turpo. Domicilio legal: Alto San Antonio.  Contacto para privacidad, acceso, rectificación y eliminación: Correo: rmodbus@gmail.com | WhatsApp: +591 57181665. Esta política cubre las funciones de viajes, envíos de paquetes y pedidos a comercios en las zonas donde estén habilitadas.

2. Datos que podemos recopilar.
• Cuenta: nombre, apellidos, celular, PIN de acceso cifrado/derivado, correo electrónico, fecha de nacimiento, sexo cuando se solicita, ciudad, rol y estado de aprobación.
• Conductores y repartidores: documento de identidad, licencia, datos del vehículo y placa, fotografías y documentos de respaldo, QR personal de cobro y datos de operación.
• Comercios: nombre comercial, dirección, ubicación, horarios, catálogo, imágenes, contacto y QR bancario que decidan cargar.
• Ubicación: GPS preciso cuando eliges o confirmas puntos en el mapa y, para conductores/repartidores, mientras estén disponibles o tengan un servicio activo, según permisos y funciones habilitadas.
• Servicios: viajes, pedidos, envíos, contenido declarado del paquete, nombres y teléfonos de recogida/entrega, direcciones, coordenadas, estados, tarifas, pagos reportados, confirmaciones, códigos temporales, calificaciones y reclamos.
• Pagos QR: imagen del QR de la persona remitente cuando el envío cobra el valor del paquete; QR del conductor cuando el delivery se paga por QR; importes, método elegido, estados y marcas de tiempo de confirmación. De Volada no recibe credenciales bancarias ni verifica automáticamente el abono en el banco.
• Datos técnicos: IP, sesiones, registros de seguridad, modelo/versión del dispositivo y token de registro de Firebase Cloud Messaging (FCM) necesario para enviar notificaciones push.

3. Uso de la ubicación. Para clientes y remitentes, la ubicación del dispositivo ayuda a centrar el mapa, elegir origen/destino y calcular rutas y tarifas mientras se utiliza la app. Para conductores y repartidores, la ubicación precisa puede transmitirse mientras estén disponibles o tengan un servicio activo, incluso con la pantalla apagada mediante el servicio en primer plano y su notificación visible, para asignación, seguimiento y seguridad. Al desconectarse y no tener servicio activo debe cesar el seguimiento operativo.

4. Finalidades. Crear y proteger cuentas; revisar y aprobar perfiles; conectar pasajeros, conductores, repartidores, comercios y destinatarios; seleccionar direcciones; calcular rutas y tarifas; asignar y seguir servicios; validar recogidas y entregas; mostrar QR a las personas autorizadas; registrar confirmaciones de cobro declaradas por sus respectivos receptores; gestionar operaciones internas y pagos directos; prevenir fraude; enviar notificaciones; atender soporte y cumplir obligaciones legales.

5. Compartición de datos y proveedores.
• Participantes: el pasajero/cliente puede ver datos necesarios del conductor asignado; el conductor ve datos y direcciones necesarias para recoger y entregar; el destinatario puede ver el QR de la persona remitente solo durante la entrega autorizada; los comercios y repartidores reciben los datos necesarios para preparar y completar pedidos.
• Proveedores técnicos: alojamiento de API y base de datos (Railway), almacenamiento de archivos, mapas, geocodificación y rutas (según la configuración activa), y Firebase/Google para la entrega de notificaciones push. Estos proveedores reciben únicamente los datos técnicos necesarios para prestar sus servicios.
• Autoridades, cuando una ley u orden válida lo exija. No vendemos datos personales ni ubicación.

6. Notificaciones push. Si autorizas las notificaciones del sistema, De Volada puede enviarte avisos de nuevos viajes, pedidos, envíos y cambios de estado. Para ello se registra un token técnico de FCM asociado a tu cuenta y dispositivo. Puedes desactivar las notificaciones desde los ajustes de Android; al cerrar sesión se intenta retirar el token de ese dispositivo.

7. Conservación y seguridad. Conservamos los datos mientras la cuenta y los servicios estén activos y durante los plazos necesarios para seguridad, conciliación de operaciones, reclamos y obligaciones legales. Los QR de cobro del paquete se guardan en almacenamiento privado y solo se muestran a las personas autorizadas durante el flujo de entrega. Aplicamos HTTPS, sesiones con caducidad, permisos por rol y controles de acceso; ningún sistema es completamente infalible.

8. Tus derechos. Puedes solicitar acceso, rectificación, actualización u oposición al tratamiento y pedir eliminación desde Perfil o desde https://api.usadevolada.com/eliminar-cuenta, o mediante Correo: rmodbus@gmail.com | WhatsApp: +591 57181665. Puedes retirar permisos de ubicación y notificaciones desde los ajustes de Android. La eliminación puede estar sujeta a la conservación mínima exigida por ley o necesaria para resolver un servicio o reclamo.

9. Menores de edad. De Volada está destinada a mayores de 18 años y no busca recopilar intencionalmente datos de menores.

10. Cambios. Si actualizamos esta política, indicaremos la nueva versión y fecha dentro de la app y en https://api.usadevolada.com/privacidad.
`.trim();

const TERMINOS = `
1. Identidad y alcance. De Volada es una plataforma tecnológica que conecta a pasajeros, conductores de motocicleta, repartidores, comercios y participantes de envíos de paquetes. Su operación inicial está prevista para las zonas habilitadas de La Paz y El Alto, Bolivia. Responsable indicado: Alexandra Belen Saavedra Turpo. Domicilio legal: Alto San Antonio. Contacto: Correo: rmodbus@gmail.com | WhatsApp: +591 57181665.

2. Aceptación, edad y registro. La aplicación está destinada a personas mayores de 18 años. Para registrarte proporcionas datos reales, un número celular boliviano, un PIN y aceptas estos Términos y la Política de Privacidad. La cuenta puede quedar pendiente de revisión: el teléfono y la información se verifican conforme al proceso de activación por WhatsApp y aprobación administrativa que indique la aplicación. No compartas tu PIN ni los códigos temporales de recogida o entrega.

3. Operaciones internas. Los conductores y comercios utilizan operaciones internas para acceder a los servicios de la plataforma. No son dinero, depósito, crédito, préstamo ni instrumento financiero; no generan intereses, no se retiran, transfieren ni canjean por dinero. Cada viaje, envío/delivery o venta completada consume una operación según corresponda. Cada Bs 2 de recarga verificada acredita una operación; el mínimo es Bs 2 y las recargas deben ser múltiplos de Bs 2. Las solicitudes se acreditan únicamente después de que administración verifica el abono real en la cuenta oficial. Una captura no acredita un depósito. Las operaciones y sus movimientos se muestran únicamente a conductores y comercios.

4. Naturaleza del servicio. De Volada facilita el contacto, solicitud, asignación, seguimiento y coordinación tecnológica. Los conductores y comercios prestan sus servicios bajo su propia responsabilidad y deben cumplir la normativa aplicable. Las rutas, distancias, tarifas y tiempos son estimaciones que pueden variar por tráfico, clima, cobertura, GPS y condiciones de la vía.

5. Envíos y pagos separados. La persona remitente elige origen y destino, declara el contenido y selecciona si el paquete tiene un valor que debe cobrarse al destinatario. Si no hay cobro del paquete, no se solicita QR de la persona remitente. Si existe un valor por cobrar, la persona remitente informa el importe y proporciona su QR; el destinatario paga ese importe directamente a la persona remitente mediante QR. Por separado, la persona remitente selecciona si la tarifa del delivery se pagará en efectivo o por QR al repartidor; esa tarifa la paga el destinatario al repartidor. De Volada no recibe ni verifica automáticamente esos abonos bancarios: cada receptor debe comprobar el ingreso efectivo en su propia cuenta y confirmar en la aplicación únicamente después de recibirlo. El código final de entrega se habilita cuando se hayan confirmado los cobros que correspondan. Los importes del paquete y del transporte no se mezclan.

6. Conducta y objetos prohibidos. Está prohibido proporcionar datos falsos, suplantar personas, manipular GPS, acosar, amenazar o discriminar, usar la app para actividades ilícitas, enviar armas, drogas, explosivos, efectivo, animales vivos, objetos peligrosos o cualquier artículo prohibido por la ley, y compartir datos de otros usuarios fuera de la prestación del servicio.

7. Suspensión y soporte. De Volada puede limitar o suspender cuentas por fraude, riesgo para la seguridad, documentos vencidos, abuso o incumplimiento de estos Términos. Puedes solicitar revisión o presentar un reclamo por los canales de soporte.

8. Reglas para pasajeros, remitentes y destinatarios.
• Comprueba origen, destino, tarifa estimada, identidad del conductor y placa antes de iniciar un viaje. Usa casco cuando corresponda.
• En un envío, declara el contenido con honestidad y entrega el código de recogida solo al conductor asignado. El destinatario debe pagar primero los importes que correspondan y entregar el código de entrega solo cuando tenga el paquete.
• Si el envío cobra el valor del paquete, el destinatario paga por QR directamente a la persona remitente. La persona remitente debe verificar el abono en su banco antes de pulsar “Confirmar cobro recibido”.
• La tarifa del delivery es independiente y la paga el destinatario al repartidor en efectivo o por QR, según el método seleccionado por la persona remitente. El repartidor confirma únicamente el dinero que haya recibido y verificado.
• En pedidos a comercios, revisa productos, precios, disponibilidad, dirección y modalidad de pago que muestre la aplicación.

8. Reglas para conductores y repartidores.
• Solo puedes recibir servicios cuando De Volada haya aprobado tu cuenta, vehículo y documentos requeridos. Mantén licencia, SOAT y demás documentos vigentes.
• Cumple las normas de tránsito: casco para ti y para el pasajero, cinturón de seguridad en automóvil, cero alcohol o drogas y no utilices el celular de forma insegura.
• Conductores y comercios necesitan operaciones suficientes para recibir servicios o pedidos; cada servicio o venta completada consume una operación.
• Mientras estés disponible o tengas un servicio activo, la app puede transmitir tu ubicación precisa para asignaciones, seguimiento y seguridad, conforme a los permisos del dispositivo.
• En envíos verifica el código de recogida antes de recibir el paquete. En destino, confirma únicamente la tarifa del delivery que realmente recibiste. Nunca confirmes el cobro del valor del paquete por cuenta de la persona remitente.
• No entregues el paquete hasta que la app habilite el código final. Introduce el código de entrega que te muestre el destinatario después de recibir el paquete y completar los pagos.
• Cobra solo la tarifa de transporte informada en la aplicación y mediante el método seleccionado para ese servicio.

8. Reglas para comercios.
• Mantén veraces y actualizados el nombre comercial, contacto, dirección, ubicación, horarios, catálogo, imágenes, precios y disponibilidad.
• No publiques productos ilegales, falsificados, peligrosos o que infrinjan derechos de terceros.
• Confirma pedidos solo cuando puedas atenderlos; prepara los productos y entrégalos al repartidor asignado.
• Antes de confirmar un pago QR, verifica el abono real en tu cuenta bancaria. Una captura no sustituye la verificación bancaria.
• Comunica faltantes, sustituciones, demoras, cancelaciones y reembolsos y registra las operaciones mediante las funciones disponibles.
• Los saldos de comisiones, cuando estén habilitados, son independientes del cobro de productos y de la tarifa del repartidor. Sus importes y reglas deben mostrarse antes de aplicarse.
• La cuenta de comercio también puede solicitar envíos de paquetes como remitente cuando esa función esté habilitada. En ese caso debe indicar origen, destino, persona destinataria, si cobra un valor por el paquete y el método de pago del delivery. El QR que cargue para cobrar el valor del paquete es independiente del QR de cobro de productos del comercio.

9. Responsabilidad y disponibilidad. La aplicación puede experimentar interrupciones por mantenimiento, conectividad, servicios de terceros, cobertura móvil o GPS. Nada de estos Términos excluye responsabilidades que no puedan excluirse por ley ni limita los derechos de las personas consumidoras conforme a la normativa boliviana.

10. Eliminación de cuenta. Puedes solicitar la eliminación desde Perfil y desde https://api.usadevolada.com/eliminar-cuenta. Si tienes un servicio en curso, se coordinará su finalización o cancelación. Se conservarán únicamente los datos que deban mantenerse por seguridad, prevención de fraude, reclamos u obligaciones legales; los demás se eliminarán o anonimizarán conforme a la Política de Privacidad.

11. Cambios. De Volada podrá actualizar estos Términos para reflejar cambios operativos, funcionales o legales. La versión y vigencia estarán disponibles en la aplicación y en el sitio web. Cuando corresponda, se solicitará un nuevo consentimiento.

12. Ley aplicable y contacto. Estos Términos se interpretan conforme a las leyes del Estado Plurinacional de Bolivia, sin perjuicio de derechos irrenunciables. Consultas y reclamos: Correo: rmodbus@gmail.com | WhatsApp: +591 57181665.
`.trim();

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function textoAHtml(texto) {
  const bloques = texto.split(/\n\s*\n/);
  return bloques.map((b) => {
    let html = '';
    let lista = [];
    const cerrar = () => { if (lista.length) { html += '<ul>' + lista.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>'; lista = []; } };
    for (const l of b.split('\n')) {
      const t = l.trim();
      if (!t) continue;
      if (t.startsWith('•')) { lista.push(t.replace(/^•\s*/, '')); continue; }
      cerrar();
      // "1. Título. Resto del texto": el título pasa a encabezado y el resto queda como párrafo.
      const m = /^(\d+\.\s[^.]{1,60}\.)\s*(.*)$/.exec(t);
      if (m) { html += `<h2>${esc(m[1])}</h2>`; if (m[2]) html += `<p>${esc(m[2])}</p>`; }
      else html += `<p>${esc(t)}</p>`;
    }
    cerrar();
    return html;
  }).join('\n');
}

function pagina(titulo, cuerpo) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} · De Volada</title>
<style>
body{margin:0;background:#f4f6fb;color:#16213e;font:16px/1.65 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{background:#0b1f4d;color:#fff;padding:28px 20px}
header h1{margin:0;font-size:26px}header p{margin:6px 0 0;color:#ffc107;font-weight:600}
main{max-width:820px;margin:0 auto;padding:24px 20px 60px;background:#fff}
h2{font-size:19px;margin:28px 0 6px;color:#0b1f4d}
ul{padding-left:22px}li{margin:4px 0}
.meta{color:#5b6478;font-size:14px}
footer{max-width:820px;margin:0 auto;padding:18px 20px;color:#5b6478;font-size:14px}
a{color:#1a56db}
</style></head><body>
<header><h1>De Volada</h1><p>A DONDE VAYAS</p></header>
<main><h1>${esc(titulo)}</h1>${cuerpo}</main>
<footer>© De Volada · <a href="/privacidad">Política de privacidad</a> · <a href="/terminos">Términos y condiciones</a> · <a href="/eliminar-cuenta">Eliminar mi cuenta</a></footer>
</body></html>`;
}

const cache = { 'Cache-Control': 'public, max-age=3600' };

rutaLegal.get('/privacidad', (_req, res) => {
  res.set(cache).type('html').send(pagina('Política de privacidad',
    `<p class="meta">Versión ${VERSION} · Vigente desde ${VIGENCIA}</p>${textoAHtml(PRIVACIDAD)}`));
});

rutaLegal.get('/terminos', (_req, res) => {
  res.set(cache).type('html').send(pagina('Términos y condiciones',
    `<p class="meta">Versión ${VERSION} · Vigentes desde ${VIGENCIA}</p>${textoAHtml(TERMINOS)}`));
});

rutaLegal.get('/eliminar-cuenta', (_req, res) => {
  res.set(cache).type('html').send(pagina('Eliminar mi cuenta y mis datos',
    `<p class="meta">Aplicación: De Volada (com.usadevolada.app)</p>
<h2>Desde la aplicación</h2>
<ul><li>Abre De Volada e inicia sesión.</li><li>Ve a Perfil.</li><li>Pulsa «Eliminar mi cuenta» y confirma.</li></ul>
<h2>Sin acceso a la aplicación</h2>
<p>Escríbenos a ${esc(CONTACTO_CORREO)} o por WhatsApp al ${esc(CONTACTO_WHATSAPP)} desde el número de celular de tu cuenta y pide la eliminación. Verificaremos que eres el titular y eliminaremos la cuenta.</p>
<h2>Qué datos se eliminan</h2>
<ul><li>Se anonimizan tu nombre, celular, correo, fecha de nacimiento y sexo.</li><li>Se borran tus documentos (identidad, licencia), fotos y tu última ubicación.</li><li>Se desactiva tu acceso y tu sesión.</li></ul>
<h2>Qué datos pueden conservarse</h2>
<p>Sin identificarte, podemos conservar el historial de servicios y los movimientos de operaciones el tiempo necesario por seguridad, reclamos y obligaciones legales.</p>`));
});
