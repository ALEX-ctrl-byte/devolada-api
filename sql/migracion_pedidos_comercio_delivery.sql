-- DEUNA: circuito de pedidos de comercio + delivery y comisiones prepago reservadas.
-- MySQL 8.0. Ejecutar una vez sobre la base `devolada`.
-- No borra datos ni acredita dinero; las confirmaciones de QR directo son manuales por el receptor.
USE devolada;

-- El saldo reservado no se descuenta del saldo contable hasta entregar el pedido;
-- solo evita gastar la misma comisión en otra operación concurrente.
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='empresas' AND COLUMN_NAME='saldo_comision_reservado'),
 'SELECT ''empresas.saldo_comision_reservado ya existe'' AS resultado',
 'ALTER TABLE empresas ADD COLUMN saldo_comision_reservado DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER saldo_comision');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='billeteras' AND COLUMN_NAME='saldo_comision_reservado'),
 'SELECT ''billeteras.saldo_comision_reservado ya existe'' AS resultado',
 'ALTER TABLE billeteras ADD COLUMN saldo_comision_reservado DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER saldo_prepago');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- Añadir campos al pedido existente sin eliminar columnas históricas.
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='pasajero_id'), 'SELECT ''pedidos.pasajero_id ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN pasajero_id BIGINT UNSIGNED NULL AFTER empresa_id');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='subtotal_productos'), 'SELECT ''subtotal_productos ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN subtotal_productos DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER monto_a_cobrar');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='metodo_pago_producto'), 'SELECT ''metodo_pago_producto ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN metodo_pago_producto ENUM(''efectivo'',''qr'') NOT NULL DEFAULT ''efectivo'' AFTER subtotal_productos');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='metodo_pago_delivery'), 'SELECT ''metodo_pago_delivery ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN metodo_pago_delivery ENUM(''efectivo'',''qr'') NOT NULL DEFAULT ''efectivo'' AFTER metodo_pago_producto');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='estado_pago_producto'), 'SELECT ''estado_pago_producto ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN estado_pago_producto ENUM(''pendiente'',''confirmado'',''liquidacion_pendiente'') NOT NULL DEFAULT ''pendiente'' AFTER metodo_pago_delivery');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='estado_pago_delivery'), 'SELECT ''estado_pago_delivery ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN estado_pago_delivery ENUM(''pendiente'',''confirmado'') NOT NULL DEFAULT ''pendiente'' AFTER estado_pago_producto');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='comision_venta_porcentaje'), 'SELECT ''comision_venta_porcentaje ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN comision_venta_porcentaje DECIMAL(5,2) NOT NULL DEFAULT 10.00 AFTER comision_porcentaje');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='comision_venta_monto'), 'SELECT ''comision_venta_monto ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN comision_venta_monto DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER comision_venta_porcentaje');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='comision_venta_reservada'), 'SELECT ''comision_venta_reservada ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN comision_venta_reservada TINYINT(1) NOT NULL DEFAULT 0 AFTER comision_venta_monto');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='comision_delivery_reservada'), 'SELECT ''comision_delivery_reservada ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN comision_delivery_reservada TINYINT(1) NOT NULL DEFAULT 0 AFTER comision_venta_reservada');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='qr_comercio_snapshot'), 'SELECT ''qr_comercio_snapshot ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN qr_comercio_snapshot VARCHAR(500) NULL AFTER comision_delivery_reservada');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='qr_conductor_snapshot'), 'SELECT ''qr_conductor_snapshot ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN qr_conductor_snapshot VARCHAR(500) NULL AFTER qr_comercio_snapshot');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='pagado_producto_en'), 'SELECT ''pagado_producto_en ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN pagado_producto_en DATETIME NULL AFTER qr_conductor_snapshot');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='pagado_delivery_en'), 'SELECT ''pagado_delivery_en ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN pagado_delivery_en DATETIME NULL AFTER pagado_producto_en');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='liquidacion_comercio_en'), 'SELECT ''liquidacion_comercio_en ya existe'' AS resultado', 'ALTER TABLE pedidos ADD COLUMN liquidacion_comercio_en DATETIME NULL AFTER pagado_delivery_en');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- Estados compatibles con registros previos más los nuevos pasos de comercio y delivery.
ALTER TABLE pedidos MODIFY COLUMN estado ENUM('creado','aceptado_comercio','buscando_repartidor','asignado','recogido','en_camino','entregado','cancelado','fallido','requiere_revision','recogido_legacy') NOT NULL DEFAULT 'creado';

SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND INDEX_NAME='idx_pedidos_pasajero_fecha'), 'SELECT ''idx_pedidos_pasajero_fecha ya existe'' AS resultado', 'CREATE INDEX idx_pedidos_pasajero_fecha ON pedidos (pasajero_id, creado_en)');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND CONSTRAINT_NAME='fk_pedidos_pasajero'), 'SELECT ''fk_pedidos_pasajero ya existe'' AS resultado', 'ALTER TABLE pedidos ADD CONSTRAINT fk_pedidos_pasajero FOREIGN KEY (pasajero_id) REFERENCES usuarios(id)');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

INSERT INTO configuracion (clave, valor, descripcion) VALUES
 ('comision_porcentaje_venta','10.00','Comisión sobre subtotal de productos vendidos (%)'),
 ('comision_porcentaje_delivery','10.00','Comisión sobre tarifa de delivery (%)'),
 ('tarifa_delivery_base_bs','5.00','Tarifa mínima de delivery en Bs (provisional)'),
 ('tarifa_delivery_por_km_bs','2.00','Costo por km de delivery en Bs (provisional)'),
 ('radio_busqueda_delivery_km','5','Radio máximo de búsqueda de repartidores (km)')
ON DUPLICATE KEY UPDATE descripcion=VALUES(descripcion);

-- Todos los conductores existentes parten con cero reservado; no altera su saldo real.
UPDATE billeteras SET saldo_comision_reservado=0 WHERE saldo_comision_reservado IS NULL;
UPDATE empresas SET saldo_comision_reservado=0 WHERE saldo_comision_reservado IS NULL;

SELECT 'Migración pedidos y delivery lista. Reinicia la API después de ejecutarla.' AS resultado;
