import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';
import { requerirRol } from '../middleware/requerirRol.js';
import { config } from '../config.js';
import { detectarImagen, guardarImagenComercio } from '../servicios/almacenamiento.js';

export const rutaComercio = Router();
rutaComercio.use(autenticar, requerirRol('comercio'));

const diasValidos = new Set([1, 2, 3, 4, 5, 6, 7]);
const recibirImagen = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('archivo');

// POST /comercio/imagenes { tipo: 'logo'|'producto', archivo: imagen }
rutaComercio.post('/imagenes', (req, res, next) => recibirImagen(req, res, (e) => e ? next(e) : next()), async (req, res) => {
  const tipo = String(req.body?.tipo ?? '');
  if (!['logo', 'producto', 'qr_pago'].includes(tipo)) return error(res, 422, 'TIPO_IMAGEN_INVALIDO', 'Elige si la imagen es el logo, un producto o el QR bancario del negocio.')
  if (!req.file?.buffer) return error(res, 422, 'IMAGEN_REQUERIDA', 'Selecciona una imagen.');
  const deteccion = detectarImagen(req.file.buffer);
  if (!deteccion) return error(res, 415, 'FORMATO_NO_ADMITIDO', 'Usa una imagen JPG, PNG o WEBP válida.');
  const nombre = await guardarImagenComercio(req.file.buffer, deteccion.ext);
  const ruta = `/media/comercios/${nombre}`;
  const url = config.urlPublicaApi ? `${config.urlPublicaApi}${ruta}` : ruta;
  return ok(res, { tipo, nombre, url }, 201);
});
const validarCoordenada = (v, min, max) => v === null || v === undefined || v === '' || (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max);

// GET /comercio/perfil
rutaComercio.get('/perfil', async (req, res) => {
  const [empresas] = await db.execute("SELECT *, IF(qr_pago_url IS NOT NULL AND qr_pago_vence_en > UTC_TIMESTAMP(),1,0) AS qr_vigente FROM empresas WHERE usuario_id = ? LIMIT 1", [req.usuario.id]);
  if (!empresas[0]) return ok(res, { perfil: null, horarios: [] });
  const empresa = empresas[0];
  const [horarios] = await db.execute(
    'SELECT dia_semana, TIME_FORMAT(abre, "%H:%i") AS abre, TIME_FORMAT(cierra, "%H:%i") AS cierra, cerrado FROM comercio_horarios WHERE empresa_id = ? ORDER BY dia_semana',
    [empresa.id],
  );
  return ok(res, { perfil: empresa, horarios });
});

