# DEUNA — Base de datos y módulo de comercios (pruebas locales)

## 1. Crear la base en Laragon

1. Abre Laragon y pulsa **Start All**.
2. Abre **Database** o `http://localhost/phpmyadmin`.
3. En phpMyAdmin selecciona **Importar**.
4. Elige `sql/deuna_completo_laragon.sql` y ejecuta la importación.
5. El script crea la base `deuna` desde cero. **ATENCIÓN: elimina una base existente llamada `deuna` antes de crearla**; úsalo solo para desarrollo y no sobre datos que quieras conservar.
6. Comprueba que aparecen tablas como `usuarios`, `sesiones`, `viajes`, `empresas`, `comercio_horarios`, `productos_comercio` y `pedido_items`.

Requisitos: MySQL 8.0.16 o superior (el esquema usa CHECK, JSON, columnas generadas, vistas y triggers). Si phpMyAdmin no permite importar el archivo completo por límite de tamaño, usa terminal de Laragon:

```bash
mysql -u root -p < sql/deuna_completo_laragon.sql
```

Si el usuario `root` de Laragon no tiene contraseña, cuando la pida pulsa Enter.

## 2. Configurar la API

En la carpeta de la API, copia `.env.example` como `.env` y verifica:

```dotenv
PORT=3000
NODE_ENV=development
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=deuna
DB_USER=root
DB_PASSWORD=
OTP_PROVEEDOR=consola
OTP_SECRET=pon-aqui-una-clave-larga-para-pruebas
STADIA_MAPS_API_KEY=TU_CLAVE_STADIA
STADIA_ROUTING_URL=https://api.stadiamaps.com/route/v1
```

No subas `.env` a Git ni compartas claves. Stadia Maps calcula las rutas mediante Valhalla y resuelve las búsquedas de direcciones desde la API. Revisa que el plan de tu cuenta permita la API de rutas.

Desde la carpeta `deuna-api` ejecuta:

```bash
npm install
npm run check
npm run dev
```

Prueba la API local en `http://127.0.0.1:3000/salud`.

## 3. Mantener Cloudflare Tunnel y configurar rutas

La API ahora usa OSRM para calcular rutas y Stadia Maps para geocodificación. La URL Android se configura desde `DeUna/local.properties` mediante `DEUNA_API_BASE_URL`; así puedes cambiar el Quick Tunnel sin tocar Kotlin. Cloudflare Quick Tunnel normalmente asigna otra URL cuando se reinicia; cuando ocurra, actualiza también `PUBLIC_API_URL` en `.env`:

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

Debe terminar en `/` y no incluir `/salud`. No necesitas cambiar Stadia Maps ni el cálculo de rutas para actualizar Cloudflare: son servicios distintos. Nota: la representación visual de los mapas en Android aún está en proceso de migración a MapLibre; hasta completar esa etapa, algunos componentes visuales conservan Mapbox.

## 4. Endpoints de comercio

Todos requieren `Authorization: Bearer <token>` de una sesión activa cuyo rol en base de datos sea `comercio`.

- `GET /comercio/perfil` — obtiene perfil y horarios; si no existe perfil, devuelve `perfil: null`.
- `PUT /comercio/perfil` — crea o actualiza nombre comercial, rubro, teléfono, dirección, coordenadas y horarios. `dia_semana`: 1=lunes ... 7=domingo.
- `GET /comercio/productos` — lista el catálogo del comercio autenticado.
- `POST /comercio/productos` — crea un producto (`nombre`, `precio`; opcional `descripcion`, `categoria`, `stock`, `imagen_url`).
- `PUT /comercio/productos/:id` — actualiza un producto del propio comercio.
- `DELETE /comercio/productos/:id` — desactiva lógicamente el producto; no elimina el historial.

Ejemplo de `PUT /comercio/perfil`:

```json
{
  "nombre_comercial": "Mi tienda",
  "rubro": "Abarrotes",
  "telefono_contacto": "71234567",
  "direccion": "Av. ejemplo, La Paz",
  "latitud": -16.5000,
  "longitud": -68.1500,
  "horarios": [
    {"dia_semana":1,"abre":"08:00","cierra":"20:00","cerrado":false},
    {"dia_semana":7,"cerrado":true}
  ]
}
```

La pantalla Android de comercio permite guardar el perfil/horario y añadir/desactivar productos. Las coordenadas se introducen manualmente en esta etapa; el selector de ubicación para comercios ya existe; su migración visual de Mapbox a MapLibre forma parte del siguiente paso.

## 5. Limitaciones de esta etapa

Esta guía corresponde a una etapa anterior y su lista de funciones quedó superada. En el paquete actual existe el flujo API de pedidos/comisiones y el panel administrativo está integrado; antes de operar, ejecuta las migraciones que falten y sigue `GUIA_ULTIMA_PRUEBA_DEUNA.md`. El estado inicial del comercio continúa siendo `pendiente` hasta aprobarlo.
