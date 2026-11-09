-- Migración ADITIVA de DEUNA (no elimina tablas ni datos).
-- Ejecutar en la base existente `deuna` una sola vez desde HeidiSQL/phpMyAdmin.
USE devolada;

-- Asegura que exista la tabla de comercios sin reemplazar ni borrar una existente.
CREATE TABLE IF NOT EXISTS empresas (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id BIGINT UNSIGNED NOT NULL,
  nombre_comercial VARCHAR(150) NOT NULL,
  logo_url VARCHAR(500) NULL,
  razon_social VARCHAR(150) NULL,
  nit VARCHAR(20) NULL,
  rubro VARCHAR(80) NULL,
  telefono_contacto VARCHAR(20) NULL,
  direccion VARCHAR(255) NOT NULL,
  latitud DECIMAL(10,7) NULL,
  longitud DECIMAL(10,7) NULL,
  estado_aprobacion ENUM('pendiente','aprobado','rechazado','suspendido') NOT NULL DEFAULT 'pendiente',
  aprobado_por BIGINT UNSIGNED NULL,
  aprobado_en DATETIME NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_empresas_usuario (usuario_id),
  KEY idx_empresas_estado (estado_aprobacion),
  CONSTRAINT fk_empresas_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
  CONSTRAINT fk_empresas_aprobado FOREIGN KEY (aprobado_por) REFERENCES usuarios(id)
) ENGINE=InnoDB;

-- Añade la imagen/logo del comercio solo si todavía no existe la columna.
SET @sql_logo = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'empresas' AND COLUMN_NAME = 'logo_url') = 0,
  'ALTER TABLE empresas ADD COLUMN logo_url VARCHAR(500) NULL AFTER nombre_comercial',
  'SELECT 1'
);
PREPARE stmt_logo FROM @sql_logo; EXECUTE stmt_logo; DEALLOCATE PREPARE stmt_logo;

-- Crea los componentes del perfil comercial solo si faltan. No elimina datos existentes.
CREATE TABLE IF NOT EXISTS comercio_horarios (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id BIGINT UNSIGNED NOT NULL,
  dia_semana TINYINT UNSIGNED NOT NULL COMMENT '1=lunes ... 7=domingo',
  abre TIME NULL,
  cierra TIME NULL,
  cerrado TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_comercio_dia (empresa_id, dia_semana),
  CONSTRAINT fk_horarios_empresa FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE,
  CONSTRAINT chk_horario_dia CHECK (dia_semana BETWEEN 1 AND 7),
  CONSTRAINT chk_horario_horas CHECK (cerrado = 1 OR (abre IS NOT NULL AND cierra IS NOT NULL AND abre <> cierra))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS productos_comercio (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id BIGINT UNSIGNED NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  descripcion VARCHAR(500) NULL,
  categoria VARCHAR(80) NULL,
  precio DECIMAL(12,2) NOT NULL,
  stock INT UNSIGNED NULL COMMENT 'NULL = inventario no controlado',
  imagen_url VARCHAR(500) NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_productos_empresa_activo (empresa_id, activo),
  CONSTRAINT fk_productos_empresa FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE,
  CONSTRAINT chk_producto_precio CHECK (precio >= 0),
  CONSTRAINT chk_producto_stock CHECK (stock IS NULL OR stock >= 0)
) ENGINE=InnoDB;

-- Amplía los tipos de documento para diferenciar licencia por ambas caras y selfie sosteniéndola.
-- Conserva los tipos antiguos para no invalidar documentos ya guardados.
SET @tipo_actual = (SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'documentos_conductor' AND COLUMN_NAME = 'tipo');
SET @sql_tipo = IF(
  @tipo_actual IS NULL,
  'SELECT 1',
  IF(
    LOCATE('licencia_frente', @tipo_actual) = 0 OR LOCATE('licencia_reverso', @tipo_actual) = 0 OR LOCATE('selfie_licencia', @tipo_actual) = 0 OR LOCATE('foto_placa', @tipo_actual) = 0 OR LOCATE('foto_moto', @tipo_actual) = 0,
    'ALTER TABLE documentos_conductor MODIFY COLUMN tipo ENUM(''ci_frente'',''ci_reverso'',''licencia'',''licencia_frente'',''licencia_reverso'',''selfie'',''selfie_licencia'',''soat'',''tarjeta_propiedad'',''foto_placa'',''foto_moto'',''antecedentes'') NOT NULL',
    'SELECT 1'
  )
);
PREPARE stmt_tipo FROM @sql_tipo; EXECUTE stmt_tipo; DEALLOCATE PREPARE stmt_tipo;

SELECT 'Migración DEUNA aplicada o ya estaba aplicada. No se han borrado datos.' AS resultado;
