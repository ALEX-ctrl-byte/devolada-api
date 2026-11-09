-- DEUNA - Saldo prepago exclusivo para comisiones + QR directo del receptor
-- MySQL 8.0+. Ejecutar una vez sobre la base `devolada` desde HeidiSQL.
-- No acredita dinero. Las recargas se acreditan únicamente tras verificación manual.
USE devolada;

-- QR personal del conductor para recibir directamente de pasajeros.
SET @deuna_sql = IF(
  EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='conductores' AND COLUMN_NAME='qr_pago_url'),
  'SELECT ''conductores.qr_pago_url ya existe'' AS resultado',
  'ALTER TABLE conductores ADD COLUMN qr_pago_url VARCHAR(500) NULL'
);
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

-- QR personal/empresarial del comercio y saldo exclusivamente para comisiones.
SET @deuna_sql = IF(
  EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='empresas' AND COLUMN_NAME='qr_pago_url'),
  'SELECT ''empresas.qr_pago_url ya existe'' AS resultado',
  'ALTER TABLE empresas ADD COLUMN qr_pago_url VARCHAR(500) NULL'
);
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

SET @deuna_sql = IF(
  EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='empresas' AND COLUMN_NAME='saldo_comision'),
  'SELECT ''empresas.saldo_comision ya existe'' AS resultado',
  'ALTER TABLE empresas ADD COLUMN saldo_comision DECIMAL(12,2) NOT NULL DEFAULT 0.00'
);
PREPARE deuna_stmt FROM @deuna_sql; EXECUTE deuna_stmt; DEALLOCATE PREPARE deuna_stmt;

CREATE TABLE IF NOT EXISTS movimientos_comision_comercio (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  empresa_id BIGINT UNSIGNED NOT NULL,
  tipo ENUM('recarga','comision_venta','ajuste','reverso') NOT NULL,
  monto DECIMAL(12,2) NOT NULL COMMENT 'Firmado: recarga positivo; comisión negativo',
  saldo_antes DECIMAL(12,2) NOT NULL,
  saldo_despues DECIMAL(12,2) NOT NULL,
  pedido_id BIGINT UNSIGNED NULL,
  recarga_id BIGINT UNSIGNED NULL,
  descripcion VARCHAR(255) NULL,
  idempotency_key VARCHAR(100) NOT NULL,
  creado_por BIGINT UNSIGNED NULL,
  creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mov_comision_comercio_idempotencia (empresa_id, idempotency_key),
  KEY idx_mov_comision_comercio_fecha (empresa_id, creado_en),
  CONSTRAINT fk_mov_comision_empresa FOREIGN KEY (empresa_id) REFERENCES empresas(id),
  CONSTRAINT fk_mov_comision_pedido FOREIGN KEY (pedido_id) REFERENCES pedidos(id),
  CONSTRAINT fk_mov_comision_recarga FOREIGN KEY (recarga_id) REFERENCES recargas_billetera(id),
  CONSTRAINT fk_mov_comision_creador FOREIGN KEY (creado_por) REFERENCES usuarios(id),
  CONSTRAINT chk_mov_comision_monto CHECK (monto <> 0),
  CONSTRAINT chk_mov_comision_saldo CHECK (saldo_despues >= 0),
  CONSTRAINT chk_mov_comision_cuadre CHECK (saldo_despues = saldo_antes + monto)
) ENGINE=InnoDB;

-- Comisiones diferentes para transporte, delivery y productos vendidos.
INSERT INTO configuracion (clave, valor, descripcion) VALUES
  ('comision_porcentaje_venta', '10.00', 'Comisión DEUNA sobre el subtotal de productos vendidos (%)'),
  ('comision_porcentaje_delivery', '10.00', 'Comisión DEUNA sobre la tarifa del delivery (%)')
ON DUPLICATE KEY UPDATE clave=VALUES(clave);

DELIMITER $$
DROP TRIGGER IF EXISTS trg_mov_comision_comercio_no_update$$
CREATE TRIGGER trg_mov_comision_comercio_no_update BEFORE UPDATE ON movimientos_comision_comercio
FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'movimientos_comision_comercio es inmutable';
END$$
DROP TRIGGER IF EXISTS trg_mov_comision_comercio_no_delete$$
CREATE TRIGGER trg_mov_comision_comercio_no_delete BEFORE DELETE ON movimientos_comision_comercio
FOR EACH ROW BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'movimientos_comision_comercio es inmutable';
END$$
DELIMITER ;

SELECT 'Migración lista: QR directo y saldo de comisiones para comercios/conductores.' AS resultado;
