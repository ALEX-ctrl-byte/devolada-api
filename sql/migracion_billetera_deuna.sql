-- =====================================================================
-- DEUNA - Migracion de billetera del pasajero (compatible con HeidiSQL)
-- Requiere MySQL 8.0.16 o superior. Base destino: devolada.
-- No elimina tablas ni datos. No acredita dinero a ninguna cuenta.
-- Ejecutar todo el archivo desde una pestaña de consulta de HeidiSQL.
-- =====================================================================

USE `devolada`;

-- 1. Billetera de cada pasajero. El saldo inicial siempre es cero.
CREATE TABLE IF NOT EXISTS `billeteras_pasajero` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `usuario_id` BIGINT UNSIGNED NOT NULL,
  `saldo` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `estado` ENUM('activa','pausada','bloqueada') NOT NULL DEFAULT 'activa',
  `creado_en` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_en` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deuna_billetera_pasajero_usuario` (`usuario_id`),
  CONSTRAINT `fk_deuna_billetera_pasajero_usuario`
    FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_deuna_billetera_pasajero_saldo` CHECK (`saldo` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Solicitudes de recarga. Una recarga queda pendiente hasta que el
-- administrador verifique el ingreso real y la confirme desde el panel.
CREATE TABLE IF NOT EXISTS `recargas_billetera` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `usuario_id` BIGINT UNSIGNED NOT NULL,
  `monto` DECIMAL(12,2) NOT NULL,
  `metodo` ENUM('qr','transferencia') NOT NULL,
  `referencia_cliente` VARCHAR(100) NULL,
  `referencia_pago` VARCHAR(100) NULL,
  `estado` ENUM('pendiente','confirmada','rechazada') NOT NULL DEFAULT 'pendiente',
  `idempotency_key` VARCHAR(64) NOT NULL,
  `motivo_revision` VARCHAR(255) NULL,
  `revisado_por` BIGINT UNSIGNED NULL,
  `solicitado_en` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revisado_en` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deuna_recarga_idempotencia` (`usuario_id`, `idempotency_key`),
  KEY `idx_deuna_recargas_estado_fecha` (`estado`, `solicitado_en`),
  KEY `idx_deuna_recargas_usuario_fecha` (`usuario_id`, `solicitado_en`),
  CONSTRAINT `fk_deuna_recarga_usuario`
    FOREIGN KEY (`usuario_id`) REFERENCES `usuarios` (`id`),
  CONSTRAINT `fk_deuna_recarga_revisor`
    FOREIGN KEY (`revisado_por`) REFERENCES `usuarios` (`id`),
  CONSTRAINT `chk_deuna_recarga_monto` CHECK (`monto` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Libro de movimientos del pasajero. El saldo antes/despues permite
-- auditar cada cambio. La clave idempotente impide duplicar el movimiento.
CREATE TABLE IF NOT EXISTS `movimientos_billetera_pasajero` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `billetera_id` BIGINT UNSIGNED NOT NULL,
  `tipo` ENUM('recarga','pago_viaje','reembolso','ajuste') NOT NULL,
  `monto` DECIMAL(12,2) NOT NULL COMMENT 'Positivo acredita; negativo debita',
  `saldo_antes` DECIMAL(12,2) NOT NULL,
  `saldo_despues` DECIMAL(12,2) NOT NULL,
  `viaje_id` BIGINT UNSIGNED NULL,
  `recarga_id` BIGINT UNSIGNED NULL,
  `descripcion` VARCHAR(255) NULL,
  `idempotency_key` VARCHAR(80) NOT NULL,
  `creado_en` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_deuna_mov_pasajero_idempotencia` (`billetera_id`, `idempotency_key`),
  KEY `idx_deuna_mov_pasajero_fecha` (`billetera_id`, `creado_en`),
  KEY `idx_deuna_mov_pasajero_viaje` (`viaje_id`),
  CONSTRAINT `fk_deuna_mov_pasajero_billetera`
    FOREIGN KEY (`billetera_id`) REFERENCES `billeteras_pasajero` (`id`),
  CONSTRAINT `fk_deuna_mov_pasajero_viaje`
    FOREIGN KEY (`viaje_id`) REFERENCES `viajes` (`id`),
  CONSTRAINT `fk_deuna_mov_pasajero_recarga`
    FOREIGN KEY (`recarga_id`) REFERENCES `recargas_billetera` (`id`),
  CONSTRAINT `chk_deuna_mov_pasajero_monto` CHECK (`monto` <> 0),
  CONSTRAINT `chk_deuna_mov_pasajero_saldo` CHECK (`saldo_despues` >= 0),
  CONSTRAINT `chk_deuna_mov_pasajero_cuadre` CHECK (`saldo_despues` = `saldo_antes` + `monto`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Crear billeteras vacias para pasajeros que ya existen.
-- INSERT IGNORE evita duplicar usuarios que ya tengan billetera.
INSERT IGNORE INTO `billeteras_pasajero` (`usuario_id`)
SELECT `id` FROM `usuarios` WHERE `rol` = 'pasajero';

-- 5. Libro inmutable: los triggers usan un solo statement cada uno.
-- No se usa DELIMITER, para poder ejecutar desde HeidiSQL sin cambiarlo.
DROP TRIGGER IF EXISTS `trg_mov_pasajero_no_update`;
CREATE TRIGGER `trg_mov_pasajero_no_update`
BEFORE UPDATE ON `movimientos_billetera_pasajero`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'movimientos_billetera_pasajero es inmutable';

DROP TRIGGER IF EXISTS `trg_mov_pasajero_no_delete`;
CREATE TRIGGER `trg_mov_pasajero_no_delete`
BEFORE DELETE ON `movimientos_billetera_pasajero`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'movimientos_billetera_pasajero es inmutable';

-- 6. Verificacion final. Debe mostrar OK para las tres tablas.
SELECT 'billeteras_pasajero' AS tabla,
       IF(EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'billeteras_pasajero'), 'OK', 'FALTA') AS resultado
UNION ALL
SELECT 'recargas_billetera',
       IF(EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'recargas_billetera'), 'OK', 'FALTA')
UNION ALL
SELECT 'movimientos_billetera_pasajero',
       IF(EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'movimientos_billetera_pasajero'), 'OK', 'FALTA');

SELECT COUNT(*) AS pasajeros_sin_billetera
FROM `usuarios` u
LEFT JOIN `billeteras_pasajero` b ON b.usuario_id = u.id
WHERE u.rol = 'pasajero' AND b.id IS NULL;
