-- DeUna: deja la base LIMPIA conservando solo las cuentas admin
-- y la configuración (ciudades, configuracion/tarifas).
-- ¡IRREVERSIBLE! Haz antes una copia: phpMyAdmin > Exportar.
-- Ejecutar en phpMyAdmin > pestaña SQL, con la base devolada seleccionada.

DROP PROCEDURE IF EXISTS deuna_limpiar;
DELIMITER $$
CREATE PROCEDURE deuna_limpiar()
BEGIN
  DECLARE fin INT DEFAULT 0;
  DECLARE t VARCHAR(64);
  DECLARE c CURSOR FOR
    SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
       AND TABLE_NAME NOT IN ('usuarios', 'ciudades', 'configuracion', 'tarifas', 'ajustes');
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET fin = 1;

  SET FOREIGN_KEY_CHECKS = 0;
  OPEN c;
  bucle: LOOP
    FETCH c INTO t;
    IF fin = 1 THEN LEAVE bucle; END IF;
    SET @q = CONCAT('DELETE FROM `', t, '`');
    PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
    SET @q = CONCAT('ALTER TABLE `', t, '` AUTO_INCREMENT = 1');
    PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
  END LOOP;
  CLOSE c;

  DELETE FROM usuarios WHERE rol <> 'admin';
  SET FOREIGN_KEY_CHECKS = 1;
END$$
DELIMITER ;

CALL deuna_limpiar();
DROP PROCEDURE deuna_limpiar;

-- Comprobación: debe mostrar solo el/los admin.
SELECT id, nombre, telefono, rol, estado FROM usuarios;
