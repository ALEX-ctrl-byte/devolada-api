import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';
import { detectarImagen, guardarDocumento, borrarDocumento, guardarImagenComercio, borrarImagenComercio } from '../servicios/almacenamiento.js';
import { config } from '../config.js';

export const rutaConductor = Router();

const TIPOS_REQUERIDOS_MOTO = [
  'ci_frente', 'ci_reverso', 'selfie', 'licencia_frente', 'licencia_reverso', 'selfie_licencia', 'soat', 'tarjeta_propiedad', 'foto_placa', 'foto_moto',
];
const TIPOS_REQUERIDOS_AUTO = [
  'ci_frente', 'ci_reverso', 'selfie', 'licencia_frente', 'licencia_reverso', 'selfie_licencia', 'soat', 'tarjeta_propiedad', 'foto_placa', 'foto_auto_frente', 'foto_auto_atras', 'foto_auto_lateral', 'ruat',
];
export const TIPOS_REQUERIDOS = TIPOS_REQUERIDOS_MOTO; // Compatibilidad con consumidores anteriores.
const TIPOS = [...new Set([...TIPOS_REQUERIDOS_MOTO, ...TIPOS_REQUERIDOS_AUTO, 'licencia', 'antecedentes'])];
const requeridosParaVehiculo = (tipo) => tipo === 'auto' ? TIPOS_REQUERIDOS_AUTO : TIPOS_REQUERIDOS_MOTO;
const CON_VENCIMIENTO = ['licencia_frente', 'licencia', 'soat'];
const MAX_BYTES = 5 * 1024 * 1024;

/** Fecha de hoy en Bolivia (UTC-4), "YYYY-MM-DD". */
const hoyBolivia = () => new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10);

// Solo una cuenta con rol "conductor" puede postular. (El rol solo indica intención: conducir
// requiere además la aprobación del administrador, que se verifica en las etapas de viajes.)
function soloConductor(req, res, next) {
  if (req.usuario.rol !== 'conductor') {
    return error(res, 403, 'NO_ES_CONDUCTOR', 'Esta función es solo para cuentas de conductor.');
  }
  next();
}
const base = [autenticar, soloConductor];

async function conTransaccion(fn) {
  const cx = await db.getConnection();
  try {
    await cx.beginTransaction();
    const r = await fn(cx);
    await cx.commit();
    return r;
  } catch (e) {
    await cx.rollback().catch(() => {});
    throw e;
  } finally {
    cx.release();
  }
}

