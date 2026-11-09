// Etapa 9 — Tiempo real (Socket.IO).
//
// Principio de diseño: el servidor sigue siendo la única fuente de verdad. Las escrituras
// (ubicación, aceptar, iniciar, finalizar...) siguen entrando por las rutas REST de la Etapa 8,
// que ya validan rol, estado, GPS simulado, radio y saldo. Después de confirmar el cambio en
// MySQL, esas rutas llaman a las funciones de este archivo para AVISAR a las personas
// autorizadas. Los clientes no pueden emitir cambios de estado ni de ubicación por el socket.
//
// Salas:
//   usuario:{id}  todas las conexiones de una persona
//   sesion:{id}   una sesión (para cortar el socket al cerrar sesión)
//   viaje:{id}    pasajero y conductor de un viaje activo (estados y posición del conductor)
//   ofertas:{id}  conductores cercanos a una solicitud (para avisarles que ya no está disponible)
import { Server } from 'socket.io';
import { config } from './config.js';
import { db } from './db.js';
import { hashToken } from './seguridad.js';
import { ajusteNumero } from './servicios/ajustes.js';

let io = null;

const ESTADOS_TERMINALES = ['finalizado', 'cancelado_pasajero', 'cancelado_conductor', 'expirado'];

export function iniciarTiempoReal(httpServer) {
  // Producción (Cloudflare): solo WebSocket. Cloudflare corta peticiones HTTP a los 100 s y el long-polling
  // sufre con eso; los WebSockets sí se mantienen. En desarrollo se conserva polling como respaldo.
  const produccion = config.nodeEnv === 'production';
  const origenes = [...new Set([config.adminWebOrigin, ...config.corsOrigins].filter((o) => /^https?:\/\//.test(o ?? '')))];
  io = new Server(httpServer, {
    serveClient: false,
    transports: produccion ? ['websocket'] : ['websocket', 'polling'],
    // Las apps nativas no envían Origin; para navegadores solo se aceptan los orígenes configurados.
    cors: origenes.length ? { origin: origenes, credentials: false } : { origin: false },
    maxHttpBufferSize: 10_000, // los eventos son diminutos: se rechaza todo lo demás
    pingInterval: 25_000,      // latido cada 25 s: muy por debajo del timeout de inactividad de Cloudflare
    pingTimeout: 60_000,       // tolera redes móviles lentas antes de dar la conexión por perdida
  });

  // Autenticación: el MISMO token de sesión que usa la API REST (se compara su hash en `sesiones`).
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
        return next(new Error('NO_AUTENTICADO'));
      }
      const [filas] = await db.execute(
        `SELECT s.id AS sesion_id, u.id AS usuario_id, u.rol
           FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
          WHERE s.token_hash = ? AND s.revocada_en IS NULL AND s.expira_en > UTC_TIMESTAMP()
            AND u.estado = 'activo' LIMIT 1`,
        [hashToken(token)],
      );
      const f = filas[0];
      if (!f) return next(new Error('SESION_INVALIDA'));
      socket.data = { usuarioId: Number(f.usuario_id), rol: f.rol, sesionId: Number(f.sesion_id), eventos: 0, ventana: Date.now() };
      return next();
    } catch (e) {
      console.error('[tiempo real] autenticación:', e.message);
      return next(new Error('ERROR_INTERNO'));
    }
  });

  io.on('connection', async (socket) => {
    const { usuarioId, sesionId } = socket.data;
    socket.join(`usuario:${usuarioId}`);
    socket.join(`sesion:${sesionId}`);

    // Si la persona ya tenía un viaje en curso (reconexión, app reabierta), vuelve a su sala.
    try {
      const id = await idViajeActivoDe(usuarioId);
      if (id) socket.join(`viaje:${id}`);
    } catch (e) {
      console.error('[tiempo real] sala del viaje activo:', e.message);
    }
    socket.emit('listo', { usuario_id: usuarioId });

    // Tope de eventos entrantes por conexión (anti-abuso): 30 por minuto.
    const permitido = () => {
      const s = socket.data;
      const ahora = Date.now();
      if (ahora - s.ventana > 60_000) { s.ventana = ahora; s.eventos = 0; }
      return ++s.eventos <= 30;
    };

    // El cliente pide unirse a la sala de un viaje: solo se acepta si participa en él.
    socket.on('viaje:unirse', async (viajeId, ack) => {
      const responder = typeof ack === 'function' ? ack : () => {};
      try {
        if (!permitido()) return responder({ ok: false, codigo: 'DEMASIADOS_EVENTOS' });
        const id = Number(viajeId);
        if (!Number.isSafeInteger(id) || id <= 0) return responder({ ok: false, codigo: 'ID_INVALIDO' });
        const [filas] = await db.execute(
          `SELECT v.id FROM viajes v LEFT JOIN conductores c ON c.id = v.conductor_id
            WHERE v.id = ? AND (v.pasajero_id = ? OR c.usuario_id = ?)
              AND v.estado IN ('solicitado','aceptado','conductor_llego','en_curso') LIMIT 1`,
          [id, usuarioId, usuarioId],
        );
        if (!filas[0]) return responder({ ok: false, codigo: 'VIAJE_NO_ENCONTRADO' });
        socket.join(`viaje:${id}`);
        return responder({ ok: true });
      } catch (e) {
        console.error('[tiempo real] viaje:unirse:', e.message);
        return responder({ ok: false, codigo: 'ERROR_INTERNO' });
      }
    });
  });

  return io;
}

