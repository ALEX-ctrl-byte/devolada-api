import { Router } from 'express';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';
import { requerirRol } from '../middleware/requerirRol.js';
import { leerDocumento } from '../servicios/almacenamiento.js';
import { notificarPedidoActualizado, notificarEstadoViaje } from '../tiempoReal.js';
import { config } from '../config.js';
import { errorPin, hashPin } from '../servicios/pin.js';

export const rutaAdmin = Router();

const soloAdmin = [autenticar, requerirRol('admin')];

const DOCS_REQUERIDOS_MOTO = [
  'ci_frente', 'ci_reverso', 'selfie', 'licencia_frente', 'licencia_reverso',
  'selfie_licencia', 'soat', 'tarjeta_propiedad', 'foto_placa', 'foto_moto',
];
const DOCS_REQUERIDOS_AUTO = [
  'ci_frente', 'ci_reverso', 'selfie', 'licencia_frente', 'licencia_reverso',
  'selfie_licencia', 'soat', 'tarjeta_propiedad', 'foto_placa',
  'foto_auto_frente', 'foto_auto_atras', 'foto_auto_lateral', 'ruat',
];
const documentosRequeridosPorVehiculo = (tipo) => tipo === 'auto' ? DOCS_REQUERIDOS_AUTO : DOCS_REQUERIDOS_MOTO;
const ESTADOS_COLA = ['pendiente', 'en_revision', 'aprobado', 'rechazado', 'suspendido'];

const PARAMETROS_TARIFA = [
  { clave: 'tarifa_base_normal_bs', etiqueta: 'Tarifa base normal', grupo: 'Base y oferta', descripcion: 'Base en Bs cuando la disponibilidad no es abundante.', unidad: 'Bs', minimo: 0, maximo: 100, defecto: 4 },
  { clave: 'tarifa_base_muchos_conductores_bs', etiqueta: 'Tarifa base con muchos conductores', grupo: 'Base y oferta', descripcion: 'Base reducida cuando hay al menos el umbral de conductores cercanos y más oferta que demanda.', unidad: 'Bs', minimo: 0, maximo: 100, defecto: 3 },
  { clave: 'tarifa_umbral_muchos_conductores', etiqueta: 'Umbral de conductores cercanos', grupo: 'Base y oferta', descripcion: 'Cantidad mínima de conductores disponibles en el radio para considerar oferta abundante.', unidad: 'conductores', minimo: 2, maximo: 50, defecto: 5 },
  { clave: 'tarifa_radio_conductores_km', etiqueta: 'Radio de oferta y demanda', grupo: 'Base y oferta', descripcion: 'Radio en km usado para comparar conductores disponibles con servicios pendientes.', unidad: 'km', minimo: 1, maximo: 10, defecto: 3 },
  { clave: 'tarifa_radio_aproximacion_km', etiqueta: 'Radio máximo para buscar conductor', grupo: 'Aproximación', descripcion: 'Radio en km para considerar el conductor compatible más cercano al punto de recogida.', unidad: 'km', minimo: 1, maximo: 20, defecto: 20 },
  { clave: 'tarifa_ubicacion_max_s', etiqueta: 'Antigüedad máxima del GPS', grupo: 'Aproximación', descripcion: 'Un GPS más antiguo no se considera una ubicación disponible fiable.', unidad: 'segundos', minimo: 30, maximo: 300, defecto: 120 },
  { clave: 'tarifa_km_moto_bs', etiqueta: 'Precio por km de servicio — moto', grupo: 'Moto', descripcion: 'Se cobra por cada km iniciado de la ruta de servicio.', unidad: 'Bs/km', minimo: 0, maximo: 100, defecto: 1 },
  { clave: 'tarifa_tiempo_moto_5min_bs', etiqueta: 'Precio por 5 min — moto', grupo: 'Moto', descripcion: 'Se cobra por cada bloque iniciado de cinco minutos de servicio.', unidad: 'Bs/5 min', minimo: 0, maximo: 100, defecto: 1 },
  { clave: 'tarifa_aproximacion_km_moto_bs', etiqueta: 'Aproximación por km — moto', grupo: 'Moto', descripcion: 'Precio por cada km iniciado que el conductor recorre para llegar al recojo.', unidad: 'Bs/km', minimo: 0, maximo: 100, defecto: 1 },
  { clave: 'tarifa_aproximacion_tiempo_moto_5min_bs', etiqueta: 'Aproximación por 5 min — moto', grupo: 'Moto', descripcion: 'Precio por cada bloque iniciado de cinco minutos de aproximación.', unidad: 'Bs/5 min', minimo: 0, maximo: 100, defecto: 1 },
  { clave: 'tarifa_km_auto_bs', etiqueta: 'Precio por km de servicio — auto', grupo: 'Auto', descripcion: 'Se cobra por cada km iniciado de la ruta de servicio.', unidad: 'Bs/km', minimo: 0, maximo: 100, defecto: 2 },
  { clave: 'tarifa_tiempo_auto_5min_bs', etiqueta: 'Precio por 5 min — auto', grupo: 'Auto', descripcion: 'Se cobra por cada bloque iniciado de cinco minutos de servicio.', unidad: 'Bs/5 min', minimo: 0, maximo: 100, defecto: 1 },
  { clave: 'tarifa_aproximacion_km_auto_bs', etiqueta: 'Aproximación por km — auto', grupo: 'Auto', descripcion: 'Precio por cada km iniciado que el conductor recorre para llegar al recojo.', unidad: 'Bs/km', minimo: 0, maximo: 100, defecto: 2 },
  { clave: 'tarifa_aproximacion_tiempo_auto_5min_bs', etiqueta: 'Aproximación por 5 min — auto', grupo: 'Auto', descripcion: 'Precio por cada bloque iniciado de cinco minutos de aproximación.', unidad: 'Bs/5 min', minimo: 0, maximo: 100, defecto: 1 },
];
// Fecha de hoy en Bolivia (UTC-4), igual que el mantenimiento diario del esquema
const HOY_BO = 'DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR)';

const esId = (v) => /^\d{1,18}$/.test(String(v));

// GET /admin/resumen — tarjetas de control del panel (todos los conteos salen de MySQL).
rutaAdmin.get('/resumen', ...soloAdmin, async (_req, res) => {
  const [usuarios] = await db.execute(`SELECT COUNT(*) AS total FROM usuarios WHERE estado='activo'`);
  const [pendientes] = await db.execute(`SELECT COUNT(*) AS total FROM usuarios WHERE estado='pendiente'`);
  const [comercios] = await db.execute(`SELECT estado_aprobacion AS estado, COUNT(*) AS total FROM empresas GROUP BY estado_aprobacion`);
  const [conductores] = await db.execute(`SELECT estado_aprobacion AS estado, COUNT(*) AS total FROM conductores GROUP BY estado_aprobacion`);
  const [documentos] = await db.execute(`SELECT estado, COUNT(*) AS total FROM documentos_conductor GROUP BY estado`);
  const [viajes] = await db.execute(`SELECT estado, COUNT(*) AS total FROM viajes GROUP BY estado`);
  const [envios] = await db.execute(`SELECT estado, COUNT(*) AS total FROM envios GROUP BY estado`);
  const sumar = (filas, estado) => Number(filas.find((f) => f.estado === estado)?.total ?? 0);
  return ok(res, {
    usuarios_activos: Number(usuarios[0]?.total ?? 0),
    usuarios_pendientes: Number(pendientes[0]?.total ?? 0),
    comercios_revision: sumar(comercios, 'pendiente'),
    comercios_publicados: sumar(comercios, 'aprobado'),
    comercios_rechazados: sumar(comercios, 'rechazado'),
    conductores_revision: sumar(conductores, 'en_revision'),
    conductores_aprobados: sumar(conductores, 'aprobado'),
    conductores_rechazados: sumar(conductores, 'rechazado'),
    documentos_pendientes: sumar(documentos, 'pendiente'),
    viajes_solicitados: sumar(viajes, 'solicitado'),
    viajes_activos: ['aceptado', 'conductor_llego', 'en_curso'].reduce((n, e) => n + sumar(viajes, e), 0),
    viajes_finalizados: sumar(viajes, 'finalizado'),
    envios_solicitados: sumar(envios, 'solicitado'),
    envios_activos: ['asignado', 'recogido', 'en_camino', 'en_punto_entrega'].reduce((n, e) => n + sumar(envios, e), 0),
    envios_entregados: sumar(envios, 'entregado'),
    envios_revision: sumar(envios, 'requiere_revision'),
  });
});

// Configuración del motor tarifario: solo parámetros permitidos y todos enteros en Bs.
rutaAdmin.get('/tarifas', ...soloAdmin, async (_req, res) => {
  const valores = {};
  for (const p of PARAMETROS_TARIFA) valores[p.clave] = await ajusteNumeroAdmin(p.clave, p.defecto);
  return ok(res, { parametros: PARAMETROS_TARIFA.map((p) => ({ ...p, valor: valores[p.clave] })), valores });
});

