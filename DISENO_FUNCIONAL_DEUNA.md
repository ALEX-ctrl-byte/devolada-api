# DEUNA — Especificación funcional de pantallas

Marca visual aplicada en esta versión: negro `#151515`, amarillo `#FFC928`, blanco `#FFFFFF`; lema “De una, llegas rápido”. Se conservan los nombres internos de paquetes y clases `com.deuna` para no romper imports ni configuraciones existentes.

## Regla común de acceso
- No se solicitará contraseña a pasajeros, conductores ni comercios.
- Acceso mediante OTP temporal asociado al celular y validado por un proveedor compatible con WhatsApp.
- Correo electrónico obligatorio para los tres perfiles; verificar correo antes de activar funciones sensibles.
- Sesiones revocables, límite de intentos, expiración del OTP y registro de eventos de seguridad.
- La verificación del teléfono no aprueba automáticamente a un conductor ni verifica la legitimidad de un comercio.

## Pasajero
1. Bienvenida DEUNA y acciones “Comenzar” / “Ya tengo cuenta”.
2. Selección de perfil: Pasajero, Conductor o Comercio.
3. Celular + código OTP por WhatsApp.
4. Datos personales: nombres, apellidos, correo y fecha de nacimiento. No pedir CI.
5. Inicio con mapa, origen, destino y tarifa estimada.
6. Búsqueda, asignación, conductor y moto identificados, viaje en curso y finalización.
7. Historial, calificaciones, ayuda, privacidad y eliminación de cuenta.

## Conductor
1. Datos personales y correo.
2. Identidad: CI anverso/reverso, datos del documento y fotografía de perfil.
3. Licencia vigente, categoría y vencimiento.
4. Motocicleta: marca, modelo, año, placa, color, cilindrada, chasis y fotos.
5. Documentos vehiculares aplicables, propiedad/autorización de uso y seguro cuando corresponda.
6. Pantalla de estado de revisión: pendiente, observado, aprobado, rechazado o suspendido.
7. Solo aprobado y con documentos vigentes puede conectarse y aceptar viajes.
8. Solicitudes, navegación, llegada, inicio/fin de viaje, ganancias e historial.

## Comercio
1. Datos de responsable, nombre comercial, rubro, correo y celular verificado. Sin CI en el registro inicial.
2. Dirección, ciudad/zona, pin en mapa, coordenadas y referencias del local.
3. Horario por día, pausas, días cerrados y horarios especiales.
4. Logo, portada, contacto, descripción, métodos de pago y tiempo de preparación.
5. Catálogo, precios, imágenes, disponibilidad, pedidos y estado de preparación.
6. Historial de pedidos/ventas, horarios, ubicación, perfil y soporte.
7. La administración podrá solicitar documentación comercial adicional si las obligaciones locales lo requieren.

## Administración
- Bandejas separadas para conductores y comercios pendientes.
- Revisión de archivos privados, observaciones, aprobación, rechazo y suspensión con motivo.
- Gestión de viajes, incidencias, tarifas, zonas, cuentas y auditoría.
- Acceso a documentos solo para personal autorizado; cifrado, retención limitada y registro de consultas.

## Integración técnica pendiente
Este documento define el alcance funcional. El ZIP actual conserva los flujos existentes de pasajero/conductor y el backend actual; todavía requiere implementar y probar la selección de los tres perfiles, OTP sin contraseña en todos los roles, correo obligatorio, perfil comercial con mapa/horarios/catálogo, tablas y endpoints comerciales, revisión administrativa completa y las nuevas rutas de navegación. No activar producción hasta implementar y probar esos componentes, revisar requisitos legales locales y compilar en Android Studio.


## Avance implementado en esta entrega

- La pantalla de registro permite elegir pasajero, conductor o comercio.
- El registro solicita correo electrónico y valida el formato en el cliente y en la API.
- La API acepta únicamente los roles públicos `pasajero`, `conductor` y `comercio`; no permite asignar `admin` ni `soporte`.
- El correo se guarda en `usuarios.email`, columna que ya existe en el esquema SQL base, y se normaliza a minúsculas.
- Se manejan conflictos de teléfono y correo duplicados.
- Las cuentas con rol `comercio` ya no entran por error a la pantalla de pasajero: se muestra una pantalla provisional que informa los pasos comerciales pendientes.

## Pendiente explícito

La ficha del comercio (nombre comercial, ubicación, horario), revisión administrativa y catálogo/pedidos aún no están conectados a endpoints ni a tablas propias. La pantalla de comercio es informativa, no un formulario de alta operativa. Tampoco se ha compilado el proyecto Android en Android Studio en este entorno.