async function idViajeActivoDe(usuarioId) {
  const [filas] = await db.execute(
    `SELECT v.id FROM viajes v LEFT JOIN conductores c ON c.id = v.conductor_id
      WHERE (v.pasajero_id = ? OR c.usuario_id = ?)
        AND v.estado IN ('solicitado','aceptado','conductor_llego','en_curso')
      ORDER BY v.solicitado_en DESC LIMIT 1`,
    [usuarioId, usuarioId],
  );
  return filas[0]?.id ?? null;
}

/**
 * Avisa que un viaje cambió de estado. Se llama DESPUÉS de confirmar el cambio en MySQL.
 * Lee el estado real de la base (no confía en lo que le pase la ruta) y nunca lanza errores:
 * un fallo del tiempo real no debe romper la respuesta de la API.
 */
export async function notificarEstadoViaje(viajeId, extra = {}) {
  if (!io) return;
  try {
    const [filas] = await db.execute(
      `SELECT v.id, v.estado, v.pasajero_id, c.usuario_id AS conductor_usuario_id
         FROM viajes v LEFT JOIN conductores c ON c.id = v.conductor_id WHERE v.id = ? LIMIT 1`,
      [viajeId],
    );
    const v = filas[0];
    if (!v) return;
    const sala = `viaje:${v.id}`;
    // Asegura que ambos participantes estén en la sala (p. ej. el pasajero justo después de que aceptan).
    for (const u of [v.pasajero_id, v.conductor_usuario_id]) {
      if (u != null) io.in(`usuario:${u}`).socketsJoin(sala);
    }
    io.to(sala).emit('viaje:estado', { viaje_id: Number(v.id), estado: v.estado, ...extra });

    if (v.estado !== 'solicitado') {
      // Ya no está disponible para otros conductores.
      io.to(`ofertas:${v.id}`).emit('oferta:cerrada', { viaje_id: Number(v.id) });
      io.in(`ofertas:${v.id}`).socketsLeave(`ofertas:${v.id}`);
    }
    if (ESTADOS_TERMINALES.includes(v.estado)) io.in(sala).socketsLeave(sala);
  } catch (e) {
    console.error('[tiempo real] notificarEstadoViaje:', e.message);
  }
}