rutaAdmin.post('/tarifas', ...soloAdmin, async (req, res) => {
  const entrada = req.body?.valores;
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) return error(res, 422, 'TARIFAS_INVALIDAS', 'Envía los parámetros dentro de valores.');
  const permitidos = new Map(PARAMETROS_TARIFA.map((p) => [p.clave, p]));
  const cambios = [];
  for (const [clave, valorRaw] of Object.entries(entrada)) {
    const p = permitidos.get(clave);
    if (!p) return error(res, 422, 'PARAMETRO_NO_PERMITIDO', `El parámetro ${clave} no se puede modificar desde aquí.`);
    if (typeof valorRaw === 'string' && valorRaw.trim() === '') {
      return error(res, 422, 'VALOR_TARIFA_INVALIDO', `${p.etiqueta}: el campo no puede quedar vacío.`, { [clave]: 'Introduce un número entero.' });
    }
    if (typeof valorRaw === 'string' && valorRaw.trim() === '') {
      return error(res, 422, 'VALOR_TARIFA_INVALIDO', `${p.etiqueta}: el campo no puede quedar vacío.`, { [clave]: 'Introduce un número entero.' });
    }
    const valor = Number(valorRaw);
    if (!Number.isSafeInteger(valor) || valor < p.minimo || valor > p.maximo) {
      return error(res, 422, 'VALOR_TARIFA_INVALIDO', `${p.etiqueta}: usa un número entero entre ${p.minimo} y ${p.maximo}.`, { [clave]: `Valor permitido: ${p.minimo} a ${p.maximo}, sin decimales.` });
    }
    cambios.push({ ...p, valor });
  }
  if (cambios.length === 0) return error(res, 422, 'TARIFAS_VACIAS', 'No se recibieron cambios.');
  const antes = {};
  const despues = {};
  const resultado = await conTransaccion(async (cx) => {
    for (const cambio of cambios) {
      const [filas] = await cx.execute('SELECT valor FROM configuracion WHERE clave=? LIMIT 1 FOR UPDATE', [cambio.clave]);
      antes[cambio.clave] = filas[0] ? Number(filas[0].valor) : cambio.defecto;
      despues[cambio.clave] = cambio.valor;
    }
    const baseNormal = despues.tarifa_base_normal_bs ?? Number((await cx.execute('SELECT valor FROM configuracion WHERE clave=? LIMIT 1', ['tarifa_base_normal_bs']))[0][0]?.valor ?? 4);
    const baseAlta = despues.tarifa_base_muchos_conductores_bs ?? Number((await cx.execute('SELECT valor FROM configuracion WHERE clave=? LIMIT 1', ['tarifa_base_muchos_conductores_bs']))[0][0]?.valor ?? 3);
    if (baseAlta > baseNormal) return { e: [422, 'BASE_TARIFA_INCOHERENTE', 'La tarifa base con muchos conductores debe ser igual o menor que la base normal.'] };
    for (const cambio of cambios) {
      await cx.execute(
        'INSERT INTO configuracion (clave,valor,descripcion) VALUES (?,?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor),descripcion=VALUES(descripcion)',
        [cambio.clave, String(cambio.valor), cambio.descripcion],
      );
    }
    await auditar(cx, req, 'tarifas_deuna_actualizadas', 'configuracion', null, antes, despues);
    return { datos: true };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  const valores = {};
  for (const p of PARAMETROS_TARIFA) valores[p.clave] = await ajusteNumeroAdmin(p.clave, p.defecto);
  return ok(res, { parametros: PARAMETROS_TARIFA.map((p) => ({ ...p, valor: valores[p.clave] })), valores, mensaje: 'Tarifas actualizadas. Solo afectarán las nuevas cotizaciones.' });
});

// Ciudades operativas: conserva las que están inactivas para habilitarlas después desde el panel.
rutaAdmin.get('/ciudades', ...soloAdmin, async (_req, res) => {
  const [ciudades] = await db.execute(
    'SELECT id, nombre, departamento, activa FROM ciudades ORDER BY activa DESC, nombre ASC',
  );
  return ok(res, { ciudades });
});

async function cambiarCiudad(req, res, activa) {
  if (!esId(req.params.id)) return error(res, 404, 'CIUDAD_NO_ENCONTRADA', 'Ciudad no encontrada.');
  const resultado = await conTransaccion(async (cx) => {
    const [filas] = await cx.execute('SELECT id,nombre,activa FROM ciudades WHERE id=? FOR UPDATE', [req.params.id]);
    const ciudad = filas[0];
    if (!ciudad) return { e: [404, 'CIUDAD_NO_ENCONTRADA', 'Ciudad no encontrada.'] };
    if (!activa && Number(ciudad.activa) === 1) {
      const [[conteo]] = await cx.execute('SELECT COUNT(*) AS total FROM ciudades WHERE activa=1');
      if (Number(conteo.total) <= 1) return { e: [409, 'ULTIMA_CIUDAD_ACTIVA', 'Debe quedar al menos una ciudad activa.'] };
    }
    if (Number(ciudad.activa) !== Number(activa)) {
      await cx.execute('UPDATE ciudades SET activa=? WHERE id=?', [activa ? 1 : 0, ciudad.id]);
      await auditar(cx, req, activa ? 'ciudad_activada' : 'ciudad_desactivada', 'ciudades', ciudad.id,
        { activa: Number(ciudad.activa) }, { activa: activa ? 1 : 0, nombre: ciudad.nombre });
    }
    return { datos: { id: Number(ciudad.id), nombre: ciudad.nombre, activa: Boolean(activa) } };
  });
  if (resultado.e) return error(res, ...resultado.e);
  return ok(res, resultado.datos);
}
rutaAdmin.post('/ciudades/:id/activar', ...soloAdmin, (req, res) => cambiarCiudad(req, res, true));
rutaAdmin.post('/ciudades/:id/desactivar', ...soloAdmin, (req, res) => cambiarCiudad(req, res, false));

// Mapa operativo: únicamente posiciones recientes y no simuladas de conductores con un servicio activo.
// La ruta queda restringida al administrador para no convertirla en un directorio público de ubicación.
rutaAdmin.get('/ubicaciones-activas', ...soloAdmin, async (_req, res) => {
  const [puntos] = await db.execute(
    `SELECT c.id AS conductor_id, u.nombre, u.apellido, cu.latitud, cu.longitud, cu.actualizado_en,
            'viaje' AS tipo_servicio, v.id AS servicio_id, v.estado AS estado_servicio
       FROM conductores c JOIN usuarios u ON u.id=c.usuario_id
       JOIN conductor_ubicacion cu ON cu.conductor_id=c.id
       JOIN viajes v ON v.conductor_id=c.id AND v.estado IN ('aceptado','conductor_llego','en_curso','requiere_revision')
      WHERE cu.es_mock=0 AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND
      UNION ALL
     SELECT c.id AS conductor_id, u.nombre, u.apellido, cu.latitud, cu.longitud, cu.actualizado_en,
            'delivery' AS tipo_servicio, p.id AS servicio_id, p.estado AS estado_servicio
       FROM conductores c JOIN usuarios u ON u.id=c.usuario_id
       JOIN conductor_ubicacion cu ON cu.conductor_id=c.id
       JOIN pedidos p ON p.conductor_id=c.id AND p.estado IN ('asignado','recogido','en_camino','requiere_revision')
      WHERE cu.es_mock=0 AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND
      UNION ALL
     SELECT c.id AS conductor_id, u.nombre, u.apellido, cu.latitud, cu.longitud, cu.actualizado_en,
            'envio' AS tipo_servicio, e.id AS servicio_id, e.estado AS estado_servicio
       FROM conductores c JOIN usuarios u ON u.id=c.usuario_id
       JOIN conductor_ubicacion cu ON cu.conductor_id=c.id
       JOIN envios e ON e.conductor_id=c.id AND e.estado IN ('asignado','recogido','en_camino','en_punto_entrega','requiere_revision')
      WHERE cu.es_mock=0 AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND
      ORDER BY actualizado_en DESC LIMIT 100`,
  );
  return ok(res, { puntos: puntos.map((p) => ({ ...p, conductor_id: Number(p.conductor_id), servicio_id: Number(p.servicio_id), latitud: Number(p.latitud), longitud: Number(p.longitud) })) });
});

// Listas administrativas de consulta. No incluyen secretos, QR privados ni claves de sesión.
rutaAdmin.get('/usuarios', ...soloAdmin, async (req, res) => {
  const rol = String(req.query.rol ?? '').trim();
  const estado = String(req.query.estado ?? '').trim();
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  const roles = ['pasajero','conductor','comercio','admin','soporte'];
  const estados = ['pendiente','activo','suspendido','bloqueado','eliminado','rechazado'];
  if (rol && !roles.includes(rol)) return error(res, 422, 'FILTRO_INVALIDO', 'Rol no válido.');
  if (estado && !estados.includes(estado)) return error(res, 422, 'FILTRO_INVALIDO', 'Estado no válido.');
  const where = [], params = [];
  if (rol) { where.push('u.rol=?'); params.push(rol); }
  if (estado) { where.push('u.estado=?'); params.push(estado); }
  if (q) { where.push('(u.telefono LIKE ? OR u.nombre LIKE ? OR u.apellido LIKE ? OR u.email LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`); }
  const [usuarios] = await db.execute(
    `SELECT u.id,u.nombre,u.apellido,u.telefono,u.email,u.rol,u.estado,u.telefono_verificado,u.creado_en,u.ultimo_acceso_en,ci.nombre AS ciudad
       FROM usuarios u LEFT JOIN ciudades ci ON ci.id=u.ciudad_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY u.id DESC LIMIT 200`, params,
  );
  return ok(res, { usuarios });
});

// ---------------------------------------------------------------------
// Aprobación manual de cuentas nuevas (verificación inicial por WhatsApp).
// El usuario se registra en estado 'pendiente', envía un WhatsApp al administrador
// y desde aquí se aprueba o rechaza. Todas las acciones quedan en auditoría.
// ---------------------------------------------------------------------

// GET /admin/usuarios/pendientes — cola de cuentas esperando aprobación (las más antiguas primero).
rutaAdmin.get('/usuarios/pendientes', ...soloAdmin, async (_req, res) => {
  const [usuarios] = await db.execute(
    `SELECT u.id, u.nombre, u.apellido, u.telefono, u.email, u.rol, ci.nombre AS ciudad, u.creado_en
       FROM usuarios u LEFT JOIN ciudades ci ON ci.id = u.ciudad_id
      WHERE u.estado = 'pendiente'
      ORDER BY u.creado_en ASC, u.id ASC LIMIT 200`,
  );
  return ok(res, { usuarios: usuarios.map((u) => ({ ...u, id: Number(u.id) })) });
});

// POST /admin/usuarios/:id/aprobar — activa la cuenta; el usuario ya puede iniciar sesión.
rutaAdmin.post('/usuarios/:id/aprobar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Usuario no encontrado.');
  const r = await conTransaccion(async (cx) => {
    const [us] = await cx.execute(
      'SELECT id, nombre, apellido, telefono, email, rol, estado FROM usuarios WHERE id = ? FOR UPDATE', [req.params.id],
    );
    const u = us[0];
    if (!u) return { e: [404, 'NO_ENCONTRADO', 'Usuario no encontrado.'] };
    if (u.estado !== 'pendiente') return { e: [409, 'ESTADO_INVALIDO', 'Solo se puede aprobar una cuenta pendiente de aprobación.', { estado: u.estado }] };
    await cx.execute(`UPDATE usuarios SET estado = 'activo' WHERE id = ?`, [u.id]);
    await auditar(cx, req, 'usuario_aprobado', 'usuarios', u.id, { estado: u.estado }, { estado: 'activo' });
    return { datos: { id: Number(u.id), nombre: u.nombre, apellido: u.apellido, telefono: u.telefono, email: u.email, rol: u.rol, estado: 'activo' } };
  });
  if (r.e) return error(res, ...r.e);
  return ok(res, { usuario: r.datos, mensaje: 'Cuenta aprobada. El usuario ya puede iniciar sesión en la app.' });
});

// POST /admin/usuarios/:id/rechazar  { motivo } — rechaza la solicitud y revoca cualquier sesión abierta.
rutaAdmin.post('/usuarios/:id/rechazar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Usuario no encontrado.');
  const m = validarMotivo(req.body?.motivo);
  if (m.error) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', { motivo: m.error });
  const r = await conTransaccion(async (cx) => {
    const [us] = await cx.execute('SELECT id, estado FROM usuarios WHERE id = ? FOR UPDATE', [req.params.id]);
    const u = us[0];
    if (!u) return { e: [404, 'NO_ENCONTRADO', 'Usuario no encontrado.'] };
    if (u.estado !== 'pendiente') return { e: [409, 'ESTADO_INVALIDO', 'Solo se puede rechazar una cuenta pendiente de aprobación.', { estado: u.estado }] };
    await cx.execute(`UPDATE usuarios SET estado = 'rechazado' WHERE id = ?`, [u.id]);
    await cx.execute('UPDATE sesiones SET revocada_en = UTC_TIMESTAMP() WHERE usuario_id = ? AND revocada_en IS NULL', [u.id]);
    await auditar(cx, req, 'usuario_rechazado', 'usuarios', u.id, { estado: u.estado }, { estado: 'rechazado', motivo: m.motivo });
    return { datos: { id: Number(u.id), estado: 'rechazado', motivo: m.motivo } };
  });
  if (r.e) return error(res, ...r.e);
  return ok(res, r.datos);
});

