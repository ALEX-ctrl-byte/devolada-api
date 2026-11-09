-- DEUNA: soporte, calificaciones, clasificación de vehículos y envíos persona-a-persona.
-- Migración aditiva: no elimina tablas ni registros existentes. Respaldar la BD antes de aplicar.
USE devolada;

-- Tipo de vehículo compartiendo la estructura actual para evitar romper claves de viajes/pedidos.
SET @sql_tipo_vehiculo = IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='motos' AND COLUMN_NAME='tipo_vehiculo'),
  'SELECT ''motos.tipo_vehiculo ya existe'' AS resultado',
  'ALTER TABLE motos ADD COLUMN tipo_vehiculo ENUM(''moto'',''auto'') NOT NULL DEFAULT ''moto'' AFTER conductor_id'
);
PREPARE deuna_stmt FROM @sql_tipo_vehiculo; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;


-- Reservas de comisión del conductor (si la base aún no tiene la columna aditiva).
SET @sql_saldo_reservado = IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='billeteras' AND COLUMN_NAME='saldo_comision_reservado'),
  'SELECT ''billeteras.saldo_comision_reservado ya existe'' AS resultado',
  'ALTER TABLE billeteras ADD COLUMN saldo_comision_reservado DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER saldo_ganancias'
);
PREPARE deuna_stmt FROM @sql_saldo_reservado; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- Los autos requieren evidencias diferentes, pero conservamos los tipos existentes.
SET @tipo_docs_actual = (SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='documentos_conductor' AND COLUMN_NAME='tipo');
SET @sql_docs_auto = IF(
  @tipo_docs_actual IS NOT NULL
    AND LOCATE('foto_auto_frente', @tipo_docs_actual) > 0
    AND LOCATE('foto_auto_atras', @tipo_docs_actual) > 0
    AND LOCATE('foto_auto_lateral', @tipo_docs_actual) > 0
    AND LOCATE('ruat', @tipo_docs_actual) > 0,
  'SELECT ''tipos de documento para auto ya existen'' AS resultado',
  'ALTER TABLE documentos_conductor MODIFY COLUMN tipo ENUM(''ci_frente'',''ci_reverso'',''licencia'',''licencia_frente'',''licencia_reverso'',''selfie'',''selfie_licencia'',''soat'',''tarjeta_propiedad'',''foto_placa'',''foto_moto'',''foto_auto_frente'',''foto_auto_atras'',''foto_auto_lateral'',''ruat'',''antecedentes'') NOT NULL'
);
PREPARE deuna_stmt FROM @sql_docs_auto; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

