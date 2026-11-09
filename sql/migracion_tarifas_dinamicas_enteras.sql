-- DEUNA: motor unificado de tarifas enteras para viajes, envíos personales y delivery.
-- Aplicación segura/aditiva sobre una base existente. NO borra tablas, ni pedidos, ni viajes.
-- Antes de ejecutar: exportar una copia de la base `devolada` desde HeidiSQL.
USE devolada;

-- -----------------------------------------------------------------------------
-- 1) Viajes: guardar el vehículo pedido y una instantánea del cálculo de tarifa.
-- Las columnas nuevas quedan NULL para viajes históricos; no se alteran sus precios.
-- -----------------------------------------------------------------------------
SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='viajes' AND COLUMN_NAME='tipo_vehiculo_solicitado'),
  'SELECT ''viajes.tipo_vehiculo_solicitado ya existe'' AS resultado',
  'ALTER TABLE viajes ADD COLUMN tipo_vehiculo_solicitado ENUM(''moto'',''auto'') NULL DEFAULT NULL AFTER duracion_estimada_s');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='viajes' AND COLUMN_NAME='distancia_aproximacion_m'),
  'SELECT ''viajes.distancia_aproximacion_m ya existe'' AS resultado',
  'ALTER TABLE viajes ADD COLUMN distancia_aproximacion_m INT UNSIGNED NULL AFTER tipo_vehiculo_solicitado');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='viajes' AND COLUMN_NAME='duracion_aproximacion_s'),
  'SELECT ''viajes.duracion_aproximacion_s ya existe'' AS resultado',
  'ALTER TABLE viajes ADD COLUMN duracion_aproximacion_s INT UNSIGNED NULL AFTER distancia_aproximacion_m');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='viajes' AND COLUMN_NAME='detalle_tarifa_json'),
  'SELECT ''viajes.detalle_tarifa_json ya existe'' AS resultado',
  'ALTER TABLE viajes ADD COLUMN detalle_tarifa_json JSON NULL AFTER duracion_aproximacion_s');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- -----------------------------------------------------------------------------
-- 2) Envíos personales: distancia/tiempo de servicio y aproximación al recojo.
-- -----------------------------------------------------------------------------
SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='envios' AND COLUMN_NAME='duracion_estimada_s'),
  'SELECT ''envios.duracion_estimada_s ya existe'' AS resultado',
  'ALTER TABLE envios ADD COLUMN duracion_estimada_s INT UNSIGNED NULL AFTER distancia_m');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='envios' AND COLUMN_NAME='distancia_aproximacion_m'),
  'SELECT ''envios.distancia_aproximacion_m ya existe'' AS resultado',
  'ALTER TABLE envios ADD COLUMN distancia_aproximacion_m INT UNSIGNED NULL AFTER duracion_estimada_s');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='envios' AND COLUMN_NAME='duracion_aproximacion_s'),
  'SELECT ''envios.duracion_aproximacion_s ya existe'' AS resultado',
  'ALTER TABLE envios ADD COLUMN duracion_aproximacion_s INT UNSIGNED NULL AFTER distancia_aproximacion_m');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='envios' AND COLUMN_NAME='detalle_tarifa_json'),
  'SELECT ''envios.detalle_tarifa_json ya existe'' AS resultado',
  'ALTER TABLE envios ADD COLUMN detalle_tarifa_json JSON NULL AFTER duracion_aproximacion_s');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- -----------------------------------------------------------------------------
-- 3) Delivery de comercios: elección explícita de moto/auto y misma tarifa común.
-- Pedidos históricos quedan en moto por compatibilidad; no se cambian sus importes.
-- -----------------------------------------------------------------------------
SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='tipo_vehiculo_delivery'),
  'SELECT ''pedidos.tipo_vehiculo_delivery ya existe'' AS resultado',
  'ALTER TABLE pedidos ADD COLUMN tipo_vehiculo_delivery ENUM(''moto'',''auto'') NOT NULL DEFAULT ''moto'' AFTER estado');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='duracion_estimada_s'),
  'SELECT ''pedidos.duracion_estimada_s ya existe'' AS resultado',
  'ALTER TABLE pedidos ADD COLUMN duracion_estimada_s INT UNSIGNED NULL AFTER distancia_m');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='distancia_aproximacion_m'),
  'SELECT ''pedidos.distancia_aproximacion_m ya existe'' AS resultado',
  'ALTER TABLE pedidos ADD COLUMN distancia_aproximacion_m INT UNSIGNED NULL AFTER duracion_estimada_s');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='duracion_aproximacion_s'),
  'SELECT ''pedidos.duracion_aproximacion_s ya existe'' AS resultado',
  'ALTER TABLE pedidos ADD COLUMN duracion_aproximacion_s INT UNSIGNED NULL AFTER distancia_aproximacion_m');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @ddl = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='detalle_tarifa_json'),
  'SELECT ''pedidos.detalle_tarifa_json ya existe'' AS resultado',
  'ALTER TABLE pedidos ADD COLUMN detalle_tarifa_json JSON NULL AFTER duracion_aproximacion_s');
PREPARE deuna_stmt FROM @ddl; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- -----------------------------------------------------------------------------
-- 4) Parámetros iniciales enteros. Si una clave ya existe, se conserva su VALOR
--    personalizado; solo se refresca la descripción. El motor puede configurarse
--    desde SQL sin reinstalar Android. Valores globales de arranque para Bolivia.
-- -----------------------------------------------------------------------------
INSERT INTO configuracion (clave, valor, descripcion) VALUES
 ('tarifa_base_normal_bs', '4', 'Tarifa base entera por servicio cuando oferta de conductores no es abundante'),
 ('tarifa_base_muchos_conductores_bs', '3', 'Tarifa base entera con muchos conductores disponibles cerca y demanda menor'),
 ('tarifa_umbral_muchos_conductores', '5', 'Número mínimo de conductores compatibles disponibles cercanos para bajar la base'),
 ('tarifa_radio_conductores_km', '3', 'Radio en km para medir conductores disponibles y demanda cercana'),
 ('tarifa_radio_aproximacion_km', '20', 'Radio máximo en km para encontrar al conductor que se acercará al recojo'),
 ('tarifa_ubicacion_max_s', '120', 'Antigüedad máxima del GPS del conductor para contarlo como disponible'),
 ('tarifa_km_moto_bs', '1', 'Precio entero por cada km iniciado de la ruta de servicio en moto'),
 ('tarifa_km_auto_bs', '2', 'Precio entero por cada km iniciado de la ruta de servicio en auto'),
 ('tarifa_tiempo_moto_5min_bs', '1', 'Precio entero por cada bloque iniciado de cinco minutos de servicio en moto'),
 ('tarifa_tiempo_auto_5min_bs', '1', 'Precio entero por cada bloque iniciado de cinco minutos de servicio en auto'),
 ('tarifa_aproximacion_km_moto_bs', '1', 'Precio entero por cada km iniciado de aproximación en moto'),
 ('tarifa_aproximacion_km_auto_bs', '2', 'Precio entero por cada km iniciado de aproximación en auto'),
 ('tarifa_aproximacion_tiempo_moto_5min_bs', '1', 'Precio entero por cada bloque iniciado de cinco minutos de aproximación en moto'),
 ('tarifa_aproximacion_tiempo_auto_5min_bs', '2', 'Precio entero por cada bloque iniciado de cinco minutos de aproximación en auto')
ON DUPLICATE KEY UPDATE descripcion=VALUES(descripcion);

SELECT 'Migración de tarifas dinámicas enteras completada. Revisa columnas y parámetros antes de iniciar la API.' AS resultado;