// ---------------------------------------------------------------------
// POST /conductor/postulacion
// { documento_identidad, licencia_numero, licencia_categoria,
//   moto: { placa, marca, modelo, anio?, color?, cilindrada_cc? } }
// Crea la postulación (conductor + moto + billetera en cero) o la corrige mientras
// esté 'pendiente' o 'rechazada'. En revisión o aprobada no se puede modificar.
// ---------------------------------------------------------------------
rutaConductor.post('/postulacion', ...base, async (req, res) => {
  const b = req.body ?? {};
  const m = b.moto ?? {};
  const tipoVehiculo = String(b.tipo_vehiculo ?? m.tipo_vehiculo ?? 'moto');
  const errores = {};
  if (!['moto', 'auto'].includes(tipoVehiculo)) errores.tipo_vehiculo = 'Selecciona moto o auto.';

  if (!req.usuario.perfil_completo) {
    return error(res, 409, 'PERFIL_INCOMPLETO', 'Completa tu perfil (ciudad, fecha de nacimiento y sexo) antes de postular.');
  }

  const ci = String(b.documento_identidad ?? '').toUpperCase().replace(/\s+/g, '');
  if (!/^\d{5,10}(-?[0-9A-Z]{1,2})?$/.test(ci)) errores.documento_identidad = 'Ingresa un número de cédula válido.';

  const licNum = String(b.licencia_numero ?? '').toUpperCase().replace(/\s+/g, '');
  if (!/^[0-9A-Z-]{4,30}$/.test(licNum)) errores.licencia_numero = 'Ingresa el número de tu licencia.';

  const licCat = String(b.licencia_categoria ?? '').toUpperCase().trim();
  if (!/^[A-Z]{1,3}$/.test(licCat)) errores.licencia_categoria = 'Ingresa la categoría de tu licencia (ej. A, B, M).';

  const placa = String(m.placa ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[0-9A-Z]{5,10}$/.test(placa)) errores['moto.placa'] = 'Ingresa una placa válida.';

  const marca = String(m.marca ?? '').trim();
  if (marca.length < 2 || marca.length > 50) errores['moto.marca'] = 'Ingresa la marca de la moto.';
  const modelo = String(m.modelo ?? '').trim();
  if (modelo.length < 1 || modelo.length > 50) errores['moto.modelo'] = 'Ingresa el modelo de la moto.';

  let anio = null;
  if (m.anio !== undefined && m.anio !== null && m.anio !== '') {
    anio = Number(m.anio);
    const maxAnio = new Date().getUTCFullYear() + 1;
    if (!Number.isInteger(anio) || anio < 1980 || anio > maxAnio) errores['moto.anio'] = 'El año no es válido.';
  }
  let cc = null;
  if (tipoVehiculo === 'moto' && m.cilindrada_cc !== undefined && m.cilindrada_cc !== null && m.cilindrada_cc !== '') {
    cc = Number(m.cilindrada_cc);
    if (!Number.isInteger(cc) || cc < 50 || cc > 2500) errores['moto.cilindrada_cc'] = 'La cilindrada no es válida.';
  }
  const color = m.color === undefined || m.color === null || String(m.color).trim() === ''
    ? null : String(m.color).trim().slice(0, 30);

  if (Object.keys(errores).length > 0) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', errores);
  }

  try {
    const r = await conTransaccion(async (cx) => {
      const [cs] = await cx.execute(
        'SELECT id, estado_aprobacion FROM conductores WHERE usuario_id = ? FOR UPDATE',
        [req.usuario.id],
      );
      const c = cs[0];

      if (!c) {
        const [ins] = await cx.execute(
          `INSERT INTO conductores (usuario_id, documento_identidad, licencia_numero, licencia_categoria)
           VALUES (?, ?, ?, ?)`,
          [req.usuario.id, ci, licNum, licCat],
        );
        await cx.execute(
          `INSERT INTO motos (conductor_id, tipo_vehiculo, placa, marca, modelo, anio, color, cilindrada_cc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [ins.insertId, tipoVehiculo, placa, marca, modelo, anio, color, tipoVehiculo === 'moto' ? cc : null],
        );
        await cx.execute('INSERT INTO billeteras (conductor_id) VALUES (?)', [ins.insertId]);
        return { creada: true };
      }

      if (!['pendiente', 'rechazado'].includes(c.estado_aprobacion)) {
        return { e: [409, 'POSTULACION_BLOQUEADA', 'Tu postulación está en revisión o aprobada. Para cambiar datos, contacta a soporte.'] };
      }
      await cx.execute(
        `UPDATE conductores SET documento_identidad = ?, licencia_numero = ?, licencia_categoria = ? WHERE id = ?`,
        [ci, licNum, licCat, c.id],
      );
      const [ms] = await cx.execute('SELECT id FROM motos WHERE conductor_id = ?', [c.id]);
      if (ms[0]) {
        await cx.execute(
          `UPDATE motos SET tipo_vehiculo = ?, placa = ?, marca = ?, modelo = ?, anio = ?, color = ?, cilindrada_cc = ? WHERE id = ?`,
          [tipoVehiculo, placa, marca, modelo, anio, color, tipoVehiculo === 'moto' ? cc : null, ms[0].id],
        );
      } else {
        await cx.execute(
          `INSERT INTO motos (conductor_id, tipo_vehiculo, placa, marca, modelo, anio, color, cilindrada_cc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [c.id, tipoVehiculo, placa, marca, modelo, anio, color, tipoVehiculo === 'moto' ? cc : null],
        );
      }
      return { creada: false };
    });
    if (r.e) return error(res, ...r.e);
    return ok(res, await estadoDe(req.usuario.id), r.creada ? 201 : 200);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      if (String(e.sqlMessage).includes('uq_motos_placa')) {
        return error(res, 409, 'PLACA_REGISTRADA', 'Esa placa ya está registrada.');
      }
      return error(res, 409, 'CEDULA_REGISTRADA', 'Esa cédula ya está registrada.');
    }
    throw e;
  }
});

