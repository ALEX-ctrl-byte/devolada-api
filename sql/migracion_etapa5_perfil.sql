-- Etapa 5: perfil (ciudad, fecha de nacimiento, sexo) y límites anti-abuso
-- EJECUTAR UNA SOLA VEZ (MySQL 8 no admite ADD COLUMN IF NOT EXISTS).
USE devolada;

CREATE TABLE IF NOT EXISTS ciudades (
  id           SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  nombre       VARCHAR(80) NOT NULL,
  departamento VARCHAR(40) NULL,
  activa       TINYINT(1)  NOT NULL DEFAULT 1,   -- ciudades donde DeUna opera
  PRIMARY KEY (id),
  UNIQUE KEY uq_ciudades_nombre (nombre)
) ENGINE=InnoDB;

-- Lista provisional: marca activa = 0 las ciudades donde aún no opera DeUna
INSERT INTO ciudades (nombre, departamento) VALUES
  ('La Paz', 'La Paz'),
  ('El Alto', 'La Paz'),
  ('Cochabamba', 'Cochabamba'),
  ('Santa Cruz de la Sierra', 'Santa Cruz'),
  ('Sucre', 'Chuquisaca'),
  ('Oruro', 'Oruro'),
  ('Potosí', 'Potosí'),
  ('Tarija', 'Tarija'),
  ('Trinidad', 'Beni'),
  ('Cobija', 'Pando')
ON DUPLICATE KEY UPDATE nombre = nombre;

ALTER TABLE usuarios
  ADD COLUMN fecha_nacimiento DATE NULL AFTER apellido,
  ADD COLUMN sexo ENUM('femenino','masculino','prefiero_no_decir') NULL AFTER fecha_nacimiento,
  ADD COLUMN ciudad_id SMALLINT UNSIGNED NULL AFTER sexo,
  ADD COLUMN ip_registro VARCHAR(45) NULL AFTER fcm_token,
  ADD KEY idx_usuarios_ciudad (ciudad_id),
  ADD KEY idx_usuarios_ip_registro (ip_registro, creado_en),
  ADD CONSTRAINT fk_usuarios_ciudad FOREIGN KEY (ciudad_id) REFERENCES ciudades (id);

INSERT INTO configuracion (clave, valor, descripcion) VALUES
  ('edad_minima',             '18',  'Edad mínima para usar DeUna (años) - PROVISIONAL'),
  ('otp_max_por_ip_hora',     '15',  'Máximo de códigos OTP por IP por hora'),
  ('registro_max_por_ip_hora','10',  'Máximo de registros nuevos por IP por hora'),
  ('otp_max_diarios_global',  '300', 'Tope diario de códigos enviados en total (freno de gasto)')
ON DUPLICATE KEY UPDATE clave = clave;
