import { Router } from 'express';
import { registrarUsuario } from './registro.js';
import { errorPin, hashPin } from '../servicios/pin.js';

export const rutaRegistroPin = Router();

// POST /registro-pin
// Registro sin OTP: el usuario define un PIN de 4 dígitos y la cuenta nace 'pendiente'.
// El administrador verifica el teléfono al recibir el WhatsApp de activación y aprueba en el panel.
// Cuerpo: { telefono, pin, nombre, apellido, email, ciudad_id, fecha_nacimiento, sexo, rol, acepto_terminos }
// Respuesta 201: { estado: 'pendiente', usuario, whatsapp_activacion_url, mensaje } (sin token).
rutaRegistroPin.post('/', async (req, res) => {
  const errorDelPin = errorPin(req.body?.pin);
  const pinHash = errorDelPin ? null : await hashPin(req.body.pin);
  return registrarUsuario(req, res, {
    exigirTicket: false,
    pinHash,
    erroresExtra: errorDelPin ? { pin: errorDelPin } : {},
  });
});