// ---------------------------------------------------------------------
// Estado de la postulación (se usa en varias rutas)
// ---------------------------------------------------------------------
async function estadoDe(usuarioId) {
  const [cs] = await db.execute(
    `SELECT id, estado_aprobacion, estado_operativo, motivo_rechazo, documento_identidad, qr_pago_url,
            licencia_numero, licencia_categoria
       FROM conductores WHERE usuario_id = ?`,
    [usuarioId],
  );
  const c = cs[0];
  if (!c) {
    return { postulacion: null, puede_enviar: false, falta: ['postulacion', ...TIPOS_REQUERIDOS_MOTO] };
  }
  const [motos] = await db.execute(
    'SELECT placa, marca, modelo, anio, color, cilindrada_cc, tipo_vehiculo FROM motos WHERE conductor_id = ?', [c.id],
  );
  const [docs] = await db.execute(
    `SELECT id, tipo, estado, motivo_rechazo, DATE_FORMAT(vence_en, '%Y-%m-%d') AS vence_en,
            (vence_en IS NOT NULL AND vence_en < DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR)) AS vencido
       FROM documentos_conductor WHERE conductor_id = ? ORDER BY id DESC`,
    [c.id],
  );
  // Por cada tipo cuenta el documento más reciente
  const ultimo = new Map();
  for (const d of docs) if (!ultimo.has(d.tipo)) ultimo.set(d.tipo, d);

  const tipoVehiculo = motos[0]?.tipo_vehiculo ?? 'moto';
  const requeridos = requeridosParaVehiculo(tipoVehiculo);
  const documentos = TIPOS.map((tipo) => {
    const d = ultimo.get(tipo);
    return {
      tipo,
      requerido: requeridos.includes(tipo),
      estado: d ? (Number(d.vencido) === 1 ? 'vencido' : d.estado) : 'sin_subir',
      motivo_rechazo: d?.motivo_rechazo ?? null,
      vence_en: d?.vence_en ?? null,
    };
  });
  // Falta todo requerido que no esté subido o que esté rechazado / vencido
  const falta = documentos
    .filter((d) => d.requerido && !['pendiente', 'aprobado'].includes(d.estado))
    .map((d) => d.tipo);

  return {
    postulacion: {
      estado_aprobacion: c.estado_aprobacion,
      motivo_rechazo: c.motivo_rechazo,
      documento_identidad: c.documento_identidad,
      licencia_numero: c.licencia_numero,
      licencia_categoria: c.licencia_categoria,
      moto: motos[0] ?? null,
    },
    documentos,
    falta,
    puede_enviar: ['pendiente', 'rechazado'].includes(c.estado_aprobacion) && falta.length === 0 && motos.length > 0,
  };
}

// GET /conductor/estado
rutaConductor.get('/estado', ...base, async (req, res) => {
  ok(res, await estadoDe(req.usuario.id));
});

// ---------------------------------------------------------------------
// POST /conductor/documentos   (multipart/form-data)
//   campos: tipo, vence_en (solo licencia y soat, AAAA-MM-DD), archivo (la foto)
// ---------------------------------------------------------------------
const limiteSubidas = rateLimit({
  windowMs: 60 * 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => error(res, 429, 'DEMASIADAS_PETICIONES', 'Subiste demasiados archivos. Intenta más tarde.'),
});

