-- DeUna: inicio de sesión con teléfono + PIN de 4 dígitos (sin OTP).
-- 1) usuarios.pin_hash: hash bcrypt del PIN (nunca el PIN en claro).
-- 2) intentos_pin: intentos fallidos para limitar a 5 por hora por teléfono (429).
-- Se puede ejecutar varias veces sin error.
--
-- Nota: "ALTER TABLE ... ADD COLUMN IF NOT EXISTS" solo existe en MariaDB; MySQL 8 (Laragon)
-- lo rechaza. Por eso se consulta information_schema y se ejecuta el ALTER solo si falta la columna.
-- En MariaDB equivale a:
--   ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS pin_hash VARCHAR(255) NULL AFTER estado;

SET @sql_pin = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'pin_hash'),
  'SELECT ''usuarios.pin_hash ya existe'' AS aviso',
  'ALTER TABLE usuarios ADD COLUMN pin_hash VARCHAR(255) NULL AFTER estado'
);
PREPARE deuna_stmt FROM @sql_pin; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

CREATE TABLE IF NOT EXISTS intentos_pin (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  telefono VARCHAR(20) NOT NULL,
  ip_origen VARCHAR(45) NULL,
  creado_en DATETIME NOT NULL,
  INDEX idx_intentos_pin_telefono (telefono, creado_en),
  INDEX idx_intentos_pin_ip (ip_origen, creado_en)
) ENGINE=InnoDB; -- usa el juego de caracteres por defecto de la base (igual que usuarios)

-- Limpieza opcional de intentos viejos (no afecta el límite, que mira solo la última hora).
DELETE FROM intentos_pin WHERE creado_en < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY);

-- Verificación
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'pin_hash';
