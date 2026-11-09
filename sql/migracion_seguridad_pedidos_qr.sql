-- DEUNA: refuerzo de pedidos, reembolsos y vencimiento de QR bancario.
-- MySQL 8.0. Ejecutar una sola vez sobre la base `devolada` (el script tolera columnas ya existentes).
USE devolada;

-- Reservas de pedidos pendientes expiran después de 15 minutos.
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='expira_en'),
 'SELECT ''pedidos.expira_en ya existe'' AS resultado',
 'ALTER TABLE pedidos ADD COLUMN expira_en DATETIME NULL AFTER idempotency_key');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- Estado administrativo de reembolso para pagos QR ya recibidos.
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='estado_reembolso'),
 'SELECT ''pedidos.estado_reembolso ya existe'' AS resultado',
 'ALTER TABLE pedidos ADD COLUMN estado_reembolso ENUM(''no_aplica'',''pendiente'',''reembolsado'') NOT NULL DEFAULT ''no_aplica'' AFTER expira_en');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='referencia_reembolso'),
 'SELECT ''pedidos.referencia_reembolso ya existe'' AS resultado',
 'ALTER TABLE pedidos ADD COLUMN referencia_reembolso VARCHAR(100) NULL AFTER estado_reembolso');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='reembolso_solicitado_en'),
 'SELECT ''pedidos.reembolso_solicitado_en ya existe'' AS resultado',
 'ALTER TABLE pedidos ADD COLUMN reembolso_solicitado_en DATETIME NULL AFTER referencia_reembolso');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='reembolso_en'),
 'SELECT ''pedidos.reembolso_en ya existe'' AS resultado',
 'ALTER TABLE pedidos ADD COLUMN reembolso_en DATETIME NULL AFTER reembolso_solicitado_en');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='revision_motivo'),
 'SELECT ''pedidos.revision_motivo ya existe'' AS resultado',
 'ALTER TABLE pedidos ADD COLUMN revision_motivo VARCHAR(255) NULL AFTER reembolso_en');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND COLUMN_NAME='revision_en'),
 'SELECT ''pedidos.revision_en ya existe'' AS resultado',
 'ALTER TABLE pedidos ADD COLUMN revision_en DATETIME NULL AFTER revision_motivo');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- El estado `reembolso_pendiente` mantiene visible el pedido en la cola del comercio.
ALTER TABLE pedidos MODIFY COLUMN estado ENUM('creado','aceptado_comercio','buscando_repartidor','asignado','recogido','en_camino','entregado','cancelado','fallido','requiere_revision','recogido_legacy','reembolso_pendiente') NOT NULL DEFAULT 'creado';

-- El QR de cada receptor caduca un año después de subirlo o reemplazarlo.
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='empresas' AND COLUMN_NAME='qr_pago_subido_en'),
 'SELECT ''empresas.qr_pago_subido_en ya existe'' AS resultado',
 'ALTER TABLE empresas ADD COLUMN qr_pago_subido_en DATETIME NULL');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='empresas' AND COLUMN_NAME='qr_pago_vence_en'),
 'SELECT ''empresas.qr_pago_vence_en ya existe'' AS resultado',
 'ALTER TABLE empresas ADD COLUMN qr_pago_vence_en DATETIME NULL');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='conductores' AND COLUMN_NAME='qr_pago_subido_en'),
 'SELECT ''conductores.qr_pago_subido_en ya existe'' AS resultado',
 'ALTER TABLE conductores ADD COLUMN qr_pago_subido_en DATETIME NULL');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='conductores' AND COLUMN_NAME='qr_pago_vence_en'),
 'SELECT ''conductores.qr_pago_vence_en ya existe'' AS resultado',
 'ALTER TABLE conductores ADD COLUMN qr_pago_vence_en DATETIME NULL');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- Los QR que ya estaban guardados se consideran subidos al ejecutar la migración y vencen en un año.
UPDATE empresas SET qr_pago_subido_en=COALESCE(qr_pago_subido_en,UTC_TIMESTAMP()),
 qr_pago_vence_en=COALESCE(qr_pago_vence_en,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 YEAR))
 WHERE qr_pago_url IS NOT NULL AND TRIM(qr_pago_url)<>'';
UPDATE conductores SET qr_pago_subido_en=COALESCE(qr_pago_subido_en,UTC_TIMESTAMP()),
 qr_pago_vence_en=COALESCE(qr_pago_vence_en,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 YEAR))
 WHERE qr_pago_url IS NOT NULL AND TRIM(qr_pago_url)<>'';

SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pedidos' AND INDEX_NAME='idx_pedidos_estado_expira'),
 'SELECT ''idx_pedidos_estado_expira ya existe'' AS resultado',
 'CREATE INDEX idx_pedidos_estado_expira ON pedidos (estado, expira_en)');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- Reservar la comisión del viaje al aceptarlo evita que pedidos concurrentes gasten ese saldo.
SET @deuna_sql = IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='viajes' AND COLUMN_NAME='comision_reservada'),
 'SELECT ''viajes.comision_reservada ya existe'' AS resultado',
 'ALTER TABLE viajes ADD COLUMN comision_reservada TINYINT(1) NOT NULL DEFAULT 0 AFTER comision_monto');
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- Un pedido en revisión de liquidación sigue ocupando el viaje activo del pasajero/conductor.
ALTER TABLE viajes MODIFY COLUMN conductor_activo_id BIGINT UNSIGNED AS (IF(estado IN ('aceptado','conductor_llego','en_curso','requiere_revision'),conductor_id,NULL)) STORED;
ALTER TABLE viajes MODIFY COLUMN pasajero_activo_id BIGINT UNSIGNED AS (IF(estado IN ('solicitado','aceptado','conductor_llego','en_curso','requiere_revision'),pasajero_id,NULL)) STORED;

SELECT 'Migración de seguridad de pedidos y vigencia de QR lista.' AS resultado;