const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5, fieldSize: 200 },
}).single('archivo');

function recibirArchivo(req, res, next) {
  subida(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return error(res, 413, 'ARCHIVO_MUY_GRANDE', 'La foto pesa más de 5 MB.');
    }
    return error(res, 400, 'SUBIDA_INVALIDA', 'No pudimos leer el archivo enviado.');
  });
}

// POST /conductor/qr-pago — sube el QR personal que el pasajero usará para pagar directamente.
rutaConductor.post('/qr-pago', limiteSubidas, ...base, recibirArchivo, async (req, res) => {
  const imagen = req.file ? detectarImagen(req.file.buffer) : null;
  if (!req.file || !imagen) return error(res, 415, 'IMAGEN_INVALIDA', 'Adjunta una imagen JPG, PNG o WebP válida de tu QR bancario.');
  const [cs] = await db.execute('SELECT id FROM conductores WHERE usuario_id=? LIMIT 1', [req.usuario.id]);
  const conductor = cs[0];
  if (!conductor) return error(res, 409, 'SIN_POSTULACION', 'Primero completa la postulación como conductor.');
  const nombre = await guardarImagenComercio(req.file.buffer, imagen.ext);
  const ruta = `/media/comercios/${nombre}`;
  const url = config.urlPublicaApi ? `${config.urlPublicaApi}${ruta}` : ruta;
  try {
    await db.execute('UPDATE conductores SET qr_pago_url=?, qr_pago_subido_en=UTC_TIMESTAMP(), qr_pago_vence_en=DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 YEAR) WHERE id=?', [url, conductor.id]);
  } catch (e) {
    await borrarImagenComercio(nombre);
    throw e;
  }
  return ok(res, { qr_pago_url: url, mensaje: 'QR bancario guardado. Los pasajeros lo verán solo en viajes que eligieron pagar por QR.' });
});

rutaConductor.post('/documentos', limiteSubidas, ...base, recibirArchivo, async (req, res) => {
  const tipo = String(req.body?.tipo ?? '');
  const errores = {};
  if (!TIPOS.includes(tipo)) errores.tipo = `Debe ser uno de: ${TIPOS.join(', ')}.`;

  let venceEn = null;
  if (CON_VENCIMIENTO.includes(tipo)) {
    const t = String(req.body?.vence_en ?? '').trim();
    const mt = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const f = mt && new Date(Date.UTC(+mt[1], +mt[2] - 1, +mt[3]));
    const real = f && f.getUTCFullYear() === +mt[1] && f.getUTCMonth() === +mt[2] - 1 && f.getUTCDate() === +mt[3];
    if (!real) errores.vence_en = 'Ingresa la fecha de vencimiento (AAAA-MM-DD).';
    else if (t <= hoyBolivia()) errores.vence_en = 'El documento está vencido o vence hoy.';
    else venceEn = t;
  }

  const imagen = req.file ? detectarImagen(req.file.buffer) : null;
  if (!req.file) errores.archivo = 'Adjunta la foto del documento.';
  else if (!imagen) errores.archivo = 'Solo se aceptan fotos JPG, PNG o WebP.';

  if (Object.keys(errores).length > 0) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', errores);
  }

  const nombre = await guardarDocumento(req.file.buffer, imagen.ext);
  let reemplazados = [];
  try {
    const r = await conTransaccion(async (cx) => {
      const [cs] = await cx.execute(
        'SELECT id, estado_aprobacion FROM conductores WHERE usuario_id = ? FOR UPDATE',
        [req.usuario.id],
      );
      const c = cs[0];
      if (!c) return { e: [409, 'SIN_POSTULACION', 'Primero envía los datos de tu postulación.'] };
      if (!['pendiente', 'rechazado'].includes(c.estado_aprobacion)) {
        return { e: [409, 'POSTULACION_BLOQUEADA', 'Tu postulación está en revisión o aprobada. No se pueden cambiar documentos.'] };
      }
      // Un documento ya aprobado y vigente no se reemplaza desde la app
      const [vigente] = await cx.execute(
        `SELECT id FROM documentos_conductor
          WHERE conductor_id = ? AND tipo = ? AND estado = 'aprobado'
            AND (vence_en IS NULL OR vence_en >= DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR)) LIMIT 1`,
        [c.id, tipo],
      );
      if (vigente[0]) return { e: [409, 'DOCUMENTO_APROBADO', 'Ese documento ya fue aprobado.'] };

      // El nuevo reemplaza a los anteriores pendientes o rechazados del mismo tipo
      const [viejos] = await cx.execute(
        `SELECT id, archivo_ruta FROM documentos_conductor
          WHERE conductor_id = ? AND tipo = ? AND estado IN ('pendiente','rechazado')`,
        [c.id, tipo],
      );
      for (const v of viejos) await cx.execute('DELETE FROM documentos_conductor WHERE id = ?', [v.id]);
      reemplazados = viejos.map((v) => v.archivo_ruta);

      const [ins] = await cx.execute(
        `INSERT INTO documentos_conductor (conductor_id, tipo, archivo_ruta, vence_en) VALUES (?, ?, ?, ?)`,
        [c.id, tipo, nombre, venceEn],
      );
      if (tipo === 'licencia' || tipo === 'licencia_frente') {
        await cx.execute('UPDATE conductores SET licencia_vence_en = ? WHERE id = ?', [venceEn, c.id]);
      }
      return { datos: { id: ins.insertId, tipo, estado: 'pendiente', vence_en: venceEn } };
    });
    if (r.e) {
      await borrarDocumento(nombre);
      return error(res, ...r.e);
    }
    await Promise.all(reemplazados.map(borrarDocumento));
    return ok(res, r.datos, 201);
  } catch (e) {
    await borrarDocumento(nombre);
    throw e;
  }
});

