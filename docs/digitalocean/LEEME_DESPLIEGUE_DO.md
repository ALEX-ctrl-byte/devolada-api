# Despliegue de De Volada en DigitalOcean (App Platform + MySQL administrado)

MySQL en App Platform exige un clúster administrado ya creado (`production: true`).
Una base "de desarrollo" solo existe para PostgreSQL.

## 1. Clúster, base y usuario (una sola vez)
```bash
doctl databases create devolada-mysql --engine mysql --version 8 --region nyc3 --size db-s-1vcpu-1gb
doctl databases list                                   # copia el ID del clúster
doctl databases db create   <CLUSTER_ID> devolada
doctl databases user create <CLUSTER_ID> devolada_api
```
(Verifica en el panel de DO el precio del clúster antes de crearlo.)

## 2. Crear la app y autorizarla en el clúster
```bash
doctl apps create --spec .do/app.yaml
doctl apps list                                        # copia el ID de la app
doctl databases firewalls append <CLUSTER_ID> --rule app:<APP_ID>
```
Sin este paso la API no puede conectarse ("Connection refused" / timeout).

## 3. Cargar el esquema y las migraciones (desde tu PC)
Autoriza tu IP un momento: `doctl databases firewalls append <CLUSTER_ID> --rule ip_addr:<TU_IP>`

Primero tu **esquema base** (las tablas `usuarios`, `viajes`, etc.). Ese archivo
(`deuna_completo_laragon.sql`) NO viene en este zip. Antes de cargarlo en DO:
- BORRA las líneas `DROP DATABASE IF EXISTS ...` y `CREATE DATABASE ...` (la base ya existe y
  esa línea podría borrar datos).
- Cambia `USE deuna` por `USE devolada`.

Luego, en este orden (`sql/`):
```
migracion_etapa4.sql                  migracion_soporte_calificaciones_vehiculos_envios.sql
migracion_etapa5_perfil.sql           migracion_tarifas_dinamicas_enteras.sql
migracion_registro_y_documentos.sql   migracion_ciudades_lanzamiento.sql
migracion_billetera_deuna.sql         migracion_aprobacion_manual_usuarios.sql
migracion_saldo_comision_y_qr_directo.sql   migracion_pin_login.sql
migracion_seguridad_pedidos_qr.sql    migracion_eliminacion_cuenta.sql
migracion_pedidos_comercio_delivery.sql
migracion_logo_url_empresas.sql
```
Ejemplo (usa el host/puerto/usuario que muestra el panel de DO; si hay error de permisos, usa `doadmin`):
```bash
mysql -h <HOST> -P <PUERTO> -u doadmin -p --ssl-mode=REQUIRED devolada < sql/migracion_etapa4.sql
```
NUNCA ejecutes `limpiar_base_dejar_admin.sql` en producción: borra datos.
Al terminar, quita tu IP del firewall del clúster.

## 4. Archivos en DigitalOcean Spaces (obligatorio)
El disco de App Platform se borra en cada despliegue o reinicio: sin esto los conductores perderían sus
documentos y los comercios sus logos. La API guarda los archivos en Spaces cuando `ALMACENAMIENTO_DRIVER=s3`.

1. Panel de DO > Spaces Object Storage > **Create a Space**. Región `nyc3` (la misma de la app).
   Deja **"Restrict File Listing"** activado: el bucket debe ser PRIVADO (la API lo lee con su clave y
   sirve las imágenes de comercios por `/media/comercios/...`).
2. Panel de DO > API > **Spaces Keys** > Generate New Key. Si el panel permite limitar la clave a ese
   bucket, hazlo. Copia la clave y el secreto (el secreto se muestra una sola vez).
3. En `.do/app.yaml` (o en las variables de la app) completa `SPACES_BUCKET`, `SPACES_KEY` y `SPACES_SECRET`.
   `SPACES_ENDPOINT` es `https://<región>.digitaloceanspaces.com` SIN el nombre del bucket y SIN barra final.
4. Si algo está mal escrito, la API **no arranca** y el log dice qué variable falla.

Verifica el precio de Spaces en el panel antes de crearlo.

## 5. Secretos
Cambia en DO (tipo SECRET): `OTP_SECRET` (32+ caracteres aleatorios), `STADIA_MAPS_API_KEY`
(clave NUEVA), `SPACES_KEY`, `SPACES_SECRET`, `QR_RECARGA_DEUNA_URL` y `WHATSAPP_BUSINESS_NUMBER`.