/** Avisa a los conductores disponibles dentro del radio que hay una solicitud nueva. */
export async function avisarOfertaNueva(viajeId) {
  if (!io) return;
  try {
    const [vs] = await db.execute('SELECT id, estado, origen_lat, origen_lng FROM viajes WHERE id = ? LIMIT 1', [viajeId]);
    const v = vs[0];
    if (!v || v.estado !== 'solicitado') return;
    const radioKm = Math.max(1, Math.min(20, await ajusteNumero('radio_busqueda_km', 3)));
    const edad = Math.max(5, Math.min(120, Math.floor(await ajusteNumero('ubicacion_max_antiguedad_s', 30))));
    // Mismos criterios de despacho que GET /viajes/ofertas: aprobado, disponible, GPS fresco y real.
    const [conductores] = await db.execute(
      `SELECT c.usuario_id
         FROM conductores c JOIN conductor_ubicacion cu ON cu.conductor_id = c.id
        WHERE c.estado_aprobacion = 'aprobado' AND c.estado_operativo = 'disponible'
          AND cu.es_mock = 0 AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL ${edad} SECOND
          AND ST_Distance_Sphere(POINT(cu.longitud, cu.latitud), POINT(?, ?)) <= ?
        LIMIT 100`,
      [Number(v.origen_lng), Number(v.origen_lat), radioKm * 1000],
    );
    const sala = `ofertas:${v.id}`;
    for (const c of conductores) io.in(`usuario:${c.usuario_id}`).socketsJoin(sala);
    // Solo el id: el conductor consulta GET /viajes/ofertas (que valida todo) para ver los datos.
    io.to(sala).emit('oferta:nueva', { viaje_id: Number(v.id) });
  } catch (e) {
    console.error('[tiempo real] avisarOfertaNueva:', e.message);
  }
}

/** Posición del conductor para quienes participan en el viaje. `volatile`: si se pierde una, llega la siguiente. */
export function emitirUbicacionViaje(viajeId, punto) {
  if (!io) return;
  io.to(`viaje:${viajeId}`).volatile.emit('viaje:ubicacion', {
    viaje_id: Number(viajeId),
    lat: punto.latitud,
    lng: punto.longitud,
    rumbo: punto.rumbo ?? null,
    t: Date.now(),
  });
}

/** Corta los sockets de una sesión (al cerrar sesión). */
export function desconectarSesion(sesionId) {
  if (!io) return;
  io.in(`sesion:${sesionId}`).disconnectSockets(true);
}


/** Notifica cambios de pedido solo a los participantes identificados por la API. */
export async function notificarPedidoActualizado(pedidoId, extra = {}) {
  if (!io) return;
  try {
    const [filas] = await db.execute(
      `SELECT p.id,p.estado,p.pasajero_id,p.empresa_id,p.conductor_id,
              e.usuario_id AS comercio_usuario_id,c.usuario_id AS conductor_usuario_id,
              p.estado_pago_producto,p.estado_pago_delivery,p.estado_reembolso
         FROM pedidos p JOIN empresas e ON e.id=p.empresa_id
         LEFT JOIN conductores c ON c.id=p.conductor_id WHERE p.id=? LIMIT 1`, [pedidoId],
    );
    const p = filas[0];
    if (!p) return;
    const destinatarios = new Set([p.pasajero_id, p.comercio_usuario_id, p.conductor_usuario_id].filter((x) => x != null).map(Number));
    const payload = {
      pedido_id: Number(p.id), estado: p.estado,
      estado_pago_producto: p.estado_pago_producto,
      estado_pago_delivery: p.estado_pago_delivery,
      estado_reembolso: p.estado_reembolso ?? 'no_aplica', ...extra,
    };
    for (const usuarioId of destinatarios) io.to(`usuario:${usuarioId}`).emit('pedido:estado', payload);
    if (['entregado','cancelado','fallido','reembolso_pendiente'].includes(p.estado)) {
      io.to(`pedido:${p.id}`).emit('pedido:cerrado', payload);
      io.in(`pedido:${p.id}`).socketsLeave(`pedido:${p.id}`);
    }
  } catch (e) {
    console.error('[tiempo real] notificarPedidoActualizado:', e.message);
  }
}

/** Ubicación en vivo del repartidor; solo se emite si el pedido continúa asignado/recogido/en camino. */
export async function emitirUbicacionPedido(pedidoId, punto) {
  if (!io || !punto || punto.esMock) return;
  try {
    const [filas] = await db.execute(
      `SELECT p.id,p.estado,p.pasajero_id,p.conductor_id,e.usuario_id AS comercio_usuario_id,c.usuario_id AS conductor_usuario_id
         FROM pedidos p JOIN empresas e ON e.id=p.empresa_id
         LEFT JOIN conductores c ON c.id=p.conductor_id WHERE p.id=? LIMIT 1`, [pedidoId],
    );
    const p = filas[0];
    // No se comparte GPS después de la recogida/entrega/cancelación ni con pedidos sin repartidor.
    if (!p || !['asignado','recogido','en_camino'].includes(p.estado) || p.conductor_id == null) return;
    const payload = { pedido_id: Number(p.id), lat: Number(punto.latitud), lng: Number(punto.longitud), rumbo: punto.rumbo ?? null, t: Date.now() };
    const destinatarios = new Set([p.pasajero_id,p.comercio_usuario_id,p.conductor_usuario_id].filter((x) => x != null).map(Number));
    for (const usuarioId of destinatarios) io.to(`usuario:${usuarioId}`).volatile.emit('pedido:ubicacion', payload);
  } catch (e) {
    console.error('[tiempo real] emitirUbicacionPedido:', e.message);
  }
}