// PUT /comercio/perfil
// {nombre_comercial, rubro, telefono_contacto, direccion, latitud, longitud, horarios:[{dia_semana,abre,cierra,cerrado}]}
rutaComercio.put('/perfil', async (req, res) => {
  const b = req.body ?? {};
  const errores = {};
  const nombre = String(b.nombre_comercial ?? '').trim();
  const rubro = String(b.rubro ?? '').trim();
  const telefono = String(b.telefono_contacto ?? '').trim();
  const direccion = String(b.direccion ?? '').trim();
  const razon = String(b.razon_social ?? '').trim() || null;
  const nit = String(b.nit ?? '').trim() || null;
  const logoUrl = String(b.logo_url ?? '').trim() || null;
  const qrPagoUrl = String(b.qr_pago_url ?? '').trim() || null;
  if (qrPagoUrl && !(/^(https:\/\/[^\s]+|\/media\/comercios\/[a-f0-9]{32}\.(jpg|png|webp))$/i.test(qrPagoUrl))) errores.qr_pago_url = 'Sube el QR bancario como imagen o usa una URL HTTPS válida.';
  if (!logoUrl) errores.logo_url = 'Sube el logo o imagen del negocio antes de guardar.';
  else if (!(/^(https:\/\/[^\s]+|\/media\/comercios\/[a-f0-9]{32}\.(jpg|png|webp))$/i.test(logoUrl))) errores.logo_url = 'Sube el logo desde esta pantalla o usa una URL HTTPS válida.';
  const lat = b.latitud === '' || b.latitud === undefined ? null : b.latitud;
  const lng = b.longitud === '' || b.longitud === undefined ? null : b.longitud;
  if (nombre.length < 2 || nombre.length > 150) errores.nombre_comercial = 'El nombre comercial debe tener entre 2 y 150 caracteres.';
  if (rubro.length < 2 || rubro.length > 80) errores.rubro = 'Indica el rubro del negocio (entre 2 y 80 caracteres).';
  if (telefono.length > 20) errores.telefono_contacto = 'El teléfono no puede superar 20 caracteres.';
  if (direccion.length < 5 || direccion.length > 255) errores.direccion = 'Ingresa una dirección de al menos 5 caracteres.';
  if (!validarCoordenada(lat, -90, 90)) errores.latitud = 'La latitud debe estar entre -90 y 90.';
  if (!validarCoordenada(lng, -180, 180)) errores.longitud = 'La longitud debe estar entre -180 y 180.';
  if (lat === null || lng === null) errores.ubicacion = 'Busca y selecciona la ubicación del negocio para guardar sus coordenadas.';
  if ((lat === null) !== (lng === null)) errores.ubicacion = 'Selecciona una ubicación para guardar latitud y longitud juntas.';
  if (b.horarios !== undefined && !Array.isArray(b.horarios)) errores.horarios = 'Los horarios deben enviarse como una lista.';
  const horarios = Array.isArray(b.horarios) ? b.horarios : [];
  const vistos = new Set();
  horarios.forEach((h, i) => {
    const dia = Number(h?.dia_semana);
    if (!diasValidos.has(dia) || vistos.has(dia)) errores[`horarios.${i}.dia_semana`] = 'Cada día debe aparecer una sola vez (1=lunes, 7=domingo).';
    vistos.add(dia);
    if (!h?.cerrado && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(h?.abre ?? '')) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(h?.cierra ?? '')) || h.abre === h.cierra)) {
      errores[`horarios.${i}.horas`] = 'Indica hora de apertura y cierre válidas, distintas entre sí.';
    }
  });
  if (Object.keys(errores).length) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', errores);

  const conexion = await db.getConnection();
  try {
    await conexion.beginTransaction();
    const [existentes] = await conexion.execute('SELECT id, qr_pago_url FROM empresas WHERE usuario_id = ? FOR UPDATE', [req.usuario.id]);
    let empresaId;
    if (existentes[0]) {
      empresaId = existentes[0].id;
      const qrCambio = String(existentes[0].qr_pago_url ?? '') !== String(qrPagoUrl ?? '');
      if (qrCambio && qrPagoUrl) {
        await conexion.execute(
          `UPDATE empresas SET nombre_comercial=?, logo_url=?, qr_pago_url=?, qr_pago_subido_en=UTC_TIMESTAMP(), qr_pago_vence_en=DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 YEAR), razon_social=?, nit=?, rubro=?, telefono_contacto=?, direccion=?, latitud=?, longitud=? WHERE id=?`,
          [nombre, logoUrl, qrPagoUrl, razon, nit, rubro || null, telefono || null, direccion, lat === null ? null : Number(lat), lng === null ? null : Number(lng), empresaId],
        );
      } else if (qrCambio && !qrPagoUrl) {
        await conexion.execute(
          `UPDATE empresas SET nombre_comercial=?, logo_url=?, qr_pago_url=NULL, qr_pago_subido_en=NULL, qr_pago_vence_en=NULL, razon_social=?, nit=?, rubro=?, telefono_contacto=?, direccion=?, latitud=?, longitud=? WHERE id=?`,
          [nombre, logoUrl, razon, nit, rubro || null, telefono || null, direccion, lat === null ? null : Number(lat), lng === null ? null : Number(lng), empresaId],
        );
      } else {
        await conexion.execute(
          `UPDATE empresas SET nombre_comercial=?, logo_url=?, qr_pago_url=?, razon_social=?, nit=?, rubro=?, telefono_contacto=?, direccion=?, latitud=?, longitud=? WHERE id=?`,
          [nombre, logoUrl, qrPagoUrl, razon, nit, rubro || null, telefono || null, direccion, lat === null ? null : Number(lat), lng === null ? null : Number(lng), empresaId],
        );
      }
    } else {
      const [ins] = await conexion.execute(
        `INSERT INTO empresas (usuario_id,nombre_comercial,logo_url,qr_pago_url,qr_pago_subido_en,qr_pago_vence_en,razon_social,nit,rubro,telefono_contacto,direccion,latitud,longitud,estado_aprobacion) VALUES (?,?,?,?,IF(? IS NULL,NULL,UTC_TIMESTAMP()),IF(? IS NULL,NULL,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 YEAR)),?,?,?,?,?,?,?,'pendiente')`,
        [req.usuario.id, nombre, logoUrl, qrPagoUrl, qrPagoUrl, qrPagoUrl, razon, nit, rubro || null, telefono || null, direccion, lat === null ? null : Number(lat), lng === null ? null : Number(lng)],
      );
      empresaId = ins.insertId;
    }
    if (b.horarios !== undefined) {
      await conexion.execute('DELETE FROM comercio_horarios WHERE empresa_id = ?', [empresaId]);
      for (const h of horarios) {
        await conexion.execute(
          'INSERT INTO comercio_horarios (empresa_id,dia_semana,abre,cierra,cerrado) VALUES (?,?,?,?,?)',
          [empresaId, Number(h.dia_semana), h.cerrado ? null : h.abre, h.cerrado ? null : h.cierra, h.cerrado ? 1 : 0],
        );
      }
    }
    await conexion.commit();
    const [perfil] = await db.execute('SELECT * FROM empresas WHERE id = ?', [empresaId]);
    const [hs] = await db.execute('SELECT dia_semana, TIME_FORMAT(abre, "%H:%i") AS abre, TIME_FORMAT(cierra, "%H:%i") AS cierra, cerrado FROM comercio_horarios WHERE empresa_id = ? ORDER BY dia_semana', [empresaId]);
    return ok(res, { perfil: perfil[0], horarios: hs });
  } catch (e) {
    await conexion.rollback();
    throw e;
  } finally {
    conexion.release();
  }
});

