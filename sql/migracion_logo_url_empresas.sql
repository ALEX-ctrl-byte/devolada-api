-- Correccion DEUNA: falta empresas.logo_url.
-- Compatible con MySQL 8.0; no elimina ni modifica datos existentes.
-- Ejecutar en HeidiSQL seleccionando la base de datos `deuna`.

USE devolada;

SET @deuna_logo_url_sql = IF(
  EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'empresas'
      AND COLUMN_NAME = 'logo_url'
  ),
  'SELECT ''La columna empresas.logo_url ya existe; no se hicieron cambios.'' AS resultado',
  'ALTER TABLE empresas ADD COLUMN logo_url VARCHAR(500) NULL AFTER nombre_comercial'
);

PREPARE deuna_logo_url_stmt FROM @deuna_logo_url_sql;
EXECUTE deuna_logo_url_stmt;
DEALLOCATE PREPARE deuna_logo_url_stmt;

SELECT 'Correccion aplicada: empresas.logo_url esta disponible.' AS resultado;