// ---------------------------------------------------------------------
// POST /conductor/enviar-revision
// ---------------------------------------------------------------------
rutaConductor.post('/enviar-revision', ...base, async (req, res) => {
  const r = await conTransaccion(async (cx) => {
    const [cs] = await cx.execute(
      'SELECT id, estado_aprobacion FROM conductores WHERE usuario_id = ? FOR UPDATE',
      [req.usuario.id],
    );
    const c = cs[0];
    if (!c) return { e: [409, 'SIN_POSTULACION', 'Primero envía los datos de tu postulación.'] };
    if (!['pendiente', 'rechazado'].includes(c.estado_aprobacion)) {
      return { e: [409, 'ESTADO_INVALIDO', 'Tu postulación ya está en revisión o aprobada.'] };
    }
    const [motos] = await cx.execute('SELECT id, tipo_vehiculo FROM motos WHERE conductor_id = ?', [c.id]);
    if (!motos[0]) return { e: [409, 'SIN_VEHICULO', 'Falta registrar los datos de tu vehículo.'] };

    const [vigentes] = await cx.execute(
      `SELECT DISTINCT tipo FROM documentos_conductor
        WHERE conductor_id = ? AND estado IN ('pendiente','aprobado')
          AND (vence_en IS NULL OR vence_en >= DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR))`,
      [c.id],
    );
    const tiene = new Set(vigentes.map((f) => f.tipo));
    const faltan = requeridosParaVehiculo(motos[0].tipo_vehiculo).filter((t) => !tiene.has(t));
    if (faltan.length > 0) {
      return { e: [409, 'DOCUMENTOS_INCOMPLETOS', 'Faltan documentos vigentes.', { faltan: faltan.join(', ') }] };
    }
    await cx.execute(
      `UPDATE conductores SET estado_aprobacion = 'en_revision', motivo_rechazo = NULL WHERE id = ?`,
      [c.id],
    );
    return { ok: true };
  });
  if (r.e) return error(res, ...r.e);
  ok(res, await estadoDe(req.usuario.id));
});