// POST /admin/usuarios/:id/pin { pin } — asigna un PIN nuevo (PIN olvidado o cuenta antigua sin PIN).
// El administrador se lo comunica al usuario por WhatsApp. Cierra las sesiones abiertas del usuario.
rutaAdmin.post('/usuarios/:id/pin', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Usuario no encontrado.');
  const errorDelPin = errorPin(req.body?.pin);
  if (errorDelPin) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', { pin: errorDelPin });
  const pinHash = await hashPin(req.body.pin);
  const r = await conTransaccion(async (cx) => {
    const [us] = await cx.execute('SELECT id, telefono, rol, estado FROM usuarios WHERE id = ? FOR UPDATE', [req.params.id]);
    const u = us[0];
    if (!u) return { e: [404, 'NO_ENCONTRADO', 'Usuario no encontrado.'] };
    if (u.estado === 'eliminado') return { e: [409, 'ESTADO_INVALIDO', 'La cuenta fue eliminada.'] };
    await cx.execute('UPDATE usuarios SET pin_hash = ? WHERE id = ?', [pinHash, u.id]);
    await cx.execute('UPDATE sesiones SET revocada_en = UTC_TIMESTAMP() WHERE usuario_id = ? AND revocada_en IS NULL', [u.id]);
    await cx.execute('DELETE FROM intentos_pin WHERE telefono = ?', [u.telefono]); // desbloquea el login
    // Nunca se guarda el PIN en la auditoría.
    await auditar(cx, req, 'usuario_pin_asignado', 'usuarios', u.id, null, { pin_cambiado: true });
    return { datos: { id: Number(u.id), estado: u.estado } };
  });
  if (r.e) return error(res, ...r.e);
  return ok(res, { usuario: r.datos, mensaje: 'PIN asignado. Comunícaselo al usuario por WhatsApp.' });
});

// Soporte: la cola administrativa muestra tickets y el administrador puede responderlos con auditoría.
rutaAdmin.get('/soporte/tickets', ...soloAdmin, async (req, res) => {
  const estado = String(req.query.estado ?? '').trim();
  const estados = ['abierto', 'en_revision', 'resuelto', 'cerrado'];
  if (estado && !estados.includes(estado)) return error(res, 422, 'FILTRO_INVALIDO', 'Estado de ticket no válido.');
  const params = [];
  const where = estado ? 'WHERE r.estado=?' : '';
  if (estado) params.push(estado);
  const [tickets] = await db.execute(
    `SELECT r.id, r.usuario_id, u.nombre, u.apellido, u.telefono, u.email,
            r.viaje_id, r.pedido_id, r.envio_id, r.categoria, r.descripcion,
            r.estado, r.respuesta, r.atendido_por, r.creado_en, r.resuelto_en
       FROM reclamos r JOIN usuarios u ON u.id=r.usuario_id
       ${where}
      ORDER BY FIELD(r.estado,'abierto','en_revision','resuelto','cerrado'), r.creado_en ASC
      LIMIT 200`, params,
  );
  return ok(res, { tickets: tickets.map((t) => ({ ...t, id: Number(t.id), usuario_id: Number(t.usuario_id), viaje_id: t.viaje_id == null ? null : Number(t.viaje_id), pedido_id: t.pedido_id == null ? null : Number(t.pedido_id), envio_id: t.envio_id == null ? null : Number(t.envio_id), atendido_por: t.atendido_por == null ? null : Number(t.atendido_por) })) });
});

rutaAdmin.post('/soporte/tickets/:id/responder', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'TICKET_NO_ENCONTRADO', 'No se encontró el ticket.');
  const respuesta = String(req.body?.respuesta ?? '').trim();
  const estado = String(req.body?.estado ?? 'resuelto');
  if (respuesta.length < 2 || respuesta.length > 4000) return error(res, 422, 'RESPUESTA_INVALIDA', 'Escribe una respuesta de entre 2 y 4.000 caracteres.');
  if (!['en_revision', 'resuelto', 'cerrado'].includes(estado)) return error(res, 422, 'ESTADO_INVALIDO', 'El estado debe ser en_revision, resuelto o cerrado.');
  const resultado = await conTransaccion(async (cx) => {
    const [filas] = await cx.execute('SELECT id, estado, respuesta FROM reclamos WHERE id=? FOR UPDATE', [req.params.id]);
    const ticket = filas[0];
    if (!ticket) return { e: [404, 'TICKET_NO_ENCONTRADO', 'No se encontró el ticket.'] };
    await cx.execute(
      `UPDATE reclamos SET respuesta=?, estado=?, atendido_por=?,
              resuelto_en=IF(? IN ('resuelto','cerrado'), UTC_TIMESTAMP(), NULL)
        WHERE id=?`,
      [respuesta, estado, req.usuario.id, estado, ticket.id],
    );
    await auditar(cx, req, 'ticket_soporte_respondido', 'reclamos', ticket.id,
      { estado: ticket.estado, respuesta: ticket.respuesta }, { estado, respuesta, atendido_por: req.usuario.id });
    return { datos: { id: Number(ticket.id), estado, respuesta, mensaje: 'Respuesta guardada.' } };
  });
  if (resultado.e) return error(res, ...resultado.e);
  return ok(res, resultado.datos);
});

// Opiniones y calificaciones: consulta de solo lectura para el administrador.
// Los datos de identidad que se muestran son nombres; nunca se exponen tokens ni datos de autenticación.
rutaAdmin.get('/calificaciones', ...soloAdmin, async (req, res) => {
  const tipo = String(req.query.tipo ?? '').trim();
  const puntaje = String(req.query.puntaje ?? '').trim();
  if (tipo && !['conductor', 'comercio', 'envio', 'app'].includes(tipo)) {
    return error(res, 422, 'FILTRO_INVALIDO', 'Tipo de calificación no válido.');
  }
  if (puntaje && !/^[1-5]$/.test(puntaje)) {
    return error(res, 422, 'FILTRO_INVALIDO', 'La puntuación debe ser de 1 a 5 estrellas.');
  }
  const [filas] = await db.execute(
    `SELECT * FROM (
       SELECT k.id, 'conductor' AS tipo, k.viaje_id AS servicio_id,
              CONCAT_WS(' ', u.nombre, u.apellido) AS calificador,
              CONCAT_WS(' ', uc.nombre, uc.apellido) AS calificado,
              k.puntaje, k.comentario, NULL AS app_version, k.creado_en
         FROM calificaciones k
         JOIN usuarios u ON u.id = k.calificador_id
         JOIN usuarios uc ON uc.id = k.calificado_id
       UNION ALL
       SELECT kc.id, 'comercio' AS tipo, kc.pedido_id AS servicio_id,
              CONCAT_WS(' ', u.nombre, u.apellido) AS calificador,
              e.nombre_comercial AS calificado,
              kc.puntaje, kc.comentario, NULL AS app_version, kc.creado_en
         FROM calificaciones_comercio kc
         JOIN usuarios u ON u.id = kc.calificador_id
         JOIN empresas e ON e.id = kc.empresa_id
       UNION ALL
       SELECT ke.id, 'envio' AS tipo, ke.envio_id AS servicio_id,
              CONCAT_WS(' ', u.nombre, u.apellido) AS calificador,
              CONCAT_WS(' ', uc.nombre, uc.apellido) AS calificado,
              ke.puntaje, ke.comentario, NULL AS app_version, ke.creado_en
         FROM calificaciones_envios ke
         JOIN usuarios u ON u.id = ke.calificador_id
         JOIN usuarios uc ON uc.id = ke.calificado_id
       UNION ALL
       SELECT ka.id, 'app' AS tipo, NULL AS servicio_id,
              CONCAT_WS(' ', u.nombre, u.apellido) AS calificador,
              'De Volada' AS calificado,
              ka.puntaje, ka.comentario, ka.app_version,
              COALESCE(ka.actualizado_en, ka.creado_en) AS creado_en
         FROM calificaciones_app ka
         JOIN usuarios u ON u.id = ka.usuario_id
     ) AS opiniones
     WHERE (? = '' OR tipo = ?)
       AND (? = '' OR puntaje = CAST(? AS UNSIGNED))
     ORDER BY creado_en DESC LIMIT 300`,
    [tipo, tipo, puntaje, puntaje],
  );
  return ok(res, { calificaciones: filas.map((f) => ({ ...f, id: Number(f.id), servicio_id: f.servicio_id == null ? null : Number(f.servicio_id), puntaje: Number(f.puntaje) })) });
});

