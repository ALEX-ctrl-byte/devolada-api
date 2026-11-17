-- De Volada: cobro independiente del valor del paquete y registros de Firebase Cloud Messaging.
-- Ejecutar UNA SOLA VEZ en MySQL de Railway, después de hacer backup.
-- Las columnas se agregan de forma idempotente para poder revisar/reintentar sin duplicarlas.

SET @db := DATABASE();

SET @q := IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='envios' AND COLUMN_NAME='cobra_paquete')=0,
  'ALTER TABLE envios ADD COLUMN cobra_paquete TINYINT(1) NOT NULL DEFAULT 0 AFTER metodo_pago', 'SELECT ''envios.cobra_paquete ya existe'''); PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='envios' AND COLUMN_NAME='importe_paquete')=0,
  'ALTER TABLE envios ADD COLUMN importe_paquete DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER cobra_paquete', 'SELECT ''envios.importe_paquete ya existe'''); PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='envios' AND COLUMN_NAME='qr_remitente_archivo')=0,
  'ALTER TABLE envios ADD COLUMN qr_remitente_archivo VARCHAR(40) NULL AFTER importe_paquete', 'SELECT ''envios.qr_remitente_archivo ya existe'''); PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='envios' AND COLUMN_NAME='estado_cobro_paquete')=0,
  'ALTER TABLE envios ADD COLUMN estado_cobro_paquete ENUM(''no_aplica'',''pendiente'',''confirmado'') NOT NULL DEFAULT ''no_aplica'' AFTER qr_remitente_archivo', 'SELECT ''envios.estado_cobro_paquete ya existe'''); PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='envios' AND COLUMN_NAME='paquete_cobrado_en')=0,
  'ALTER TABLE envios ADD COLUMN paquete_cobrado_en DATETIME NULL AFTER estado_cobro_paquete', 'SELECT ''envios.paquete_cobrado_en ya existe'''); PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='envios' AND COLUMN_NAME='estado_cobro_delivery')=0,
  'ALTER TABLE envios ADD COLUMN estado_cobro_delivery ENUM(''no_aplica'',''pendiente'',''confirmado'') NOT NULL DEFAULT ''no_aplica'' AFTER paquete_cobrado_en', 'SELECT ''envios.estado_cobro_delivery ya existe'''); PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='envios' AND COLUMN_NAME='estado_cobro_delivery')=1 AND (SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='envios' AND COLUMN_NAME='estado_cobro_delivery') NOT LIKE '%no_aplica%',
  'ALTER TABLE envios MODIFY COLUMN estado_cobro_delivery ENUM(''no_aplica'',''pendiente'',''confirmado'') NOT NULL DEFAULT ''no_aplica''', 'SELECT ''estado_cobro_delivery compatible'''); PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

SET @q := IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='envios' AND COLUMN_NAME='delivery_cobrado_en')=0,
  'ALTER TABLE envios ADD COLUMN delivery_cobrado_en DATETIME NULL AFTER estado_cobro_delivery', 'SELECT ''envios.delivery_cobrado_en ya existe'''); PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
SET @q := IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@db AND TABLE_NAME='envios' AND COLUMN_NAME='delivery_cobrado_por')=0,
  'ALTER TABLE envios ADD COLUMN delivery_cobrado_por BIGINT UNSIGNED NULL AFTER delivery_cobrado_en', 'SELECT ''envios.delivery_cobrado_por ya existe'''); PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS envios_qr_temporales (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  archivo_nombre VARCHAR(40) NOT NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expira_en DATETIME NOT NULL,
  consumido_en DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_envios_qr_token (token_hash),
  KEY ix_envios_qr_usuario (usuario_id, expira_en),
  CONSTRAINT fk_envios_qr_temporales_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notificaciones_dispositivos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id BIGINT UNSIGNED NOT NULL,
  token VARCHAR(4096) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  plataforma ENUM('android') NOT NULL DEFAULT 'android',
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notificaciones_token_hash (token_hash),
  KEY ix_notificaciones_usuario (usuario_id),
  CONSTRAINT fk_notificaciones_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Para envíos históricos, el nuevo seguimiento de cobros queda no_aplica (sin trazabilidad previa).
-- Los nuevos envíos creados por la API se registran explícitamente como pendiente. No se simulan pagos históricos.
