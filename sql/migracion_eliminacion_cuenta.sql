-- DeUna: eliminación de cuenta desde la app (requisito de Google Play).
-- 1) Agrega el valor 'eliminado' a usuarios.estado si la columna es ENUM y aún no lo tiene.
-- 2) Agrega usuarios.eliminado_en para saber cuándo se anonimizó la cuenta.
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
  @tipo_actual LIKE 'enum(%' AND @tipo_actual NOT LIKE '%''eliminado''%',
  CONCAT(
    'ALTER TABLE usuarios MODIFY COLUMN estado ',
    CONCAT(LEFT(@tipo_actual, CHAR_LENGTH(@tipo_actual) - 1), ',''eliminado'')'),
    IF(@nulo_actual = 'NO', ' NOT NULL', ' NULL'),
    IF(@default_actual IS NULL, '', CONCAT(' DEFAULT ''', REPLACE(@default_actual, '''', ''), ''''))
  ),
  'SELECT ''usuarios.estado ya admite eliminado (o no es ENUM); sin cambios'' AS aviso'
);
PREPARE deuna_stmt FROM @sql_estado; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @sql_col = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'eliminado_en'),
  'SELECT ''usuarios.eliminado_en ya existe'' AS aviso',
  'ALTER TABLE usuarios ADD COLUMN eliminado_en DATETIME NULL'
);
PREPARE deuna_stmt FROM @sql_col; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- Verificación: estado debe incluir 'eliminado'.
SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME IN ('estado', 'eliminado_en');