// Consulta administrativa de envíos: nunca devuelve hashes, PIN cifrados ni códigos temporales.
rutaAdmin.get('/envios', ...soloAdmin, async (req, res) => {
  const estado = String(req.query.estado ?? '').trim();
  const estados = ['solicitado','asignado','recogido','en_camino','en_punto_entrega','entregado','cancelado','requiere_revision'];
  if (estado && !estados.includes(estado)) return error(res, 422, 'FILTRO_INVALIDO', 'Estado de envío no válido.');
  const params = [];
  const where = estado ? 'WHERE e.estado=?' : '';
  if (estado) params.push(estado);
  const [envios] = await db.execute(
    `SELECT e.id,e.estado,e.tipo_vehiculo,e.descripcion_paquete,e.recogida_nombre,e.recogida_telefono,
            e.recogida_direccion,e.entrega_nombre,e.entrega_telefono,e.entrega_direccion,
            e.distancia_m,e.tarifa_estimada,e.comision_monto,e.metodo_pago,e.creado_en,e.asignado_en,
            e.recogido_en,e.llegada_en,e.entregado_en,
            ur.nombre AS remitente_nombre,ur.apellido AS remitente_apellido,
            ud.nombre AS destinatario_nombre,ud.apellido AS destinatario_apellido,
            uc.nombre AS conductor_nombre,uc.apellido AS conductor_apellido
       FROM envios e JOIN usuarios ur ON ur.id=e.remitente_id JOIN usuarios ud ON ud.id=e.destinatario_id
       LEFT JOIN conductores c ON c.id=e.conductor_id LEFT JOIN usuarios uc ON uc.id=c.usuario_id
       ${where}
      ORDER BY FIELD(e.estado,'requiere_revision','solicitado','asignado','recogido','en_camino','en_punto_entrega','entregado','cancelado'), e.creado_en DESC
      LIMIT 200`, params,
  );
  return ok(res, { envios: envios.map((e) => ({ ...e, id: Number(e.id), distancia_m: e.distancia_m == null ? null : Number(e.distancia_m), tarifa_estimada: Math.round(Number(e.tarifa_estimada)), comision_monto: Math.round(Number(e.comision_monto)) })) });
});

rutaAdmin.get('/viajes', ...soloAdmin, async (req, res) => {
  const estado = String(req.query.estado ?? '').trim();
  const validos = ['solicitado','aceptado','conductor_llego','en_curso','finalizado','cancelado_pasajero','cancelado_conductor','expirado','requiere_revision','programado_pendiente','programado_asignado'];
  if (estado && !validos.includes(estado)) return error(res, 422, 'FILTRO_INVALIDO', 'Estado de viaje no válido.');
  const params = [];
  const where = estado ? 'WHERE v.estado=?' : '';
  if (estado) params.push(estado);
  const [viajes] = await db.execute(
    `SELECT v.id,v.estado,v.pasajero_id,up.nombre AS pasajero_nombre,up.telefono AS pasajero_telefono,
            v.conductor_id,uc.nombre AS conductor_nombre,uc.telefono AS conductor_telefono,
            v.origen_direccion,v.destino_direccion,v.tarifa_estimada,v.tarifa_final,v.metodo_pago,
            v.comision_monto,v.ganancia_conductor,v.solicitado_en,v.aceptado_en,v.finalizado_en,v.motivo_revision
       FROM viajes v JOIN usuarios up ON up.id=v.pasajero_id
       LEFT JOIN conductores c ON c.id=v.conductor_id LEFT JOIN usuarios uc ON uc.id=c.usuario_id
       ${where} ORDER BY v.solicitado_en DESC LIMIT 200`, params,
  );
  return ok(res, { viajes: viajes.map((v) => ({ ...v, tarifa_estimada: Math.round(Number(v.tarifa_estimada) || 0), tarifa_final: v.tarifa_final == null ? null : Math.round(Number(v.tarifa_final) || 0), comision_monto: v.comision_monto == null ? null : Math.round(Number(v.comision_monto) || 0), ganancia_conductor: v.ganancia_conductor == null ? null : Math.round(Number(v.ganancia_conductor) || 0) })) });
});

rutaAdmin.get('/pedidos', ...soloAdmin, async (req, res) => {
  const estado = String(req.query.estado ?? '').trim();
  const validos = ['creado','aceptado_comercio','buscando_repartidor','asignado','recogido','en_camino','entregado','cancelado','fallido','requiere_revision','reembolso_pendiente','recogido_legacy'];
  if (estado && !validos.includes(estado)) return error(res, 422, 'FILTRO_INVALIDO', 'Estado de pedido no válido.');
  const params = [];
  const where = estado ? 'WHERE p.estado=?' : '';
  if (estado) params.push(estado);
  const [pedidos] = await db.execute(
    `SELECT p.id,p.estado,p.empresa_id,e.nombre_comercial,p.pasajero_id,up.nombre AS cliente_nombre,
            p.conductor_id,uc.nombre AS conductor_nombre,p.subtotal_productos,p.tarifa_envio,p.monto_a_cobrar,
            p.metodo_pago_producto,p.estado_pago_producto,p.metodo_pago_delivery,p.estado_pago_delivery,
            p.comision_venta_monto,p.comision_monto,p.estado_reembolso,p.referencia_reembolso,
            p.creado_en,p.expira_en,p.entregado_en,p.revision_motivo
       FROM pedidos p JOIN empresas e ON e.id=p.empresa_id
       LEFT JOIN usuarios up ON up.id=p.pasajero_id
       LEFT JOIN conductores c ON c.id=p.conductor_id LEFT JOIN usuarios uc ON uc.id=c.usuario_id
       ${where} ORDER BY p.creado_en DESC LIMIT 200`, params,
  );
  return ok(res, { pedidos: pedidos.map((p) => ({ ...p, tarifa_envio: Math.round(Number(p.tarifa_envio) || 0), comision_monto: Math.round(Number(p.comision_monto) || 0) })) });
});

rutaAdmin.get('/pedidos/reembolsos', ...soloAdmin, async (_req, res) => {
  const [pedidos] = await db.execute(
    `SELECT p.id,p.estado,p.estado_reembolso,p.empresa_id,e.nombre_comercial,p.pasajero_id,
            u.nombre AS cliente_nombre,u.telefono AS cliente_telefono,p.subtotal_productos,
            p.reembolso_solicitado_en,p.referencia_reembolso,p.revision_motivo,p.creado_en
       FROM pedidos p JOIN empresas e ON e.id=p.empresa_id
       LEFT JOIN usuarios u ON u.id=p.pasajero_id
      WHERE p.estado='reembolso_pendiente' AND p.estado_reembolso='pendiente'
      ORDER BY p.reembolso_solicitado_en ASC,p.id ASC LIMIT 200`,
  );
  return ok(res, { pedidos: pedidos.map((p) => ({ ...p, tarifa_envio: Math.round(Number(p.tarifa_envio) || 0), comision_monto: Math.round(Number(p.comision_monto) || 0) })) });
});

// GET /admin/auditoria?limite=50&pagina=1 — historial de solo lectura.
rutaAdmin.get('/auditoria', ...soloAdmin, async (req, res) => {
  const limite = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limite ?? '50'), 10) || 50));
  const pagina = Math.max(1, Number.parseInt(String(req.query.pagina ?? '1'), 10) || 1);
  const offset = (pagina - 1) * limite;
  const accion = typeof req.query.accion === 'string' ? req.query.accion.trim().slice(0, 80) : '';
  const entidad = typeof req.query.entidad === 'string' ? req.query.entidad.trim().slice(0, 50) : '';
  const condiciones = [];
  const valores = [];
  if (accion) { condiciones.push('a.accion = ?'); valores.push(accion); }
  if (entidad) { condiciones.push('a.entidad = ?'); valores.push(entidad); }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const [filas] = await db.execute(
    `SELECT a.id, a.usuario_id, u.nombre AS usuario_nombre, u.apellido AS usuario_apellido,
            a.accion, a.entidad, a.entidad_id, a.datos_antes, a.datos_despues,
            a.ip_origen, a.creado_en
       FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
       ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...valores, limite, offset],
  );
  const [[conteo]] = await db.execute(`SELECT COUNT(*) AS total FROM auditoria a ${where}`, valores);
  return ok(res, { eventos: filas, pagina, limite, total: Number(conteo.total) });
});

function validarMotivo(valor) {
  const motivo = String(valor ?? '').trim();
  if (motivo.length < 5 || motivo.length > 255) {
    return { error: 'Escribe el motivo (entre 5 y 255 caracteres).' };
  }
  return { motivo };
}

/** Ejecuta `fn(conexion)` dentro de una transacción; deshace todo si algo falla. */
async function conTransaccion(fn) {
  const conexion = await db.getConnection();
  try {
    await conexion.beginTransaction();
    const resultado = await fn(conexion);
    await conexion.commit();
    return resultado;
  } catch (e) {
    await conexion.rollback().catch(() => {});
    throw e;
  } finally {
    conexion.release();
  }
}

/** Toda acción de un administrador queda en la tabla inmutable `auditoria`. */
async function auditar(conexion, req, accion, entidad, entidadId, antes, despues) {
  await conexion.execute(
    `INSERT INTO auditoria (usuario_id, accion, entidad, entidad_id, datos_antes, datos_despues, ip_origen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      req.usuario.id, accion, entidad, entidadId,
      antes ? JSON.stringify(antes) : null,
      despues ? JSON.stringify(despues) : null,
      req.ip ?? null,
    ],
  );
}

// GET /admin/conductores?estado=en_revision
// Cola de revisión. Por defecto muestra las postulaciones en revisión, las más antiguas primero.
rutaAdmin.get('/conductores', ...soloAdmin, async (req, res) => {
  const estado = String(req.query.estado ?? 'en_revision');
  if (!ESTADOS_COLA.includes(estado)) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', {
      estado: `Debe ser uno de: ${ESTADOS_COLA.join(', ')}.`,
    });
  }
  const [filas] = await db.execute(
    `SELECT c.id, c.estado_aprobacion, u.nombre, u.apellido, u.telefono, ci.nombre AS ciudad,
            c.actualizado_en,
            (SELECT COUNT(*) FROM documentos_conductor d WHERE d.conductor_id = c.id AND d.estado = 'aprobado') AS docs_aprobados,
            (SELECT COUNT(*) FROM documentos_conductor d WHERE d.conductor_id = c.id AND d.estado = 'pendiente') AS docs_pendientes
       FROM conductores c
       JOIN usuarios u ON u.id = c.usuario_id
       LEFT JOIN ciudades ci ON ci.id = u.ciudad_id
      WHERE c.estado_aprobacion = ?
      ORDER BY c.actualizado_en ASC
      LIMIT 50`,
    [estado],
  );
  ok(res, { conductores: filas });
});