async function empresaDelUsuario(usuarioId) {
  const [rows] = await db.execute('SELECT id, estado_aprobacion FROM empresas WHERE usuario_id = ? LIMIT 1', [usuarioId]);
  return rows[0] ?? null;
}

// GET /comercio/productos
rutaComercio.get('/productos', async (req, res) => {
  const empresa = await empresaDelUsuario(req.usuario.id);
  if (!empresa) return ok(res, { productos: [] });
  const [productos] = await db.execute('SELECT id,nombre,descripcion,categoria,precio,stock,imagen_url,activo,creado_en,actualizado_en FROM productos_comercio WHERE empresa_id = ? ORDER BY creado_en DESC', [empresa.id]);
  return ok(res, { productos });
});

// POST /comercio/productos
rutaComercio.post('/productos', async (req, res) => {
  const empresa = await empresaDelUsuario(req.usuario.id);
  if (!empresa) return error(res, 409, 'COMERCIO_INCOMPLETO', 'Primero guarda los datos y la ubicación de tu negocio.');
  const b = req.body ?? {};
  const nombre = String(b.nombre ?? '').trim();
  const descripcion = String(b.descripcion ?? '').trim() || null;
  const categoriaTexto = String(b.categoria ?? '').trim();
  const categoria = categoriaTexto || null;
  const precio = Number(b.precio);
  const stock = b.stock === null || b.stock === undefined || b.stock === '' ? null : Number(b.stock);
  const imagen = String(b.imagen_url ?? '').trim() || null;
  const errores = {};
  if (nombre.length < 2 || nombre.length > 120) errores.nombre = 'El nombre debe tener entre 2 y 120 caracteres.';
  if (descripcion && descripcion.length > 500) errores.descripcion = 'Máximo 500 caracteres.';
  if (categoriaTexto.length < 2 || categoriaTexto.length > 80) errores.categoria = 'Indica una categoría de entre 2 y 80 caracteres.';
  if (!imagen) errores.imagen_url = 'Sube una foto del producto antes de agregarlo al catálogo.';
  if (!Number.isFinite(precio) || precio < 0 || Math.round(precio * 100) !== precio * 100) errores.precio = 'Ingresa un precio válido en Bs. con máximo 2 decimales.';
  if (stock !== null && (!Number.isInteger(stock) || stock < 0)) errores.stock = 'El stock debe ser un entero no negativo o quedar vacío.';
  if (imagen && (!( /^https:\/\//i.test(imagen) || /^\/media\/comercios\/[a-f0-9]{32}\.(jpg|png|webp)$/i.test(imagen)) || imagen.length > 500)) errores.imagen_url = 'Sube una imagen desde la app o usa una URL HTTPS válida.';
  if (Object.keys(errores).length) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', errores);
  const [ins] = await db.execute('INSERT INTO productos_comercio (empresa_id,nombre,descripcion,categoria,precio,stock,imagen_url) VALUES (?,?,?,?,?,?,?)', [empresa.id,nombre,descripcion,categoria,precio,stock,imagen]);
  const [rows] = await db.execute('SELECT id,nombre,descripcion,categoria,precio,stock,imagen_url,activo FROM productos_comercio WHERE id = ?', [ins.insertId]);
  return ok(res, rows[0], 201);
});

// PUT /comercio/productos/:id
rutaComercio.put('/productos/:id', async (req, res) => {
  const empresa = await empresaDelUsuario(req.usuario.id);
  if (!empresa) return error(res, 404, 'NO_ENCONTRADO', 'Producto no encontrado.');
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return error(res, 404, 'NO_ENCONTRADO', 'Producto no encontrado.');
  const b = req.body ?? {};
  const [actual] = await db.execute('SELECT * FROM productos_comercio WHERE id=? AND empresa_id=?', [id,empresa.id]);
  if (!actual[0]) return error(res, 404, 'NO_ENCONTRADO', 'Producto no encontrado.');
  const nombre = String(b.nombre ?? actual[0].nombre).trim();
  const descripcion = b.descripcion === undefined ? actual[0].descripcion : (String(b.descripcion).trim() || null);
  const categoria = b.categoria === undefined ? actual[0].categoria : (String(b.categoria).trim() || null);
  const precio = b.precio === undefined ? Number(actual[0].precio) : Number(b.precio);
  const stock = b.stock === undefined ? actual[0].stock : (b.stock === null || b.stock === '' ? null : Number(b.stock));
  const imagen = b.imagen_url === undefined ? actual[0].imagen_url : (String(b.imagen_url).trim() || null);
  const activo = b.activo === undefined ? Number(actual[0].activo) : (b.activo ? 1 : 0);
  const errores = {};
  if (nombre.length < 2 || nombre.length > 120) errores.nombre = 'El nombre debe tener entre 2 y 120 caracteres.';
  if (!Number.isFinite(precio) || precio < 0 || Math.round(precio * 100) !== precio * 100) errores.precio = 'Precio inválido.';
  if (stock !== null && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) errores.stock = 'Stock inválido.';
  if (Object.keys(errores).length) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', errores);
  await db.execute('UPDATE productos_comercio SET nombre=?,descripcion=?,categoria=?,precio=?,stock=?,imagen_url=?,activo=? WHERE id=? AND empresa_id=?', [nombre,descripcion,categoria,precio,stock,imagen,activo,id,empresa.id]);
  const [rows] = await db.execute('SELECT id,nombre,descripcion,categoria,precio,stock,imagen_url,activo FROM productos_comercio WHERE id=? AND empresa_id=?', [id,empresa.id]);
  return ok(res, rows[0]);
});

// DELETE /comercio/productos/:id -> borrado lógico
rutaComercio.delete('/productos/:id', async (req, res) => {
  const empresa = await empresaDelUsuario(req.usuario.id);
  if (!empresa) return error(res, 404, 'NO_ENCONTRADO', 'Producto no encontrado.');
  const [resultado] = await db.execute('UPDATE productos_comercio SET activo=0 WHERE id=? AND empresa_id=?', [Number(req.params.id),empresa.id]);
  if (!resultado.affectedRows) return error(res, 404, 'NO_ENCONTRADO', 'Producto no encontrado.');
  return ok(res, { mensaje: 'Producto desactivado.' });
});