/** Avisa a la cuenta del comercio que llegó una compra; el evento solo contiene el ID. */
export async function avisarPedidoNuevo(pedidoId) {
  if (!io) return;
  try {
    const [filas] = await db.execute(
      `SELECT p.id,p.estado,e.usuario_id AS comercio_usuario_id
         FROM pedidos p JOIN empresas e ON e.id=p.empresa_id WHERE p.id=? LIMIT 1`, [pedidoId],
    );
    const p = filas[0];
    if (!p || p.estado !== 'creado') return;
    io.to(`usuario:${p.comercio_usuario_id}`).emit('pedido:nuevo', { pedido_id: Number(p.id) });
  } catch (e) {
    console.error('[tiempo real] avisarPedidoNuevo:', e.message);
  }
}

/** Avisa ofertas de delivery a conductores disponibles y cercanos. Las rutas REST revalidan todo al aceptar. */
export async function avisarOfertaDelivery(pedidoId) {
  if (!io) return;
  try {
    const [pedidos] = await db.execute(
      `SELECT id,estado,recogida_lat,recogida_lng,comision_monto,metodo_pago_delivery
         FROM pedidos WHERE id=? LIMIT 1`, [pedidoId],
    );
    const p = pedidos[0];
    if (!p || p.estado !== 'buscando_repartidor') return;
    const radioKm = Math.max(1, Math.min(20, await ajusteNumero('radio_busqueda_delivery_km', 5)));
    const edad = Math.max(5, Math.min(120, Math.floor(await ajusteNumero('ubicacion_max_antiguedad_s', 30))));
    // Sistema de puntos: basta con cubrir los puntos del pedido; no hay mínimo adicional.
    const minSaldo = 0;
    const [conductores] = await db.execute(
      `SELECT c.usuario_id
         FROM conductores c JOIN usuarios u ON u.id=c.usuario_id
         JOIN billeteras b ON b.conductor_id=c.id
         JOIN conductor_ubicacion cu ON cu.conductor_id=c.id
        WHERE c.estado_aprobacion='aprobado' AND c.estado_operativo='disponible'
          AND u.estado='activo' AND b.estado='activa'
          AND b.saldo_prepago - b.saldo_comision_reservado >= ?
          AND cu.es_mock=0 AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL ${edad} SECOND
          AND ST_Distance_Sphere(POINT(cu.longitud,cu.latitud),POINT(?,?)) <= ?
          AND ( ? <> 'qr' OR (c.qr_pago_url IS NOT NULL AND c.qr_pago_vence_en > UTC_TIMESTAMP()) )
          AND NOT EXISTS (SELECT 1 FROM viajes v WHERE v.conductor_id=c.id AND v.estado IN ('aceptado','conductor_llego','en_curso','requiere_revision'))
          AND NOT EXISTS (SELECT 1 FROM pedidos d WHERE d.conductor_id=c.id AND d.estado IN ('asignado','recogido','en_camino','requiere_revision'))
        LIMIT 100`,
      [Number(p.comision_monto) + minSaldo, Number(p.recogida_lng), Number(p.recogida_lat), radioKm * 1000, p.metodo_pago_delivery],
    );
    for (const c of conductores) {
      io.to(`usuario:${c.usuario_id}`).emit('pedido:oferta', { pedido_id: Number(p.id) });
    }
  } catch (e) {
    console.error('[tiempo real] avisarOfertaDelivery:', e.message);
  }
}