// GET /admin/conductores/:id : datos, moto y documentos (NUNCA la ruta de los archivos)
rutaAdmin.get('/conductores/:id', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Conductor no encontrado.');

  const [cs] = await db.execute(
    `SELECT c.id, c.estado_aprobacion, c.estado_operativo, c.motivo_rechazo,
            c.documento_identidad, c.licencia_numero, c.licencia_categoria,
            DATE_FORMAT(c.licencia_vence_en, '%Y-%m-%d') AS licencia_vence_en,
            u.id AS usuario_id, u.nombre, u.apellido, u.telefono, u.sexo, ci.nombre AS ciudad,
            DATE_FORMAT(u.fecha_nacimiento, '%Y-%m-%d') AS fecha_nacimiento
       FROM conductores c
       JOIN usuarios u ON u.id = c.usuario_id
       LEFT JOIN ciudades ci ON ci.id = u.ciudad_id
      WHERE c.id = ?`,
    [req.params.id],
  );
  if (!cs[0]) return error(res, 404, 'NO_ENCONTRADO', 'Conductor no encontrado.');

  const [motos] = await db.execute(
    'SELECT tipo_vehiculo, placa, marca, modelo, anio, color, cilindrada_cc FROM motos WHERE conductor_id = ?',
    [req.params.id],
  );
  const [docs] = await db.execute(
    `SELECT id, tipo, estado, motivo_rechazo,
            DATE_FORMAT(vence_en, '%Y-%m-%d') AS vence_en, creado_en, revisado_en
       FROM documentos_conductor WHERE conductor_id = ? ORDER BY tipo, id DESC`,
    [req.params.id],
  );
  ok(res, { conductor: cs[0], moto: motos[0] ?? null, documentos: docs });
});

// GET /admin/documentos/:id/archivo : la foto, solo para el admin con sesión. Nunca se expone la ruta.
// Cada visualización queda en auditoría.
rutaAdmin.get('/documentos/:id/archivo', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Documento no encontrado.');
  const [ds] = await db.execute(
    'SELECT id, tipo, conductor_id, archivo_ruta FROM documentos_conductor WHERE id = ?',
    [req.params.id],
  );
  const d = ds[0];
  if (!d) return error(res, 404, 'NO_ENCONTRADO', 'Documento no encontrado.');
  let archivo;
  try {
    archivo = await leerDocumento(d.archivo_ruta);
  } catch {
    return error(res, 404, 'ARCHIVO_NO_DISPONIBLE', 'El archivo no está disponible.');
  }
  await auditar(db, req, 'documento_visto', 'documentos_conductor', d.id, null,
    { tipo: d.tipo, conductor_id: d.conductor_id });
  res.set({
    'Content-Type': archivo.mime,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  });
  res.send(archivo.buffer);
});

// POST /admin/documentos/:id/aprobar
rutaAdmin.post('/documentos/:id/aprobar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Documento no encontrado.');

  const r = await conTransaccion(async (cx) => {
    const [ds] = await cx.execute(
      `SELECT d.id, d.tipo, d.estado, d.conductor_id, c.estado_aprobacion,
              (d.vence_en IS NOT NULL AND d.vence_en < ${HOY_BO}) AS vencido
         FROM documentos_conductor d JOIN conductores c ON c.id = d.conductor_id
        WHERE d.id = ? FOR UPDATE`,
      [req.params.id],
    );
    const d = ds[0];
    if (!d) return { e: [404, 'NO_ENCONTRADO', 'Documento no encontrado.'] };
    if (d.estado !== 'pendiente') {
      return { e: [409, 'ESTADO_INVALIDO', 'Solo se puede aprobar un documento pendiente.'] };
    }
    if (d.estado_aprobacion !== 'en_revision') {
      return { e: [409, 'ESTADO_INVALIDO', 'La postulación no está en revisión.'] };
    }
    if (Number(d.vencido) === 1) {
      return { e: [409, 'DOCUMENTO_VENCIDO', 'El documento ya está vencido. Recházalo con un motivo.'] };
    }
    await cx.execute(
      `UPDATE documentos_conductor
          SET estado = 'aprobado', motivo_rechazo = NULL, revisado_por = ?, revisado_en = UTC_TIMESTAMP()
        WHERE id = ?`,
      [req.usuario.id, d.id],
    );
    await auditar(cx, req, 'documento_aprobado', 'documentos_conductor', d.id,
      { estado: d.estado }, { estado: 'aprobado', tipo: d.tipo, conductor_id: d.conductor_id });
    return { datos: { id: d.id, tipo: d.tipo, estado: 'aprobado' } };
  });
  if (r.e) return error(res, ...r.e);
  ok(res, r.datos);
});

// POST /admin/documentos/:id/rechazar   { motivo }
rutaAdmin.post('/documentos/:id/rechazar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Documento no encontrado.');
  const m = validarMotivo(req.body?.motivo);
  if (m.error) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', { motivo: m.error });

  const r = await conTransaccion(async (cx) => {
    const [ds] = await cx.execute(
      `SELECT d.id, d.tipo, d.estado, d.conductor_id, c.estado_aprobacion
         FROM documentos_conductor d JOIN conductores c ON c.id = d.conductor_id
        WHERE d.id = ? FOR UPDATE`,
      [req.params.id],
    );
    const d = ds[0];
    if (!d) return { e: [404, 'NO_ENCONTRADO', 'Documento no encontrado.'] };
    if (!['pendiente', 'aprobado'].includes(d.estado)) {
      return { e: [409, 'ESTADO_INVALIDO', 'Este documento no se puede rechazar en su estado actual.'] };
    }
    if (d.estado_aprobacion !== 'en_revision') {
      return { e: [409, 'ESTADO_INVALIDO', 'La postulación no está en revisión.'] };
    }
    await cx.execute(
      `UPDATE documentos_conductor
          SET estado = 'rechazado', motivo_rechazo = ?, revisado_por = ?, revisado_en = UTC_TIMESTAMP()
        WHERE id = ?`,
      [m.motivo, req.usuario.id, d.id],
    );
    await auditar(cx, req, 'documento_rechazado', 'documentos_conductor', d.id,
      { estado: d.estado }, { estado: 'rechazado', tipo: d.tipo, conductor_id: d.conductor_id, motivo: m.motivo });
    return { datos: { id: d.id, tipo: d.tipo, estado: 'rechazado' } };
  });
  if (r.e) return error(res, ...r.e);
  ok(res, r.datos);
});

// POST /admin/conductores/:id/aprobar
// Solo si están los 7 documentos requeridos aprobados y vigentes y la licencia no está vencida.
// El conductor queda 'offline': decidir cuándo conectarse es de la Etapa 8.
rutaAdmin.post('/conductores/:id/aprobar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Conductor no encontrado.');

  const r = await conTransaccion(async (cx) => {
    const [cs] = await cx.execute(
      `SELECT c.id, c.estado_aprobacion, m.tipo_vehiculo,
              (c.licencia_vence_en IS NULL OR c.licencia_vence_en < ${HOY_BO}) AS licencia_no_vigente
         FROM conductores c LEFT JOIN motos m ON m.conductor_id = c.id WHERE c.id = ? FOR UPDATE`,
      [req.params.id],
    );
    const c = cs[0];
    if (!c) return { e: [404, 'NO_ENCONTRADO', 'Conductor no encontrado.'] };
    if (c.estado_aprobacion !== 'en_revision') {
      return { e: [409, 'ESTADO_INVALIDO', 'Solo se puede aprobar una postulación en revisión.'] };
    }
    if (Number(c.licencia_no_vigente) === 1) {
      return { e: [409, 'LICENCIA_NO_VIGENTE', 'La licencia no está vigente.'] };
    }
    if (!['moto', 'auto'].includes(c.tipo_vehiculo)) {
      return { e: [409, 'VEHICULO_NO_REGISTRADO', 'Registra primero una moto o un auto para poder aprobar la postulación.'] };
    }
    const [vigentes] = await cx.execute(
      `SELECT DISTINCT tipo FROM documentos_conductor
        WHERE conductor_id = ? AND estado = 'aprobado' AND (vence_en IS NULL OR vence_en >= ${HOY_BO})`,
      [c.id],
    );
    const tiene = new Set(vigentes.map((f) => f.tipo));
    const faltan = documentosRequeridosPorVehiculo(c.tipo_vehiculo).filter((t) => !tiene.has(t));
    if (faltan.length > 0) {
      return { e: [409, 'DOCUMENTOS_INCOMPLETOS', 'Faltan documentos aprobados y vigentes.', { faltan: faltan.join(', ') }] };
    }
    await cx.execute(
      `UPDATE conductores
          SET estado_aprobacion = 'aprobado', motivo_rechazo = NULL,
              aprobado_por = ?, aprobado_en = UTC_TIMESTAMP()
        WHERE id = ?`,
      [req.usuario.id, c.id],
    );
    await auditar(cx, req, 'conductor_aprobado', 'conductores', c.id,
      { estado_aprobacion: c.estado_aprobacion }, { estado_aprobacion: 'aprobado', tipo_vehiculo: c.tipo_vehiculo });
    return { datos: { id: c.id, estado_aprobacion: 'aprobado', tipo_vehiculo: c.tipo_vehiculo } };
  });
  if (r.e) return error(res, ...r.e);
  ok(res, r.datos);
});

// POST /admin/conductores/:id/rechazar   { motivo }
// El conductor corrige y vuelve a enviar la postulación.
rutaAdmin.post('/conductores/:id/rechazar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Conductor no encontrado.');
  const m = validarMotivo(req.body?.motivo);
  if (m.error) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', { motivo: m.error });

  const r = await conTransaccion(async (cx) => {
    const [cs] = await cx.execute(
      'SELECT id, estado_aprobacion FROM conductores WHERE id = ? FOR UPDATE',
      [req.params.id],
    );
    const c = cs[0];
    if (!c) return { e: [404, 'NO_ENCONTRADO', 'Conductor no encontrado.'] };
    if (c.estado_aprobacion !== 'en_revision') {
      return { e: [409, 'ESTADO_INVALIDO', 'Solo se puede rechazar una postulación en revisión.'] };
    }
    await cx.execute(
      `UPDATE conductores
          SET estado_aprobacion = 'rechazado', motivo_rechazo = ?, aprobado_por = NULL, aprobado_en = NULL
        WHERE id = ?`,
      [m.motivo, c.id],
    );
    await auditar(cx, req, 'conductor_rechazado', 'conductores', c.id,
      { estado_aprobacion: c.estado_aprobacion }, { estado_aprobacion: 'rechazado', motivo: m.motivo });
    return { datos: { id: c.id, estado_aprobacion: 'rechazado' } };
  });
  if (r.e) return error(res, ...r.e);
  ok(res, r.datos);
});


