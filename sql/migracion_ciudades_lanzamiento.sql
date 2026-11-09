-- DEUNA: área inicial de operación.
-- Migración ADITIVA y segura: no borra ciudades ni datos de usuarios.
-- La Paz y El Alto quedan activas; las demás ciudades se conservan preparadas, pero ocultas/inactivas.
-- Ejecutar sobre la base existente `deuna`, después de tener la tabla ciudades.
USE devolada;

INSERT INTO ciudades (nombre, departamento, activa) VALUES
  ('La Paz', 'La Paz', 1),
  ('El Alto', 'La Paz', 1),
  ('Cochabamba', 'Cochabamba', 0),
  ('Santa Cruz de la Sierra', 'Santa Cruz', 0)
ON DUPLICATE KEY UPDATE
  departamento = VALUES(departamento);

UPDATE ciudades
   SET activa = CASE WHEN nombre IN ('La Paz', 'El Alto') THEN 1 ELSE 0 END;

SELECT id, nombre, departamento, activa
  FROM ciudades
 ORDER BY activa DESC, nombre ASC;
