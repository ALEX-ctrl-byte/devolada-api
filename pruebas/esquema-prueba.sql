-- SOLO PARA PRUEBAS. Reproduce las tablas y columnas que usa la API (tomadas del código de la Etapa 8)
-- en una base TEMPORAL llamada deuna_prueba_tiempo_real. NO es tu esquema v2 ni toca la base "deuna".
DROP DATABASE IF EXISTS deuna_prueba_tiempo_real;
CREATE DATABASE deuna_prueba_tiempo_real CHARACTER SET utf8mb4;
USE deuna_prueba_tiempo_real;

CREATE TABLE ciudades (id SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, nombre VARCHAR(80), departamento VARCHAR(40), activa TINYINT(1) DEFAULT 1);
CREATE TABLE configuracion (clave VARCHAR(60) PRIMARY KEY, valor VARCHAR(100) NOT NULL, descripcion VARCHAR(255) NULL);
CREATE TABLE usuarios (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, telefono VARCHAR(20) UNIQUE, nombre VARCHAR(80), apellido VARCHAR(80) NULL,
  rol ENUM('pasajero','conductor','admin') NOT NULL, estado VARCHAR(20) NOT NULL DEFAULT 'activo',
  ciudad_id SMALLINT UNSIGNED NULL, sexo VARCHAR(20) NULL, fecha_nacimiento DATE NULL,
  restringido_hasta DATETIME NULL, restriccion_motivo VARCHAR(255) NULL);
CREATE TABLE sesiones (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, usuario_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE, expira_en DATETIME NOT NULL, revocada_en DATETIME NULL);
CREATE TABLE conductores (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, usuario_id BIGINT UNSIGNED NOT NULL UNIQUE,
  estado_aprobacion VARCHAR(20) NOT NULL DEFAULT 'aprobado', estado_operativo VARCHAR(20) NOT NULL DEFAULT 'offline',
  licencia_vence_en DATE NULL, total_viajes INT NOT NULL DEFAULT 0);
CREATE TABLE motos (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, conductor_id BIGINT UNSIGNED NOT NULL, placa VARCHAR(12), marca VARCHAR(40), modelo VARCHAR(40), color VARCHAR(30) NULL);
CREATE TABLE billeteras (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, conductor_id BIGINT UNSIGNED NOT NULL UNIQUE,
  saldo_prepago DECIMAL(10,2) NOT NULL DEFAULT 0, estado VARCHAR(20) NOT NULL DEFAULT 'activa');
CREATE TABLE documentos_conductor (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, conductor_id BIGINT UNSIGNED NOT NULL,
  tipo VARCHAR(30) NOT NULL, estado VARCHAR(20) NOT NULL, vence_en DATE NULL);
CREATE TABLE conductor_ubicacion (conductor_id BIGINT UNSIGNED PRIMARY KEY, latitud DECIMAL(10,7) NOT NULL, longitud DECIMAL(10,7) NOT NULL,
  rumbo_grados SMALLINT NULL, precision_m DECIMAL(8,2) NULL, es_mock TINYINT(1) NOT NULL DEFAULT 0, actualizado_en DATETIME(3) NOT NULL);
CREATE TABLE viajes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, pasajero_id BIGINT UNSIGNED NOT NULL, conductor_id BIGINT UNSIGNED NULL, moto_id BIGINT UNSIGNED NULL,
  estado ENUM('solicitado','aceptado','conductor_llego','en_curso','finalizado','cancelado_pasajero','cancelado_conductor','expirado') NOT NULL,
  origen_lat DECIMAL(10,7), origen_lng DECIMAL(10,7), origen_direccion VARCHAR(255) NULL,
  destino_lat DECIMAL(10,7), destino_lng DECIMAL(10,7), destino_direccion VARCHAR(255) NULL,
  distancia_m INT, duracion_estimada_s INT, tarifa_estimada DECIMAL(10,2), tarifa_final DECIMAL(10,2) NULL,
  comision_porcentaje DECIMAL(5,2), comision_monto DECIMAL(10,2) NULL, ganancia_conductor DECIMAL(10,2) NULL,
  metodo_pago VARCHAR(12), idempotency_key VARCHAR(64), motivo_cancelacion VARCHAR(255) NULL,
  solicitado_en DATETIME, aceptado_en DATETIME NULL, llegada_en DATETIME NULL, casco_confirmado_en DATETIME NULL,
  iniciado_en DATETIME NULL, finalizado_en DATETIME NULL, cancelado_en DATETIME NULL,
  UNIQUE KEY uq_idem (pasajero_id, idempotency_key));
CREATE TABLE ubicaciones_viaje (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, viaje_id BIGINT UNSIGNED NOT NULL,
  latitud DECIMAL(10,7), longitud DECIMAL(10,7), precision_m DECIMAL(8,2) NULL, rumbo_grados SMALLINT NULL, registrado_en DATETIME(3));
INSERT INTO configuracion (clave, valor) VALUES ('tarifa_base_bs','5'),('tarifa_por_km_bs','2'),('comision_porcentaje','10'),
 ('validez_cotizacion_s','120'),('saldo_minimo_operativo_bs','5'),('radio_busqueda_km','3'),('ubicacion_max_antiguedad_s','30'),
 ('tolerancia_llegada_m','150'),('cancelaciones_max_dia','3'),('restriccion_cancelaciones_h','24');