// ---------------------------------------------------------------------
// Revisión y publicación de comercios (solo administradores).
// ---------------------------------------------------------------------
rutaAdmin.get('/comercios', ...soloAdmin, async (req, res) => {
  const estado = String(req.query.estado ?? 'pendiente');
  const permitidos = ['pendiente', 'aprobado', 'rechazado', 'suspendido'];
  if (!permitidos.includes(estado)) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Estado de comercio no válido.', { estado: `Usa uno de: ${permitidos.join(', ')}.` });
  }
  const [comercios] = await db.execute(
    `SELECT e.id, e.usuario_id, e.nombre_comercial, e.logo_url, e.rubro, e.telefono_contacto,
            e.direccion, e.latitud, e.longitud, e.estado_aprobacion, e.creado_en, e.actualizado_en,
            u.nombre AS responsable_nombre, u.apellido AS responsable_apellido, u.telefono AS responsable_telefono,
            u.email AS responsable_email,
            (SELECT COUNT(*) FROM productos_comercio p WHERE p.empresa_id = e.id AND p.activo = 1) AS productos_activos
       FROM empresas e JOIN usuarios u ON u.id = e.usuario_id
      WHERE e.estado_aprobacion = ? ORDER BY e.actualizado_en ASC LIMIT 100`,
    [estado],
  );
  return ok(res, { comercios });
});

rutaAdmin.get('/comercios/:id', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Comercio no encontrado.');
  const [filas] = await db.execute(
    `SELECT e.*, u.nombre AS responsable_nombre, u.apellido AS responsable_apellido,
            u.telefono AS responsable_telefono, u.email AS responsable_email,
            ci.nombre AS ciudad_responsable
       FROM empresas e JOIN usuarios u ON u.id = e.usuario_id
       LEFT JOIN ciudades ci ON ci.id = u.ciudad_id WHERE e.id = ? LIMIT 1`,
    [req.params.id],
  );
  if (!filas[0]) return error(res, 404, 'NO_ENCONTRADO', 'Comercio no encontrado.');
  const [horarios] = await db.execute(
    'SELECT dia_semana, TIME_FORMAT(abre, "%H:%i") AS abre, TIME_FORMAT(cierra, "%H:%i") AS cierra, cerrado FROM comercio_horarios WHERE empresa_id = ? ORDER BY dia_semana',
    [req.params.id],
  );
  const [productos] = await db.execute(
    'SELECT id, nombre, categoria, descripcion, precio, stock, imagen_url, activo FROM productos_comercio WHERE empresa_id = ? ORDER BY id DESC',
    [req.params.id],
  );
  return ok(res, { comercio: filas[0], horarios, productos });
});

rutaAdmin.post('/comercios/:id/aprobar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Comercio no encontrado.');
  const resultado = await conTransaccion(async (cx) => {
    const [filas] = await cx.execute('SELECT * FROM empresas WHERE id = ? FOR UPDATE', [req.params.id]);
    const empresa = filas[0];
    if (!empresa) return { e: [404, 'NO_ENCONTRADO', 'Comercio no encontrado.'] };
    if (empresa.estado_aprobacion === 'suspendido') return { e: [409, 'COMERCIO_SUSPENDIDO', 'No se puede publicar un comercio suspendido.'] };
    if (!empresa.logo_url || !empresa.rubro || !empresa.direccion || empresa.latitud === null || empresa.longitud === null) {
      return { e: [409, 'PERFIL_INCOMPLETO', 'El comercio necesita logo, rubro, dirección y ubicación antes de ser publicado.'] };
    }
    const [productos] = await cx.execute('SELECT COUNT(*) AS total FROM productos_comercio WHERE empresa_id = ? AND activo = 1', [empresa.id]);
    if (Number(productos[0]?.total ?? 0) < 1) return { e: [409, 'CATALOGO_VACIO', 'Agrega al menos un producto activo al catálogo antes de publicar.'] };
    await cx.execute(
      `UPDATE empresas SET estado_aprobacion = 'aprobado', aprobado_por = ?, aprobado_en = UTC_TIMESTAMP() WHERE id = ?`,
      [req.usuario.id, empresa.id],
    );
    await auditar(cx, req, 'comercio_aprobado', 'empresas', empresa.id,
      { estado_aprobacion: empresa.estado_aprobacion }, { estado_aprobacion: 'aprobado' });
    return { datos: { id: empresa.id, estado_aprobacion: 'aprobado' } };
  });
  if (resultado.e) return error(res, ...resultado.e);
  return ok(res, resultado.datos);
});

rutaAdmin.post('/comercios/:id/rechazar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Comercio no encontrado.');
  const m = validarMotivo(req.body?.motivo);
  if (m.error) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', { motivo: m.error });
  const resultado = await conTransaccion(async (cx) => {
    const [filas] = await cx.execute('SELECT id, estado_aprobacion FROM empresas WHERE id = ? FOR UPDATE', [req.params.id]);
    const empresa = filas[0];
    if (!empresa) return { e: [404, 'NO_ENCONTRADO', 'Comercio no encontrado.'] };
    if (empresa.estado_aprobacion === 'aprobado') return { e: [409, 'COMERCIO_PUBLICADO', 'Despublica o suspende el comercio mediante el proceso administrativo antes de rechazarlo.'] };
    await cx.execute('UPDATE empresas SET estado_aprobacion = \'rechazado\', aprobado_por = NULL, aprobado_en = NULL WHERE id = ?', [empresa.id]);
    await auditar(cx, req, 'comercio_rechazado', 'empresas', empresa.id,
      { estado_aprobacion: empresa.estado_aprobacion }, { estado_aprobacion: 'rechazado', motivo: m.motivo });
    return { datos: { id: empresa.id, estado_aprobacion: 'rechazado', motivo: m.motivo } };
  });
  if (resultado.e) return error(res, ...resultado.e);
  return ok(res, resultado.datos);
});

// ---------------------------------------------------------------------
// Saldo de comisiones De Volada: revisión manual de recargas de conductores y comercios.
// El saldo nunca se acredita desde el móvil; solo un admin autenticado puede confirmar un ingreso real.
// ---------------------------------------------------------------------
rutaAdmin.get('/billetera/recargas', ...soloAdmin, async (req, res) => {
  const estado = String(req.query.estado ?? 'pendiente');
  if (!['pendiente', 'confirmada', 'rechazada'].includes(estado)) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Estado de recarga no válido.');
  }
  const [recargas] = await db.execute(
    `SELECT r.id, r.usuario_id, r.monto, r.metodo, r.referencia_cliente, r.referencia_pago,
            r.estado, r.motivo_revision, r.solicitado_en, u.nombre, u.apellido, u.telefono, u.rol
       FROM recargas_billetera r JOIN usuarios u ON u.id=r.usuario_id
      WHERE r.estado=? ORDER BY r.solicitado_en ASC LIMIT 100`, [estado],
  );
  return ok(res, { recargas });
});

rutaAdmin.post('/billetera/recargas/:id/confirmar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Solicitud de recarga no encontrada.');
  const referenciaPago = String(req.body?.referencia_pago ?? '').trim().slice(0, 100);
  if (referenciaPago.length < 3) return error(res, 422, 'DATOS_INVALIDOS', 'Indica la referencia del pago verificado.');
  const resultado = await conTransaccion(async (cx) => {
    const [rs] = await cx.execute('SELECT * FROM recargas_billetera WHERE id=? LIMIT 1 FOR UPDATE', [req.params.id]);
    const r = rs[0];
    if (!r) return { e: [404, 'NO_ENCONTRADO', 'Solicitud de recarga no encontrada.'] };
    if (r.estado !== 'pendiente') return { e: [409, 'ESTADO_INVALIDO', 'Esta recarga ya fue revisada.'] };
    const [us] = await cx.execute('SELECT id, rol FROM usuarios WHERE id=? LIMIT 1', [r.usuario_id]);
    const usuario = us[0];
    if (!usuario || !['conductor', 'comercio'].includes(usuario.rol)) return { e: [409, 'ROL_NO_ADMITIDO', 'El saldo prepago para comisiones está disponible para conductores y comercios.'] };
    let saldoAntes;
    let saldoDespues;
    if (usuario.rol === 'conductor') {
      const [bs] = await cx.execute(
        `SELECT b.id, b.saldo_prepago, b.estado FROM billeteras b JOIN conductores c ON c.id=b.conductor_id
          WHERE c.usuario_id=? LIMIT 1 FOR UPDATE`, [r.usuario_id],
      );
      const b = bs[0];
      if (!b || b.estado !== 'activa') return { e: [409, 'BILLETERA_NO_ACTIVA', 'La billetera de comisiones del conductor no está activa.'] };
      saldoAntes = Number(b.saldo_prepago);
      saldoDespues = Math.round((saldoAntes + Number(r.monto) + Number.EPSILON) * 100) / 100;
      await cx.execute('UPDATE billeteras SET saldo_prepago=? WHERE id=?', [saldoDespues, b.id]);
      await cx.execute(
        `INSERT INTO movimientos_billetera (billetera_id, cuenta, tipo, monto, saldo_antes, saldo_despues, descripcion, creado_por, idempotency_key)
         VALUES (?, 'prepago', 'recarga', ?, ?, ?, ?, ?, ?)`,
        [b.id, Number(r.monto), saldoAntes, saldoDespues, `Recarga de puntos verificada #${r.id}: +${Number(r.monto)} pts`, req.usuario.id, `recarga:${r.id}`],
      );
    } else {
      const [es] = await cx.execute(
        `SELECT id, saldo_comision FROM empresas WHERE usuario_id=? LIMIT 1 FOR UPDATE`, [r.usuario_id],
      );
      const empresa = es[0];
      if (!empresa) return { e: [409, 'COMERCIO_INCOMPLETO', 'El comercio no tiene una cuenta de comisiones activa.'] };
      saldoAntes = Number(empresa.saldo_comision);
      saldoDespues = Math.round((saldoAntes + Number(r.monto) + Number.EPSILON) * 100) / 100;
      await cx.execute('UPDATE empresas SET saldo_comision=? WHERE id=?', [saldoDespues, empresa.id]);
      await cx.execute(
        `INSERT INTO movimientos_comision_comercio
           (empresa_id, tipo, monto, saldo_antes, saldo_despues, recarga_id, descripcion, idempotency_key, creado_por)
         VALUES (?, 'recarga', ?, ?, ?, ?, ?, ?, ?)`,
        [empresa.id, Number(r.monto), saldoAntes, saldoDespues, r.id, `Recarga de puntos verificada #${r.id}: +${Number(r.monto)} pts`, `recarga:${r.id}`, req.usuario.id],
      );
    }
    await cx.execute(
      `UPDATE recargas_billetera SET estado='confirmada', referencia_pago=?, motivo_revision=NULL,
              revisado_por=?, revisado_en=UTC_TIMESTAMP() WHERE id=?`,
      [referenciaPago, req.usuario.id, r.id],
    );
    await auditar(cx, req, 'recarga_billetera_confirmada', 'recargas_billetera', r.id,
      { estado: 'pendiente' }, { estado: 'confirmada', usuario_id: r.usuario_id, monto: Number(r.monto), referencia_pago: referenciaPago, saldo_despues: saldoDespues });
    // Bs depositados = puntos acreditados (1 a 1). Los puntos no son dinero ni se pueden retirar.
    return { recarga_id: Number(r.id), estado: 'confirmada', usuario_id: Number(r.usuario_id), monto_bs: Number(r.monto), saldo_despues_bs: saldoDespues, puntos_acreditados: Number(r.monto), puntos_saldo: saldoDespues };
  });
  if (resultado.e) return error(res, ...resultado.e);
  return ok(res, resultado);
});

