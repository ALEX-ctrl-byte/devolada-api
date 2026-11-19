-- De Volada: cambio de puntos a operaciones internas.
-- Modelo nuevo: Bs 2 = 1 operación; viajes/envíos/ventas consumen 1 operación.
-- EJECUTAR UNA SOLA VEZ, CON RESPALDO PREVIO, en la base devolada.
-- Compatible con MySQL 8.0.
-- La conversión y su marcador quedan en una sola transacción para permitir rollback.

START TRANSACTION;

SET @operaciones_migracion_pendiente := NOT EXISTS (
  SELECT 1 FROM configuracion
   WHERE clave = 'modelo_operaciones_v1' AND valor = 'aplicado'
);

-- Los saldos prepago y saldos de comisión anteriores estaban expresados en PTS.
-- Se convierten a operaciones enteras, redondeando hacia abajo para no crear fracciones.
-- Las reservas se recalculan más abajo contando servicios vigentes; no se divide el
-- acumulado antiguo porque sus importes podían ser comisiones monetarias fraccionarias.
UPDATE billeteras
   SET saldo_prepago = FLOOR(saldo_prepago / 2),
       saldo_comision_reservado = 0
 WHERE @operaciones_migracion_pendiente = 1;

UPDATE empresas
   SET saldo_comision = FLOOR(saldo_comision / 2),
       saldo_comision_reservado = 0
 WHERE @operaciones_migracion_pendiente = 1;

-- No se reescriben los libros históricos de movimientos: contienen puntos/valores del
-- modelo anterior y sus checks exigen que saldo_antes + monto = saldo_despues.
-- La API muestra en el historial operativo únicamente movimientos posteriores a la
-- fecha de activación del marcador modelo_operaciones_v1; las recargas históricas siguen
-- disponibles en su historial separado, expresadas en Bs y con su equivalencia.

-- Comisiones históricas/reservas de servicio: una unidad por cada servicio o venta.
UPDATE viajes SET comision_monto = 1
 WHERE comision_reservada = 1
   AND estado IN ('aceptado','conductor_llego','en_curso','requiere_revision')
   AND @operaciones_migracion_pendiente = 1;

UPDATE envios SET comision_monto = 1
 WHERE comision_reservada = 1
   AND estado IN ('asignado','recogido','en_camino','en_punto_entrega','requiere_revision')
   AND @operaciones_migracion_pendiente = 1;

UPDATE pedidos SET
       comision_monto = CASE WHEN comision_delivery_reservada = 1 THEN 1 ELSE comision_monto END,
       comision_venta_monto = CASE WHEN comision_venta_reservada = 1 THEN 1 ELSE comision_venta_monto END
 WHERE (comision_delivery_reservada = 1 OR comision_venta_reservada = 1)
   AND estado IN ('creado','buscando_repartidor','asignado','recogido','en_camino','requiere_revision')
   AND @operaciones_migracion_pendiente = 1;

-- Reconstruir reservas exactas: una unidad por servicio activo con reserva marcada.
-- Incluye los servicios en revisión para que no se liberen operaciones por error.
UPDATE billeteras b
JOIN conductores c ON c.id = b.conductor_id
   SET b.saldo_comision_reservado = LEAST(
       b.saldo_prepago,
       (SELECT COUNT(*) FROM viajes v
         WHERE v.conductor_id = c.id AND v.comision_reservada = 1
           AND v.estado IN ('aceptado','conductor_llego','en_curso','requiere_revision'))
     + (SELECT COUNT(*) FROM pedidos p
         WHERE p.conductor_id = c.id AND p.comision_delivery_reservada = 1
           AND p.estado IN ('asignado','recogido','en_camino','requiere_revision'))
     + (SELECT COUNT(*) FROM envios e
         WHERE e.conductor_id = c.id AND e.comision_reservada = 1
           AND e.estado IN ('asignado','recogido','en_camino','en_punto_entrega','requiere_revision'))
   )
 WHERE @operaciones_migracion_pendiente = 1;

UPDATE empresas e
   SET e.saldo_comision_reservado = LEAST(
       e.saldo_comision,
       (SELECT COUNT(*) FROM pedidos p
         WHERE p.empresa_id = e.id AND p.comision_venta_reservada = 1
           AND p.estado IN ('creado','buscando_repartidor','asignado','recogido','en_camino','requiere_revision'))
   )
 WHERE @operaciones_migracion_pendiente = 1;

-- Recargas: el campo monto sigue representando bolivianos realmente depositados.
-- No se divide: el panel/API calcula operaciones_a_acreditar = monto / 2.
-- Las solicitudes antiguas pendientes que no cumplan múltiplos de Bs 2 deben rechazarse
-- desde el panel y volver a solicitarse con el nuevo mínimo.

-- No se borra billeteras_pasajero para conservar integridad e historial. La API nueva
-- no la expone ni admite rol pasajero en /operaciones o /billetera.

UPDATE configuracion
   SET valor = '1', descripcion = 'Mínimo de operaciones disponibles para aceptar servicios (no es un monto monetario)'
 WHERE clave = 'saldo_minimo_operativo_bs' AND @operaciones_migracion_pendiente = 1;

UPDATE configuracion
   SET valor = '0', descripcion = 'Deshabilitado: De Volada no admite retiros de dinero ni de operaciones'
 WHERE clave = 'retiro_minimo_bs' AND @operaciones_migracion_pendiente = 1;

INSERT INTO configuracion (clave, valor, descripcion)
VALUES ('modelo_operaciones_v1', 'aplicado', 'Migración aplicada: Bs 2 = 1 operación; 1 operación por viaje, envío/delivery o venta completada')
ON DUPLICATE KEY UPDATE valor = IF(valor = 'aplicado', valor, 'aplicado'),
                        descripcion = VALUES(descripcion);

COMMIT;

SELECT 'Migración de operaciones completada (o ya aplicada).' AS resultado;
