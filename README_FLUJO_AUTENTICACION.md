# DEUNA API — flujo correcto de registro e inicio de sesión

Esta versión implementa el flujo de autenticación alineado con el diseño DEUNA:

## Crear una cuenta
1. La app permite elegir `pasajero`, `conductor` o `comercio`.
2. Se introduce un celular boliviano.
3. La app llama a `POST /otp/solicitar` con `{ "telefono": "+5917XXXXXXX", "proposito": "registro" }`.
4. En desarrollo (`OTP_PROVEEDOR=consola`) el OTP aparece en la terminal de Node.js.
5. La app llama a `POST /otp/verificar` con `telefono`, `codigo` y `proposito="registro"`. La API devuelve un `ticket_registro` firmado, con vencimiento de 15 minutos; todavía no crea la cuenta.
6. La persona completa nombre, apellidos, correo, fecha de nacimiento, género y aceptación de términos.
7. La app llama a `POST /registro` con los datos anteriores, `rol` y `ticket_registro`. La API crea la cuenta verificada y devuelve una sesión. Se crea un único usuario por número de celular.
8. Android guarda el token y dirige a la persona al paso que corresponda a su rol. Si falta ciudad, se pide completar ese dato; después se abre el flujo de pasajero, conductor o comercio.

## Iniciar sesión
1. Introducir el celular registrado.
2. La app solicita OTP con `proposito="login"`.
3. Al verificarlo, la API devuelve sesión y perfil.
4. Android dirige al perfil correspondiente según el rol almacenado en la base de datos (no según el rol elegido durante un registro nuevo).

## Comprobar el servidor
En la raíz de `deuna-api` ejecutar `npm run dev`. La consola debe mostrar el puerto configurado. Probar en el navegador local:

- `http://localhost:3000/salud`
- `http://localhost:3000/api/health`

Ambas rutas deben devolver `ok: true` y `base_datos: "conectada"` cuando el servidor y MySQL estén disponibles. Si estas rutas devuelven `NO_ENCONTRADO`, se está consultando otro proceso/puerto o se está ejecutando una versión antigua de la API; no es una respuesta esperada de esta versión.

## Cloudflare y Android
`trycloudflare.com` suele usar una dirección temporal. Usa la dirección HTTPS que muestra la consola de `cloudflared` cuando el túnel está activo y pégala en `ApiConfig.kt` como `BASE_URL`, terminando en `/` y sin añadir `/salud`. El origen del túnel debe apuntar al mismo puerto de Node mostrado por `npm run dev` (normalmente `http://localhost:3000`).

No importes ni ejecutes ningún archivo SQL para aplicar este cambio. El flujo usa las tablas existentes `usuarios`, `otp` y `sesiones`.