rutaAdmin.post('/billetera/recargas/:id/rechazar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Solicitud de recarga no encontrada.');
  const m = validarMotivo(req.body?.motivo);
  if (m.error) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', { motivo: m.error });
  const resultado = await conTransaccion(async (cx) => {
    const [rs] = await cx.execute('SELECT id, usuario_id, monto, estado FROM recargas_billetera WHERE id=? LIMIT 1 FOR UPDATE', [req.params.id]);
    const r = rs[0];
    if (!r) return { e: [404, 'NO_ENCONTRADO', 'Solicitud de recarga no encontrada.'] };
    if (r.estado !== 'pendiente') return { e: [409, 'ESTADO_INVALIDO', 'Esta recarga ya fue revisada.'] };
    await cx.execute(
      `UPDATE recargas_billetera SET estado='rechazada', motivo_revision=?, revisado_por=?, revisado_en=UTC_TIMESTAMP() WHERE id=?`,
      [m.motivo, req.usuario.id, r.id],
    );
    await auditar(cx, req, 'recarga_billetera_rechazada', 'recargas_billetera', r.id,
      { estado: 'pendiente' }, { estado: 'rechazada', usuario_id: r.usuario_id, monto: Number(r.monto), motivo: m.motivo });
    return { id: Number(r.id), estado: 'rechazada', motivo: m.motivo };
  });
  if (resultado.e) return error(res, ...resultado.e);
  return ok(res, resultado);
});

rutaAdmin.get('/billetera/retiros', ...soloAdmin, async (req, res) => {
  const estado = String(req.query.estado ?? 'solicitado');
  if (!['solicitado', 'en_revision', 'aprobado', 'pagado', 'rechazado', 'cancelado'].includes(estado)) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Estado de retiro no válido.');
  }
  const [retiros] = await db.execute(
    `SELECT r.id, r.monto, r.metodo, r.destino_detalle, r.estado, r.referencia_pago, r.solicitado_en,
            u.id AS usuario_id, u.nombre, u.apellido, u.telefono
       FROM retiros r JOIN billeteras b ON b.id=r.billetera_id
       JOIN conductores c ON c.id=b.conductor_id JOIN usuarios u ON u.id=c.usuario_id
      WHERE r.estado=? ORDER BY r.solicitado_en ASC LIMIT 100`, [estado],
  );
  return ok(res, { retiros });
});

rutaAdmin.post('/billetera/retiros/:id/pagar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Solicitud de retiro no encontrada.');
  const referencia = String(req.body?.referencia_pago ?? '').trim().slice(0, 100);
  if (referencia.length < 3) return error(res, 422, 'DATOS_INVALIDOS', 'Indica la referencia del desembolso realizado.');
  const resultado = await conTransaccion(async (cx) => {
    const [rs] = await cx.execute('SELECT id, monto, estado FROM retiros WHERE id=? LIMIT 1 FOR UPDATE', [req.params.id]);
    const r = rs[0];
    if (!r) return { e: [404, 'NO_ENCONTRADO', 'Solicitud de retiro no encontrada.'] };
    if (!['solicitado', 'en_revision', 'aprobado'].includes(r.estado)) return { e: [409, 'ESTADO_INVALIDO', 'Este retiro ya fue cerrado.'] };
    await cx.execute(
      `UPDATE retiros SET estado='pagado', referencia_pago=?, revisado_por=?, revisado_en=UTC_TIMESTAMP(), pagado_en=UTC_TIMESTAMP() WHERE id=?`,
      [referencia, req.usuario.id, r.id],
    );
    await auditar(cx, req, 'retiro_billetera_pagado', 'retiros', r.id,
      { estado: r.estado }, { estado: 'pagado', monto: Number(r.monto), referencia_pago: referencia });
    return { id: Number(r.id), estado: 'pagado', referencia_pago: referencia };
  });
  if (resultado.e) return error(res, ...resultado.e);
  return ok(res, resultado);
});

rutaAdmin.post('/billetera/retiros/:id/rechazar', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Solicitud de retiro no encontrada.');
  const m = validarMotivo(req.body?.motivo);
  if (m.error) return error(res, 422, 'DATOS_INVALIDOS', 'Hay datos que corregir.', { motivo: m.error });
  const resultado = await conTransaccion(async (cx) => {
    const [rs] = await cx.execute('SELECT * FROM retiros WHERE id=? LIMIT 1 FOR UPDATE', [req.params.id]);
    const r = rs[0];
    if (!r) return { e: [404, 'NO_ENCONTRADO', 'Solicitud de retiro no encontrada.'] };
    if (!['solicitado', 'en_revision', 'aprobado'].includes(r.estado)) return { e: [409, 'ESTADO_INVALIDO', 'Este retiro ya fue cerrado.'] };
    const [bs] = await cx.execute('SELECT id, saldo_ganancias FROM billeteras WHERE id=? LIMIT 1 FOR UPDATE', [r.billetera_id]);
    const b = bs[0];
    if (!b) return { e: [409, 'BILLETERA_NO_CREADA', 'No se encontró la billetera del conductor.'] };
    const antes = Number(b.saldo_ganancias);
    const despues = Math.round((antes + Number(r.monto) + Number.EPSILON) * 100) / 100;
    await cx.execute('UPDATE billeteras SET saldo_ganancias=? WHERE id=?', [despues, b.id]);
    await cx.execute(
      `INSERT INTO movimientos_billetera (billetera_id, cuenta, tipo, monto, saldo_antes, saldo_despues, retiro_id, descripcion, creado_por, idempotency_key)
       VALUES (?, 'ganancias', 'reembolso', ?, ?, ?, ?, ?, ?, ?)`,
      [b.id, Number(r.monto), antes, despues, r.id, `Devolución del retiro rechazado #${r.id}`, req.usuario.id, `reembolso:retiro:${r.id}`],
    );
    await cx.execute(
      `UPDATE retiros SET estado='rechazado', motivo_rechazo=?, revisado_por=?, revisado_en=UTC_TIMESTAMP() WHERE id=?`,
      [m.motivo, req.usuario.id, r.id],
    );
    await auditar(cx, req, 'retiro_billetera_rechazado', 'retiros', r.id,
      { estado: r.estado }, { estado: 'rechazado', monto: Number(r.monto), motivo: m.motivo, saldo_reintegrado: despues });
    return { id: Number(r.id), estado: 'rechazado', saldo_ganancias_bs: despues };
  });
  if (resultado.e) return error(res, ...resultado.e);
  return ok(res, resultado);
});

// ---------------------------------------------------------------------
// Cola de conciliación: operaciones que alcanzaron el destino pero tenían un saldo
// reservado inconsistente. No aplica descuentos parciales ni permite ignorar pagos.
// ---------------------------------------------------------------------
rutaAdmin.get('/pedidos/revision', ...soloAdmin, async (_req, res) => {
  const [pedidos] = await db.execute(
    `SELECT p.id,p.estado,p.revision_motivo,p.revision_en,p.pasajero_id,p.empresa_id,p.conductor_id,
            p.subtotal_productos,p.tarifa_envio,p.comision_venta_monto,p.comision_monto,
            p.estado_pago_producto,p.estado_pago_delivery,p.creado_en,e.nombre_comercial,
            uc.nombre AS conductor_nombre,uc.apellido AS conductor_apellido
       FROM pedidos p JOIN empresas e ON e.id=p.empresa_id
       LEFT JOIN conductores c ON c.id=p.conductor_id LEFT JOIN usuarios uc ON uc.id=c.usuario_id
      WHERE p.estado='requiere_revision' ORDER BY p.revision_en ASC,p.id ASC LIMIT 100`,
  );
  return ok(res, { pedidos });
});

