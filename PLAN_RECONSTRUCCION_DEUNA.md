# DEUNA — plan seguro de reconstrucción

## Estado de partida
- La base que el usuario indica que ya utiliza se llama `deuna`.
- La API Node/Express consulta MySQL; Android no debe conectarse directamente a MySQL.
- Android usa Retrofit/OkHttp, Compose, Mapbox y Socket.IO. Se conserva esta arquitectura y la URL HTTPS del túnel se mantiene en `ApiConfig.kt`.
- No se debe ejecutar el dump completo `sql/deuna_completo_laragon.sql` sobre la base actual porque elimina y recrea `deuna`.

## Orden de trabajo
1. Hacer copia de seguridad desde Laragon/phpMyAdmin.
2. Ejecutar solo `sql/auditoria_estructura_deuna.sql` y guardar el resultado.
3. Ejecutar `npm run check` y `npm run doctor` desde `deuna-api`.
4. Probar registro/OTP/login local con proveedor `consola`.
5. Configurar WhatsApp Cloud API con credenciales y plantilla aprobada antes de declarar OTP real operativo.
6. Confirmar la URL activa de Cloudflare y actualizar una sola constante `ApiConfig.BASE_URL` en Android si el Quick Tunnel cambió.
7. Abrir el proyecto Android con JDK 17 o posterior y ejecutar Sync/Build desde Android Studio.
8. Validar por separado pasajero, conductor y comercio; el rol de cuenta no equivale a aprobación de conductor ni sustituye el perfil comercial.

## No se considera terminado hasta
- `GET /salud` informa que la base es accesible.
- `npm run doctor` pasa para las tablas/columnas mínimas.
- Se registra cada rol, se recibe/verifica OTP y la respuesta devuelve el rol correcto.
- El token de sesión se guarda y se puede revocar.
- Android compila en el entorno del usuario y se prueba en un teléfono real a través del túnel HTTPS.
- WhatsApp entrega un mensaje real usando la plantilla aprobada; el modo consola no cuenta como OTP real.
