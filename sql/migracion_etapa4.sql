-- Etapa 4: parámetros nuevos (opcional: el código ya trae estos valores por defecto)
USE devolada;
INSERT INTO configuracion (clave, valor, descripcion) VALUES
  ('otp_cooldown_segundos', '60', 'Segundos mínimos entre un código OTP y el siguiente'),
  ('sesion_dias',           '30', 'Duración de una sesión en días')
ON DUPLICATE KEY UPDATE clave = clave;