rutaAdmin.post('/pedidos/:id/resolver-finalizacion', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Pedido no encontrado.');
  const resultado = await conTransaccion(async (cx) => {
    const [ps] = await cx.execute('SELECT * FROM pedidos WHERE id=? LIMIT 1 FOR UPDATE', [req.params.id]);
    const p = ps[0];
    if (!p) return { e: [404, 'NO_ENCONTRADO', 'Pedido no encontrado.'] };
    if (p.estado !== 'requiere_revision') return { e: [409, 'ESTADO_INVALIDO', 'El pedido ya no está en la cola de revisión.'] };
    if (p.estado_pago_producto !== 'confirmado' || p.estado_pago_delivery !== 'confirmado') return { e: [409, 'PAGOS_NO_CONFIRMADOS', 'Antes de resolver, verifica ambos cobros directos con sus receptores.'] };
    const [ws] = await cx.execute('SELECT id,saldo_prepago,saldo_comision_reservado FROM billeteras WHERE conductor_id=? LIMIT 1 FOR UPDATE', [p.conductor_id]);
    const [es] = await cx.execute('SELECT id,saldo_comision,saldo_comision_reservado FROM empresas WHERE id=? LIMIT 1 FOR UPDATE', [p.empresa_id]);
    const w = ws[0], e = es[0];
    if (!w || !e) return { e: [409, 'CUENTAS_INCOMPLETAS', 'No se encontró la billetera del conductor o el saldo de comisión del comercio.'] };
    const comDelivery = Math.round((Number(p.comision_monto) + Number.EPSILON) * 100) / 100;
    const comVenta = Math.round((Number(p.comision_venta_monto) + Number.EPSILON) * 100) / 100;
    const [[otherOrdersDriver]] = await cx.execute(
      `SELECT COALESCE(SUM(comision_monto),0) AS total FROM pedidos
        WHERE conductor_id=? AND id<>? AND comision_delivery_reservada=1 AND estado IN ('asignado','recogido','en_camino','requiere_revision')`, [p.conductor_id,p.id],
    );
    const [[otherTripsDriver]] = await cx.execute(
      `SELECT COALESCE(SUM(COALESCE(comision_monto, ROUND(tarifa_estimada*comision_porcentaje/100,0))),0) AS total FROM viajes
        WHERE conductor_id=? AND comision_reservada=1 AND estado IN ('aceptado','conductor_llego','en_curso','requiere_revision')`, [p.conductor_id],
    );
    const reservadoOtrosDriver = Number(otherOrdersDriver.total) + Number(otherTripsDriver.total);
    const [[otherOrdersCompany]] = await cx.execute(
      `SELECT COALESCE(SUM(comision_venta_monto),0) AS total FROM pedidos
        WHERE empresa_id=? AND id<>? AND comision_venta_reservada=1 AND estado IN ('creado','buscando_repartidor','asignado','recogido','en_camino','requiere_revision')`, [p.empresa_id,p.id],
    );
    const reservadoOtrosComercio = Number(otherOrdersCompany.total);
    if (Number(w.saldo_prepago) < reservadoOtrosDriver + comDelivery) return { e: [409, 'SALDO_CONDUCTOR_INSUFICIENTE', 'Recarga o concilia el saldo prepago del conductor antes de resolver este pedido.', { saldo_bs: Number(w.saldo_prepago), reservas_activas_bs: reservadoOtrosDriver, comision_pedido_bs: comDelivery }] };
    if (Number(e.saldo_comision) < reservadoOtrosComercio + comVenta) return { e: [409, 'SALDO_COMERCIO_INSUFICIENTE', 'El comercio debe tener saldo suficiente para la comisión y las reservas activas antes de resolver este pedido.', { saldo_bs: Number(e.saldo_comision), reservas_activas_bs: reservadoOtrosComercio, comision_pedido_bs: comVenta }] };
    const wAntes = Number(w.saldo_prepago), wDespues = Math.round((wAntes - comDelivery + Number.EPSILON) * 100) / 100;
    const eAntes = Number(e.saldo_comision), eDespues = Math.round((eAntes - comVenta + Number.EPSILON) * 100) / 100;
    await cx.execute('UPDATE billeteras SET saldo_prepago=?,saldo_comision_reservado=? WHERE id=?', [wDespues,reservadoOtrosDriver,w.id]);
    await cx.execute('UPDATE empresas SET saldo_comision=?,saldo_comision_reservado=? WHERE id=?', [eDespues,reservadoOtrosComercio,e.id]);
    if (comDelivery > 0) await cx.execute(
      `INSERT INTO movimientos_billetera (billetera_id,cuenta,tipo,monto,saldo_antes,saldo_despues,pedido_id,descripcion,creado_por,idempotency_key)
       VALUES (?,'prepago','comision',?,?,?,?,?,?,?)`,
      [w.id,-comDelivery,wAntes,wDespues,p.id,`Comisión delivery pedido #${p.id} (revisión admin)`,req.usuario.id,`comision:pedido:${p.id}`],
    );
    if (comVenta > 0) await cx.execute(
      `INSERT INTO movimientos_comision_comercio (empresa_id,tipo,monto,saldo_antes,saldo_despues,pedido_id,descripcion,idempotency_key,creado_por)
       VALUES (?,'comision_venta',?,?,?,?,?,?,?)`,
      [e.id,-comVenta,eAntes,eDespues,p.id,`Comisión venta pedido #${p.id} (revisión admin)`,`comision:venta:pedido:${p.id}`,req.usuario.id],
    );
    await cx.execute("UPDATE pedidos SET estado='entregado',entregado_en=COALESCE(entregado_en,UTC_TIMESTAMP()),comision_delivery_reservada=0,comision_venta_reservada=0,revision_motivo=NULL WHERE id=?", [p.id]);
    const minSaldo = config.puntosPorViaje;
    await cx.execute('UPDATE conductores SET estado_operativo=? WHERE id=?', [wDespues - reservadoOtrosDriver < minSaldo ? 'bloqueado_saldo' : 'disponible', p.conductor_id]);
    await auditar(cx, req, 'pedido_revision_resuelto', 'pedidos', p.id, { estado: p.estado, revision_motivo: p.revision_motivo }, { estado: 'entregado', comision_conductor_bs: comDelivery, comision_comercio_bs: comVenta, resuelto_por: req.usuario.id });
    return { pedido_id: Number(p.id), estado: 'entregado', comision_conductor_bs: comDelivery, comision_comercio_bs: comVenta, mensaje: 'Pedido conciliado y finalizado. Los dos descuentos quedaron registrados.' };
  });
  if (resultado.e) return error(res, ...resultado.e);
  await notificarPedidoActualizado(Number(req.params.id));
  return ok(res, resultado);
});

rutaAdmin.get('/viajes/revision', ...soloAdmin, async (_req, res) => {
  const [viajes] = await db.execute(
    `SELECT v.id,v.estado,v.motivo_revision,v.pasajero_id,v.conductor_id,v.tarifa_estimada,v.comision_porcentaje,
            v.metodo_pago,v.solicitado_en,up.nombre AS pasajero_nombre,up.apellido AS pasajero_apellido,
            uc.nombre AS conductor_nombre,uc.apellido AS conductor_apellido
       FROM viajes v JOIN usuarios up ON up.id=v.pasajero_id
       LEFT JOIN conductores c ON c.id=v.conductor_id LEFT JOIN usuarios uc ON uc.id=c.usuario_id
      WHERE v.estado='requiere_revision' ORDER BY v.id ASC LIMIT 100`,
  );
  return ok(res, { viajes: viajes.map((v) => ({ ...v, tarifa_estimada: Math.round(Number(v.tarifa_estimada) || 0), tarifa_final: v.tarifa_final == null ? null : Math.round(Number(v.tarifa_final) || 0), comision_monto: v.comision_monto == null ? null : Math.round(Number(v.comision_monto) || 0), ganancia_conductor: v.ganancia_conductor == null ? null : Math.round(Number(v.ganancia_conductor) || 0) })) });
});

rutaAdmin.post('/viajes/:id/resolver-finalizacion', ...soloAdmin, async (req, res) => {
  if (!esId(req.params.id)) return error(res, 404, 'NO_ENCONTRADO', 'Viaje no encontrado.');
  const resultado = await conTransaccion(async (cx) => {
    const [vs] = await cx.execute('SELECT * FROM viajes WHERE id=? LIMIT 1 FOR UPDATE', [req.params.id]);
    const v = vs[0];
    if (!v) return { e: [404, 'NO_ENCONTRADO', 'Viaje no encontrado.'] };
    if (v.estado !== 'requiere_revision') return { e: [409, 'ESTADO_INVALIDO', 'El viaje ya no está en la cola de revisión.'] };
    const [ws] = await cx.execute('SELECT id,saldo_prepago,saldo_comision_reservado FROM billeteras WHERE conductor_id=? LIMIT 1 FOR UPDATE', [v.conductor_id]);
    const w = ws[0];
    if (!w) return { e: [409, 'BILLETERA_NO_CREADA', 'El conductor no tiene billetera activa.'] };
    const [[otherOrders]] = await cx.execute(
      `SELECT COALESCE(SUM(comision_monto),0) AS total FROM pedidos WHERE conductor_id=? AND comision_delivery_reservada=1 AND estado IN ('asignado','recogido','en_camino','requiere_revision')`, [v.conductor_id],
    );
    const [[otherTrips]] = await cx.execute(
      `SELECT COALESCE(SUM(COALESCE(comision_monto, ROUND(tarifa_estimada*comision_porcentaje/100,0))),0) AS total FROM viajes
        WHERE conductor_id=? AND id<>? AND comision_reservada=1 AND estado IN ('aceptado','conductor_llego','en_curso','requiere_revision')`, [v.conductor_id,v.id],
    );
    const reservasOtras = Number(otherOrders.total) + Number(otherTrips.total);
    const tarifa = Math.round(Number(v.tarifa_estimada) || 0);
    // Sistema de puntos: descuento fijo por viaje completado.
    const comision = config.puntosPorViaje;
    const ganancia = tarifa;
    if (Number(w.saldo_prepago) < reservasOtras + comision) return { e: [409, 'SALDO_INSUFICIENTE', 'Recarga o concilia el saldo libre del conductor antes de resolver el viaje.', { saldo_bs: Number(w.saldo_prepago), reservas_activas_bs: reservasOtras, comision_bs: comision }] };
    const antes = Number(w.saldo_prepago), despues = Math.round((antes - comision + Number.EPSILON) * 100) / 100;
    await cx.execute('UPDATE billeteras SET saldo_prepago=?,saldo_comision_reservado=? WHERE id=?', [despues,reservasOtras,w.id]);
    if (comision > 0) await cx.execute(
      `INSERT INTO movimientos_billetera (billetera_id,cuenta,tipo,monto,saldo_antes,saldo_despues,viaje_id,descripcion,creado_por,idempotency_key)
       VALUES (?,'prepago','comision',?,?,?,?,?,?,?)`,
      [w.id,-comision,antes,despues,v.id,`Comisión viaje #${v.id}: -${comision} pts (revisión admin)`,req.usuario.id,`comision:viaje:${v.id}`],
    );
    await cx.execute("UPDATE viajes SET estado='finalizado',tarifa_final=?,comision_monto=?,ganancia_conductor=?,finalizado_en=COALESCE(finalizado_en,UTC_TIMESTAMP()),comision_reservada=0,motivo_revision=NULL WHERE id=?", [tarifa,comision,ganancia,v.id]);
    const minSaldo = config.puntosPorViaje;
    await cx.execute('UPDATE conductores SET estado_operativo=?,total_viajes=total_viajes+1 WHERE id=?', [despues-reservasOtras < minSaldo ? 'bloqueado_saldo' : 'disponible',v.conductor_id]);
    await auditar(cx, req, 'viaje_revision_resuelto', 'viajes', v.id, { estado: v.estado, motivo_revision: v.motivo_revision }, { estado: 'finalizado', comision_bs: comision, saldo_despues: despues });
    return { viaje_id: Number(v.id), estado: 'finalizado', comision_bs: comision, saldo_comision_conductor_bs: despues, mensaje: 'Viaje conciliado y finalizado.' };
  });
  if (resultado.e) return error(res, ...resultado.e);
  await notificarEstadoViaje(Number(req.params.id));
  return ok(res, resultado);
});

async function ajusteNumeroAdmin(clave, predeterminado) {
  const [filas] = await db.execute('SELECT valor FROM configuracion WHERE clave=? LIMIT 1', [clave]);
  const n = Number(filas[0]?.valor);
  return Number.isFinite(n) ? n : predeterminado;
}
