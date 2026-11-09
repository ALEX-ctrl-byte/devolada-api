-- DeUna: aprobación manual de cuentas (verificación inicial por WhatsApp + panel admin).
-- Agrega el valor 'rechazado' a usuarios.estado si la columna es ENUM y aún no lo tiene.
-- Conserva el resto de valores, el DEFAULT y la nulabilidad actuales. Se puede ejecutar varias veces.

SET @tipo_actual = (
  SELECT COLUMN_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'estado'
);
SET @default_actual = (
  SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'estado'
);
SET @nulo_actual = (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'estado'
);

SET @sql_estado = IF(
  @tipo_actual LIKE 'enum(%' AND @tipo_actual NOT LIKE '%''rechazado''%',
  CONCAT(
    'ALTER TABLE usuarios MODIFY COLUMN estado ',
    CONCAT(LEFT(@tipo_actual, CHAR_LENGTH(@tipo_actual) - 1), ',''rechazado'')'),
    IF(@nulo_actual = 'NO', ' NOT NULL', ' NULL'),
    IF(@default_actual IS NULL, '', CONCAT(' DEFAULT ''', REPLACE(@default_actual, '''', ''), ''''))
  ),
  'SELECT ''usuarios.estado ya admite rechazado (o no es ENUM); sin cambios'' AS aviso'
);
PREPARE deuna_stmt FROM @sql_estado; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- Verificación: debe incluir 'pendiente', 'activo' y 'rechazado'.
SELECT COLUMN_TYPE, COLUMN_DEFAULT FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'estado';