CREATE TABLE IF NOT EXISTS calificaciones_comercio (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pedido_id BIGINT UNSIGNED NOT NULL,
  calificador_id BIGINT UNSIGNED NOT NULL,
  empresa_id BIGINT UNSIGNED NOT NULL,
  puntaje TINYINT UNSIGNED NOT NULL,
  comentario VARCHAR(500) NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_calif_comercio_pedido_usuario (pedido_id, calificador_id),
  KEY idx_calif_comercio_empresa (empresa_id, creado_en),
  CONSTRAINT fk_calif_comercio_pedido FOREIGN KEY (pedido_id) REFERENCES pedidos(id),
  CONSTRAINT fk_calif_comercio_usuario FOREIGN KEY (calificador_id) REFERENCES usuarios(id),
  CONSTRAINT fk_calif_comercio_empresa FOREIGN KEY (empresa_id) REFERENCES empresas(id),
  CONSTRAINT chk_calif_comercio_puntaje CHECK (puntaje BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS calificaciones_app (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id BIGINT UNSIGNED NOT NULL,
  app_version VARCHAR(30) NOT NULL DEFAULT 'desconocida',
  puntaje TINYINT UNSIGNED NOT NULL,
  comentario VARCHAR(500) NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_calif_app_usuario_version (usuario_id, app_version),
  KEY idx_calif_app_fecha (creado_en),
  CONSTRAINT fk_calif_app_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
  CONSTRAINT chk_calif_app_puntaje CHECK (puntaje BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS envios (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  remitente_id BIGINT UNSIGNED NOT NULL,
  destinatario_id BIGINT UNSIGNED NOT NULL,
  conductor_id BIGINT UNSIGNED NULL,
  tipo_vehiculo ENUM('moto','auto') NOT NULL DEFAULT 'moto',
  descripcion_paquete VARCHAR(255) NOT NULL,
  recogida_nombre VARCHAR(120) NOT NULL,
  recogida_telefono VARCHAR(20) NOT NULL,
  recogida_direccion VARCHAR(255) NOT NULL,
  recogida_lat DECIMAL(10,7) NOT NULL,
  recogida_lng DECIMAL(10,7) NOT NULL,
  entrega_nombre VARCHAR(120) NOT NULL,
  entrega_telefono VARCHAR(20) NOT NULL,
  entrega_direccion VARCHAR(255) NOT NULL,
  entrega_lat DECIMAL(10,7) NOT NULL,
  entrega_lng DECIMAL(10,7) NOT NULL,
  distancia_m INT UNSIGNED NULL,
  tarifa_estimada DECIMAL(12,2) NOT NULL,
  metodo_pago ENUM('efectivo','qr') NOT NULL DEFAULT 'efectivo',
  comision_porcentaje DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  comision_monto DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  estado ENUM('solicitado','asignado','recogido','en_camino','en_punto_entrega','entregado','cancelado','requiere_revision') NOT NULL DEFAULT 'solicitado',
  codigo_recogida_hash CHAR(64) NOT NULL,
  codigo_recogida_cifrado VARCHAR(200) NOT NULL,
  intentos_codigo_recogida TINYINT UNSIGNED NOT NULL DEFAULT 0,
  codigo_entrega_hash CHAR(64) NULL,
  codigo_entrega_cifrado VARCHAR(200) NULL,
  codigo_entrega_expira_en DATETIME NULL,
  qr_conductor_snapshot VARCHAR(500) NULL,
  comision_reservada TINYINT(1) NOT NULL DEFAULT 0,
  asignado_en DATETIME NULL,
  intentos_codigo_entrega TINYINT UNSIGNED NOT NULL DEFAULT 0,
  recogido_en DATETIME NULL,
  llegada_en DATETIME NULL,
  entregado_en DATETIME NULL,
  idempotency_key VARCHAR(64) NOT NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_envio_idempotencia (remitente_id, idempotency_key),
  KEY idx_envios_reparto (estado, tipo_vehiculo, creado_en),
  KEY idx_envios_remitente (remitente_id, creado_en),
  KEY idx_envios_destinatario (destinatario_id, estado, creado_en),
  KEY idx_envios_conductor (conductor_id, estado),
  CONSTRAINT fk_envios_remitente FOREIGN KEY (remitente_id) REFERENCES usuarios(id),
  CONSTRAINT fk_envios_destinatario FOREIGN KEY (destinatario_id) REFERENCES usuarios(id),
  CONSTRAINT fk_envios_conductor FOREIGN KEY (conductor_id) REFERENCES conductores(id),
  CONSTRAINT chk_envios_tarifa CHECK (tarifa_estimada > 0),
  CONSTRAINT chk_envios_comision CHECK (comision_monto >= 0),
  CONSTRAINT chk_envios_codigo_intentos CHECK (intentos_codigo_entrega <= 5),
  CONSTRAINT chk_envios_recogida_intentos CHECK (intentos_codigo_recogida <= 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Compatibilidad si la tabla envios ya existía de un intento anterior de migración.
SET @sql_envio_metodo_pago = IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='envios' AND COLUMN_NAME='metodo_pago'),
  'SELECT ''envios.metodo_pago ya existe'' AS resultado',
  'ALTER TABLE envios ADD COLUMN metodo_pago ENUM(''efectivo'',''qr'') NOT NULL DEFAULT ''efectivo'' AFTER tarifa_estimada'
);
PREPARE deuna_stmt FROM @sql_envio_metodo_pago; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

CREATE TABLE IF NOT EXISTS calificaciones_envios (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  envio_id BIGINT UNSIGNED NOT NULL,
  calificador_id BIGINT UNSIGNED NOT NULL,
  calificado_id BIGINT UNSIGNED NOT NULL,
  puntaje TINYINT UNSIGNED NOT NULL,
  comentario VARCHAR(500) NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_calif_envio_usuario (envio_id, calificador_id),
  KEY idx_calif_envio_conductor (calificado_id, creado_en),
  CONSTRAINT fk_calif_envio_envio FOREIGN KEY (envio_id) REFERENCES envios(id),
  CONSTRAINT fk_calif_envio_calificador FOREIGN KEY (calificador_id) REFERENCES usuarios(id),
  CONSTRAINT fk_calif_envio_calificado FOREIGN KEY (calificado_id) REFERENCES usuarios(id),
  CONSTRAINT chk_calif_envio_puntaje CHECK (puntaje BETWEEN 1 AND 5),
  CONSTRAINT chk_calif_envio_distintos CHECK (calificador_id <> calificado_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Permite que soporte se vincule de manera segura al envío propio del usuario.
SET @sql_reclamos_envio_id = IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='reclamos' AND COLUMN_NAME='envio_id'),
  'SELECT ''reclamos.envio_id ya existe'' AS resultado',
  'ALTER TABLE reclamos ADD COLUMN envio_id BIGINT UNSIGNED NULL AFTER pedido_id'
);
PREPARE deuna_stmt FROM @sql_reclamos_envio_id; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @sql_reclamos_envio_fk = IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='reclamos' AND CONSTRAINT_NAME='fk_reclamos_envio'),
  'SELECT ''fk_reclamos_envio ya existe'' AS resultado',
  'ALTER TABLE reclamos ADD CONSTRAINT fk_reclamos_envio FOREIGN KEY (envio_id) REFERENCES envios(id)'
);
PREPARE deuna_stmt FROM @sql_reclamos_envio_fk; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @sql_reclamos_categoria = IF(
  EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='reclamos' AND COLUMN_NAME='categoria' AND LOCATE('envio', COLUMN_TYPE) > 0),
  'SELECT ''reclamos.categoria ya admite envio'' AS resultado',
  'ALTER TABLE reclamos MODIFY COLUMN categoria ENUM(''cobro'',''conducta'',''seguridad'',''objeto_perdido'',''app'',''envio'',''otro'') NOT NULL DEFAULT ''otro'''
);
PREPARE deuna_stmt FROM @sql_reclamos_categoria; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SELECT 'Migración de soporte, calificaciones, vehículos y envíos creada. Verifica el resultado antes de probar.' AS resultado;