/** Emite cambios de envío únicamente a remitente, destinatario y conductor asignado. */
export async function emitirActualizacionEnvio(envioId, extra = {}) {
  if (!io) return;
  try {
    const [filas] = await db.execute(
      `SELECT e.id,e.estado,e.remitente_id,e.destinatario_id,c.usuario_id AS conductor_usuario_id
         FROM envios e LEFT JOIN conductores c ON c.id=e.conductor_id WHERE e.id=? LIMIT 1`,
      [envioId],
    );
    const e = filas[0];
    if (!e) return;
    const payload = { envio_id: Number(e.id), estado: e.estado, ...extra };
    const usuarios = new Set([e.remitente_id,e.destinatario_id,e.conductor_usuario_id].filter((id) => id != null).map(Number));
    for (const usuarioId of usuarios) io.to(`usuario:${usuarioId}`).emit('envio:estado', payload);
    if (e.estado !== 'solicitado') {
      io.to(`envio-ofertas:${e.id}`).emit('envio:oferta-cerrada', { envio_id: Number(e.id) });
      io.in(`envio-ofertas:${e.id}`).socketsLeave(`envio-ofertas:${e.id}`);
    }
  } catch (e) {
    console.error('[tiempo real] emitirActualizacionEnvio:', e.message);
  }
}

/** Avisa sólo a conductores cercanos y elegibles; el endpoint de ofertas revalida cada condición. */
export async function avisarOfertaEnvio(envioId) {
  if (!io) return;
  try {
    const [envios] = await db.execute(
      `SELECT id,estado,tipo_vehiculo,recogida_lat,recogida_lng,metodo_pago,comision_monto
         FROM envios WHERE id=? LIMIT 1`, [envioId],
    );
    const e = envios[0];
    if (!e || e.estado !== 'solicitado') return;
    const radioKm = Math.max(1, Math.min(20, await ajusteNumero('radio_busqueda_delivery_km', 5)));
    const edad = Math.max(5, Math.min(120, Math.floor(await ajusteNumero('ubicacion_max_antiguedad_s', 30))));
    // Sistema de puntos: basta con cubrir los puntos del envío; no hay mínimo adicional.
    const saldoMinimo = 0;
    const [conductores] = await db.execute(
      `SELECT DISTINCT c.usuario_id
         FROM conductores c JOIN usuarios u ON u.id=c.usuario_id
         JOIN motos m ON m.conductor_id=c.id
         JOIN billeteras b ON b.conductor_id=c.id
         JOIN conductor_ubicacion cu ON cu.conductor_id=c.id
        WHERE c.estado_aprobacion='aprobado' AND c.estado_operativo='disponible'
          AND u.estado='activo' AND m.tipo_vehiculo=? AND b.estado='activa'
          AND b.saldo_prepago-b.saldo_comision_reservado >= ?
          AND cu.es_mock=0 AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL ${edad} SECOND
          AND ST_Distance_Sphere(POINT(cu.longitud,cu.latitud),POINT(?,?)) <= ?
          AND (? <> 'qr' OR (c.qr_pago_url IS NOT NULL AND c.qr_pago_vence_en > UTC_TIMESTAMP()))
          AND NOT EXISTS (SELECT 1 FROM viajes v WHERE v.conductor_id=c.id AND v.estado IN ('aceptado','conductor_llego','en_curso','requiere_revision'))
          AND NOT EXISTS (SELECT 1 FROM pedidos p WHERE p.conductor_id=c.id AND p.estado IN ('asignado','recogido','en_camino','requiere_revision'))
          AND NOT EXISTS (SELECT 1 FROM envios x WHERE x.conductor_id=c.id AND x.estado IN ('asignado','recogido','en_camino','en_punto_entrega','requiere_revision'))
        LIMIT 100`,
      [e.tipo_vehiculo, Number(e.comision_monto)+saldoMinimo, Number(e.recogida_lng), Number(e.recogida_lat), radioKm*1000, e.metodo_pago],
    );
    const sala = `envio-ofertas:${Number(e.id)}`;
    for (const c of conductores) io.to(`usuario:${c.usuario_id}`).socketsJoin(sala);
    io.to(sala).emit('envio:oferta', { envio_id: Number(e.id) });
  } catch (e) {
    console.error('[tiempo real] avisarOfertaEnvio:', e.message);
  }
}
