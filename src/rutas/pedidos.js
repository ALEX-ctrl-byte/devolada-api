import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';
import { ajusteNumero } from '../servicios/ajustes.js';
import { config } from '../config.js';
import { obtenerRutaOSRM } from '../servicios/osrm.js';
import { notificarPedidoActualizado, avisarPedidoNuevo, avisarOfertaDelivery } from '../tiempoReal.js';
import { calcularTarifaDeUna, enteroBs, crearTokenCotizacionTarifa, leerTokenCotizacionTarifa } from '../servicios/tarifas.js';

export const rutaPedidos = Router();
rutaPedidos.use(autenticar);

const TERMINALES = new Set(['entregado', 'cancelado', 'fallido', 'requiere_revision', 'reembolso_pendiente']);
const PEDIDOS_ACTIVOS = ['creado','buscando_repartidor','asignado','recogido','en_camino','requiere_revision'];
const DINERO = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ID = (v) => /^\d{1,18}$/.test(String(v ?? '')) && Number(v) > 0 ? Number(v) : null;
const IDEMPOTENCIA = (v) => /^[A-Za-z0-9._:-]{8,64}$/.test(String(v ?? '').trim());
const metodo = (v) => ['efectivo', 'qr'].includes(String(v ?? '')) ? String(v) : null;

async function tx(fn) {
  const cx = await db.getConnection();
  try {
    await cx.beginTransaction();
    const resultado = await fn(cx);
    if (resultado?.e) {
      await cx.rollback();
      return resultado;
    }
    await cx.commit();
    return resultado;
  } catch (e) {
    await cx.rollback().catch(() => {});
    throw e;
  } finally {
    cx.release();
  }
}

function rol(res, actual, esperado, texto) {
  if (actual === esperado) return true;
  error(res, 403, 'ROL_NO_ADMITIDO', texto);
  return false;
}

function coordsValidas(lat, lng) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    && Number(lat) >= -90 && Number(lat) <= 90 && Number(lng) >= -180 && Number(lng) <= 180;
}

function porcentaje(n, fallback = 10) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(100, x)) : fallback;
}

function saldoDisponible(saldo, reservado) {
  return DINERO(Math.max(0, Number(saldo ?? 0) - Number(reservado ?? 0)));
}

async function pedidoRow(cx, id, lock = false) {
  const [rows] = await cx.execute(
    `SELECT p.*, e.usuario_id AS usuario_comercio_id, e.nombre_comercial,
            e.qr_pago_url AS qr_comercio_actual,
            c.usuario_id AS usuario_conductor_id,
            uc.nombre AS conductor_nombre, uc.apellido AS conductor_apellido, uc.foto_url AS conductor_foto,
            m.placa AS moto_placa, m.marca AS moto_marca, m.modelo AS moto_modelo, m.color AS moto_color,
            CASE WHEN p.estado IN ('asignado','recogido','en_camino') AND cu.es_mock=0 AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND THEN cu.latitud END AS conductor_latitud, CASE WHEN p.estado IN ('asignado','recogido','en_camino') AND cu.es_mock=0 AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND THEN cu.longitud END AS conductor_longitud, CASE WHEN p.estado IN ('asignado','recogido','en_camino') AND cu.es_mock=0 AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND THEN cu.actualizado_en END AS conductor_ubicacion_en
       FROM pedidos p
       JOIN empresas e ON e.id=p.empresa_id
       LEFT JOIN conductores c ON c.id=p.conductor_id
       LEFT JOIN usuarios uc ON uc.id=c.usuario_id
       LEFT JOIN motos m ON m.id=p.moto_id
       LEFT JOIN conductor_ubicacion cu ON cu.conductor_id=c.id
      WHERE p.id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

async function pedidoDetalle(cx, id, usuarioId, rolUsuario) {
  const p = await pedidoRow(cx, id);
  if (!p) return null;
  const esPasajero = String(p.pasajero_id ?? '') === String(usuarioId);
  const esComercio = String(p.usuario_comercio_id) === String(usuarioId);
  const esConductor = String(p.usuario_conductor_id ?? '') === String(usuarioId);
  if (!esPasajero && !esComercio && !esConductor) return null;
  const [items] = await cx.execute(
    `SELECT id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal, notas
       FROM pedido_items WHERE pedido_id=? ORDER BY id`, [id],
  );
  // Lista permitida explícitamente: nunca devolver p.* al cliente (idempotency_key, QR snapshots, etc.).
  const salida = {
    id: Number(p.id), empresa_id: Number(p.empresa_id), nombre_comercial: p.nombre_comercial,
    estado: p.estado, descripcion: p.descripcion, recogida_direccion: p.recogida_direccion,
    entrega_direccion: p.entrega_direccion, recogida_lat: Number(p.recogida_lat), recogida_lng: Number(p.recogida_lng),
    entrega_lat: Number(p.entrega_lat), entrega_lng: Number(p.entrega_lng), distancia_m: p.distancia_m == null ? null : Number(p.distancia_m),
    subtotal_productos: Number(p.subtotal_productos), tarifa_envio: enteroBs(p.tarifa_envio), monto_a_cobrar: Number(p.monto_a_cobrar),
    tipo_vehiculo_delivery: p.tipo_vehiculo_delivery ?? 'moto', duracion_estimada_s: p.duracion_estimada_s == null ? null : Number(p.duracion_estimada_s),
    distancia_aproximacion_m: p.distancia_aproximacion_m == null ? null : Number(p.distancia_aproximacion_m), duracion_aproximacion_s: p.duracion_aproximacion_s == null ? null : Number(p.duracion_aproximacion_s),
    detalle_tarifa: typeof p.detalle_tarifa_json === 'string' ? (() => { try { return JSON.parse(p.detalle_tarifa_json); } catch { return null; } })() : (p.detalle_tarifa_json ?? null),
    metodo_pago_producto: p.metodo_pago_producto, metodo_pago_delivery: p.metodo_pago_delivery,
    estado_pago_producto: p.estado_pago_producto, estado_pago_delivery: p.estado_pago_delivery,
    estado_reembolso: p.estado_reembolso ?? 'no_aplica', referencia_reembolso: esComercio ? p.referencia_reembolso : null,
    reembolso_solicitado_en: p.reembolso_solicitado_en, reembolso_en: p.reembolso_en,
    comision_monto: enteroBs(p.comision_monto), comision_venta_monto: Number(p.comision_venta_monto),
    creado_en: p.creado_en, expira_en: p.expira_en, actualizado_en: p.actualizado_en,
    asignado_en: p.asignado_en, recogido_en: p.recogido_en, entregado_en: p.entregado_en,
    cancelado_en: p.cancelado_en, revision_motivo: esComercio ? p.revision_motivo : null,
    cliente_nombre: esComercio || esConductor ? p.cliente_nombre : null,
    cliente_telefono: esComercio || esConductor ? p.cliente_telefono : null,
    conductor_id: p.conductor_id == null ? null : Number(p.conductor_id), moto_id: p.moto_id == null ? null : Number(p.moto_id),
    items,
  };
  if (esPasajero && p.conductor_id != null && ['asignado','recogido','en_camino'].includes(p.estado)) {
    salida.conductor_nombre = [p.conductor_nombre, p.conductor_apellido].filter(Boolean).join(' ');
    salida.conductor_foto = p.conductor_foto;
    salida.moto_placa = p.moto_placa; salida.moto_marca = p.moto_marca;
    salida.moto_modelo = p.moto_modelo; salida.moto_color = p.moto_color;
    salida.conductor_latitud = p.conductor_latitud == null ? null : Number(p.conductor_latitud);
    salida.conductor_longitud = p.conductor_longitud == null ? null : Number(p.conductor_longitud);
    salida.conductor_ubicacion_en = p.conductor_ubicacion_en;
  }
  // QR privados, solo para participantes autorizados y mientras el pago está pendiente.
  salida.qr_comercio_url = esPasajero && p.metodo_pago_producto === 'qr' && p.estado_pago_producto !== 'confirmado'
    ? p.qr_comercio_snapshot : null;
  salida.qr_conductor_url = p.metodo_pago_delivery === 'qr' && p.estado_pago_delivery !== 'confirmado'
    && ((esPasajero && p.conductor_id != null) || esConductor) ? p.qr_conductor_snapshot : null;
  if (esConductor) {
    salida.recogida_lat = Number(p.recogida_lat); salida.recogida_lng = Number(p.recogida_lng);
  }
  // El rol comercio es quien administra la liquidación de reembolsos; ni QR snapshots ni claves internas se exponen.
  return salida;
}

function haversineMetros(lat1, lng1, lat2, lng2) {
  const rad = (v) => v * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function gpsConductorReciente(cx, conductorId) {
  const [rows] = await cx.execute(
    `SELECT latitud,longitud,es_mock,actualizado_en,
            IF(actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND,1,0) AS reciente
       FROM conductor_ubicacion WHERE conductor_id=? LIMIT 1 FOR UPDATE`, [conductorId],
  );
  const u = rows[0];
  if (!u || Number(u.es_mock) === 1 || Number(u.reciente) !== 1) return null;
  return { lat: Number(u.latitud), lng: Number(u.longitud) };
}

async function comprobarSaldoComercio(cx, empresaId, monto) {
  const [rows] = await cx.execute(
    'SELECT id, saldo_comision, saldo_comision_reservado FROM empresas WHERE id=? LIMIT 1 FOR UPDATE', [empresaId],
  );
  const e = rows[0];
  if (!e) return { e: [404, 'COMERCIO_NO_ENCONTRADO', 'No se encontró el comercio.'] };
  const disponible = saldoDisponible(e.saldo_comision, e.saldo_comision_reservado);
  if (disponible < monto) return { e: [409, 'SALDO_COMISION_COMERCIO_INSUFICIENTE', `El comercio no tiene puntos suficientes (se necesitan ${monto} puntos por pedido). Debe recargar puntos para recibir pedidos.`, { saldo_comision_bs: Number(e.saldo_comision), reservado_bs: Number(e.saldo_comision_reservado), disponible_bs: disponible, requerido_bs: monto, puntos_disponibles: disponible, puntos_requeridos: monto }] };
  return { empresa: e, disponible };
}

async function liberarReservaComercio(cx, p) {
  if (Number(p.comision_venta_reservada) !== 1) return;
  await cx.execute(
    'UPDATE empresas SET saldo_comision_reservado=GREATEST(0, saldo_comision_reservado-?) WHERE id=?',
    [Number(p.comision_venta_monto), p.empresa_id],
  );
  await cx.execute('UPDATE pedidos SET comision_venta_reservada=0 WHERE id=?', [p.id]);
}

async function liberarReservaConductor(cx, p) {
  if (Number(p.comision_delivery_reservada) !== 1 || p.conductor_id == null) return;
  await cx.execute(
    'UPDATE billeteras SET saldo_comision_reservado=GREATEST(0, saldo_comision_reservado-?) WHERE conductor_id=?',
    [Number(p.comision_monto), p.conductor_id],
  );
  await cx.execute('UPDATE pedidos SET comision_delivery_reservada=0 WHERE id=?', [p.id]);
}

async function restituirStock(cx, pedidoId) {
  const [items] = await cx.execute('SELECT producto_id, cantidad FROM pedido_items WHERE pedido_id=?', [pedidoId]);
  for (const i of items) {
    if (i.producto_id != null) await cx.execute(
      'UPDATE productos_comercio SET stock=stock+? WHERE id=? AND stock IS NOT NULL', [i.cantidad, i.producto_id],
    );
  }
}

async function cancelarPedidoTx(cx, p, usuarioId, motivo) {
  if (p.estado !== 'creado') {
    return { e: [409, 'PEDIDO_NO_CANCELABLE', 'Solo se puede cancelar antes de que el comercio acepte el pedido. Si un repartidor ya está asignado, debe usar “Soltar pedido”; la compra del cliente no se cancela.'] };
  }
  await liberarReservaComercio(cx, p);
  await liberarReservaConductor(cx, p);
  await restituirStock(cx, p.id);
  if (p.conductor_id != null) {
    await cx.execute("UPDATE conductores SET estado_operativo='disponible' WHERE id=? AND estado_operativo='en_viaje'", [p.conductor_id]);
  }
  if (p.estado_pago_producto === 'confirmado') {
    await cx.execute(
      `UPDATE pedidos SET estado='reembolso_pendiente', estado_reembolso='pendiente',
              reembolso_solicitado_en=UTC_TIMESTAMP(), cancelado_en=UTC_TIMESTAMP(), revision_motivo=?,
              descripcion=LEFT(CONCAT(COALESCE(descripcion,''), ' | Reembolso solicitado: ', ?),255)
        WHERE id=?`,
      ['Pago QR confirmado; el comercio debe devolver el importe al cliente y registrar la referencia bancaria.', motivo || `por usuario ${usuarioId}`, p.id],
    );
    return { cancelado: false, reembolso_pendiente: true, pedido_id: Number(p.id), mensaje: 'El pago QR ya había sido confirmado. El pedido pasó a la cola de reembolsos del comercio; no se presume una devolución bancaria automática.' };
  }
  await cx.execute(
    `UPDATE pedidos SET estado='cancelado', estado_reembolso='no_aplica', cancelado_en=UTC_TIMESTAMP(),
            descripcion=LEFT(CONCAT(COALESCE(descripcion,''), ' | Cancelado: ', ?),255) WHERE id=?`,
    [motivo || `por usuario ${usuarioId}`, p.id],
  );
  await cx.execute("UPDATE pagos SET estado='anulado', actualizado_en=UTC_TIMESTAMP() WHERE pedido_id=? AND estado='pendiente'", [p.id]);
  return { cancelado: true, pedido_id: Number(p.id) };
}

/** Libera los pedidos que el comercio dejó sin aceptar durante 15 minutos. */
export async function expirarPedidosPendientes() {
  const [candidatos] = await db.execute(
    `SELECT id FROM pedidos WHERE estado='creado' AND expira_en IS NOT NULL AND expira_en <= UTC_TIMESTAMP() ORDER BY expira_en ASC LIMIT 100`,
  );
  let procesados = 0;
  for (const candidato of candidatos) {
    try {
      const resultado = await tx(async (cx) => {
        const p = await pedidoRow(cx, Number(candidato.id), true);
        if (!p || p.estado !== 'creado') return { omitido: true };
        const [vencido] = await cx.execute('SELECT 1 AS si FROM pedidos WHERE id=? AND expira_en IS NOT NULL AND expira_en<=UTC_TIMESTAMP() LIMIT 1', [p.id]);
        if (!vencido[0]) return { omitido: true };
        const r = await cancelarPedidoTx(cx, p, p.pasajero_id, 'Caducó tras 15 minutos sin aceptación del comercio');
        return r;
      });
      if (!resultado?.e && !resultado?.omitido) {
        procesados++;
        await notificarPedidoActualizado(Number(candidato.id));
      }
    } catch (e) {
      console.error('[pedidos] caducidad de pedido', candidato.id, e.message);
    }
  }
  return procesados;
}

// POST /pedidos — el pasajero compra los productos y solicita delivery.
// Ambos métodos de pago son directos al receptor: QR de comercio para productos y QR del conductor para delivery.

// POST /pedidos/cotizar-delivery — muestra una tarifa de delivery fijada por 3 minutos.
rutaPedidos.post('/cotizar-delivery', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'pasajero', 'Solo una cuenta de pasajero puede cotizar delivery.')) return;
  const b = req.body ?? {};
  const empresaId = ID(b.empresa_id);
  const entregaLat = Number(b.entrega_lat), entregaLng = Number(b.entrega_lng);
  const tipoVehiculo = String(b.tipo_vehiculo_delivery ?? 'moto').trim().toLowerCase();
  if (!empresaId || !coordsValidas(entregaLat, entregaLng) || !['moto', 'auto'].includes(tipoVehiculo)) {
    return error(res, 422, 'DATOS_INVALIDOS', 'Selecciona un comercio, una dirección de entrega y moto o auto.');
  }
  const [bizRows] = await db.execute(
    `SELECT e.id,e.nombre_comercial,e.direccion,e.latitud,e.longitud,e.estado_aprobacion,u.estado AS usuario_estado
       FROM empresas e JOIN usuarios u ON u.id=e.usuario_id WHERE e.id=? LIMIT 1`, [empresaId],
  );
  const empresa = bizRows[0];
  if (!empresa || empresa.estado_aprobacion !== 'aprobado' || empresa.usuario_estado !== 'activo') return error(res, 409, 'COMERCIO_NO_DISPONIBLE', 'El comercio no está publicado o no está disponible.');
  if (empresa.latitud == null || empresa.longitud == null) return error(res, 409, 'UBICACION_COMERCIO_NO_CONFIGURADA', 'El comercio todavía no tiene coordenadas de recogida.');
  const origen = { lat: Number(empresa.latitud), lng: Number(empresa.longitud) };
  let ruta;
  try { ruta = await obtenerRutaOSRM(origen, { lat: entregaLat, lng: entregaLng }); }
  catch (e) { return error(res, e.estadoHttp ?? 502, e.codigo ?? 'RUTA_NO_DISPONIBLE', e.message ?? 'No se pudo calcular la ruta de delivery.'); }
  let calculo;
  try { calculo = await calcularTarifaDeUna({ tipoServicio: 'delivery_comercio', tipoVehiculo, origen, rutaServicio: ruta }); }
  catch (e) {
    console.error('[tarifas] no se pudo cotizar delivery de comercio', e.message);
    return error(res, 503, 'TARIFA_NO_DISPONIBLE', 'No se pudo calcular la tarifa de entrega. Intenta nuevamente.');
  }
  const ahora = Math.floor(Date.now() / 1000);
  const tarifaBs = enteroBs(calculo.tarifa_bs);
  const comisionPct = porcentaje(await ajusteNumero('comision_porcentaje_delivery', 10));
  // Sistema de puntos: la comisión de delivery es un descuento fijo de puntos (comisionPct queda como histórico).
  const comisionBs = config.puntosPorViaje;
  const datos = {
    v: 1, tipo_servicio: 'delivery_comercio', usuario_id: Number(req.usuario.id), empresa_id: empresaId, tipo_vehiculo: tipoVehiculo,
    origen, destino: { lat: entregaLat, lng: entregaLng }, distancia_m: Number(ruta.distancia_m),
    duracion_estimada_s: Number(ruta.duracion_estimada_s), tarifa_bs: tarifaBs,
    comision_porcentaje: comisionPct, comision_bs: comisionBs,
    detalle_tarifa: calculo.detalle, expira_en: ahora + 180,
  };
  return ok(res, {
    cotizacion_token: crearTokenCotizacionTarifa(datos), expira_en: new Date((ahora + 180) * 1000).toISOString(),
    empresa_id: empresaId, tipo_vehiculo_delivery: tipoVehiculo, distancia_m: datos.distancia_m,
    duracion_estimada_min: Math.max(1, Math.round(datos.duracion_estimada_s / 60)),
    tarifa_envio_bs: datos.tarifa_bs, comision_delivery_bs: datos.comision_bs, comision_puntos: datos.comision_bs,
    comision_porcentaje: datos.comision_porcentaje, detalle_tarifa: datos.detalle_tarifa, moneda: 'BOB',
  });
});

rutaPedidos.post('/', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'pasajero', 'Solo una cuenta de pasajero puede crear un pedido.')) return;
  const b = req.body ?? {};
  const empresaId = ID(b.empresa_id);
  const entregaLat = Number(b.entrega_lat);
  const entregaLng = Number(b.entrega_lng);
  const entregaDireccion = String(b.entrega_direccion ?? '').trim().slice(0, 255);
  const clienteNombre = String(b.cliente_nombre ?? `${req.usuario.nombre ?? ''} ${req.usuario.apellido ?? ''}`.trim()).trim().slice(0, 100);
  const clienteTelefono = String(b.cliente_telefono ?? req.usuario.telefono ?? '').trim().slice(0, 20);
  const metodoProducto = metodo(b.metodo_pago_producto ?? 'qr');
  const metodoDelivery = metodo(b.metodo_pago_delivery ?? b.metodo_pago ?? 'efectivo');
  const tipoVehiculoDelivery = String(b.tipo_vehiculo_delivery ?? 'moto').trim().toLowerCase();
  const clave = String(b.idempotency_key ?? '').trim();
  const listaRaw = Array.isArray(b.items) ? b.items : [];
  if (!empresaId) return error(res, 422, 'DATOS_INVALIDOS', 'Selecciona un comercio válido.');
  if (!coordsValidas(entregaLat, entregaLng) || entregaDireccion.length < 4) return error(res, 422, 'DIRECCION_INVALIDA', 'Selecciona la dirección de entrega en el mapa.');
  if (!clienteNombre || !clienteTelefono) return error(res, 422, 'DATOS_CLIENTE_INVALIDOS', 'Indica nombre y teléfono de contacto.');
  if (metodoProducto !== 'qr') return error(res, 422, 'EFECTIVO_PRODUCTOS_NO_PERMITIDO', 'Los productos de comercio solo se pagan por QR directo a la cuenta del comercio. El envío puede pagarse en efectivo o QR al repartidor.');
  if (!metodoDelivery) return error(res, 422, 'METODO_PAGO_INVALIDO', 'El método de pago del delivery debe ser efectivo o qr.');
  if (!['moto', 'auto'].includes(tipoVehiculoDelivery)) return error(res, 422, 'TIPO_VEHICULO_INVALIDO', 'Elige moto o auto para el delivery.');
  if (!IDEMPOTENCIA(clave)) return error(res, 422, 'IDEMPOTENCY_KEY_INVALIDA', 'Genera una clave de pedido válida.');
  if (listaRaw.length < 1 || listaRaw.length > 30) return error(res, 422, 'ITEMS_INVALIDOS', 'El pedido debe tener entre 1 y 30 productos.');
  const cantidades = new Map();
  for (const item of listaRaw) {
    const productoId = ID(item?.producto_id);
    const cantidad = Number(item?.cantidad);
    if (!productoId || !Number.isSafeInteger(cantidad) || cantidad < 1 || cantidad > 50) return error(res, 422, 'ITEMS_INVALIDOS', 'Cada producto necesita un ID válido y una cantidad entre 1 y 50.');
    cantidades.set(productoId, (cantidades.get(productoId) ?? 0) + cantidad);
    if (cantidades.get(productoId) > 50) return error(res, 422, 'CANTIDAD_INVALIDA', 'La cantidad por producto no puede superar 50 unidades.');
  }
  const comisionVentaPct = porcentaje(await ajusteNumero('comision_porcentaje_venta', 10));
  let comisionDeliveryPct = porcentaje(await ajusteNumero('comision_porcentaje_delivery', 10));

  const [bizRows] = await db.execute(
    `SELECT e.id, e.usuario_id, e.nombre_comercial, e.qr_pago_url, e.qr_pago_vence_en, IF(e.qr_pago_url IS NOT NULL AND e.qr_pago_vence_en > UTC_TIMESTAMP(),1,0) AS qr_vigente, e.direccion, e.latitud, e.longitud,
            e.estado_aprobacion, e.saldo_comision, e.saldo_comision_reservado, u.estado AS usuario_estado
       FROM empresas e JOIN usuarios u ON u.id=e.usuario_id WHERE e.id=? LIMIT 1`, [empresaId],
  );
  const empresaBase = bizRows[0];
  if (!empresaBase || empresaBase.estado_aprobacion !== 'aprobado' || empresaBase.usuario_estado !== 'activo') return error(res, 409, 'COMERCIO_NO_DISPONIBLE', 'El comercio no está publicado o no está disponible.');
  if (empresaBase.latitud == null || empresaBase.longitud == null) return error(res, 409, 'UBICACION_COMERCIO_NO_CONFIGURADA', 'El comercio todavía no tiene coordenadas de recogida.');
  if (!empresaBase.qr_pago_url || Number(empresaBase.qr_vigente) !== 1) return error(res, 409, 'QR_COMERCIO_NO_CONFIGURADO', 'El comercio no tiene un QR bancario vigente. Elige otro comercio o pide que renueve el QR.' );

  let ruta;
  let calculoTarifa;
  let cotizacionConfirmada = null;
  const origenDelivery = { lat: Number(empresaBase.latitud), lng: Number(empresaBase.longitud) };
  if (b.cotizacion_token) {
    const cotizacion = leerTokenCotizacionTarifa(b.cotizacion_token);
    const coincide = cotizacion && !cotizacion.expirada
      && cotizacion.tipo_servicio === 'delivery_comercio'
      && cotizacion.usuario_id === Number(req.usuario.id)
      && Number(cotizacion.empresa_id) === empresaId
      && cotizacion.tipo_vehiculo === tipoVehiculoDelivery
      && Math.abs(Number(cotizacion.origen?.lat) - origenDelivery.lat) < 0.000001
      && Math.abs(Number(cotizacion.origen?.lng) - origenDelivery.lng) < 0.000001
      && Math.abs(Number(cotizacion.destino?.lat) - entregaLat) < 0.000001
      && Math.abs(Number(cotizacion.destino?.lng) - entregaLng) < 0.000001;
    if (!coincide) return error(res, 409, cotizacion?.expirada ? 'COTIZACION_CADUCADA' : 'COTIZACION_INVALIDA', 'La tarifa cambió o venció. Actualiza el precio antes de confirmar el pedido.');
    cotizacionConfirmada = cotizacion;
    comisionDeliveryPct = porcentaje(cotizacion.comision_porcentaje, 10);
    ruta = { distancia_m: Number(cotizacion.distancia_m), duracion_estimada_s: Number(cotizacion.duracion_estimada_s) };
    calculoTarifa = { tarifa_bs: enteroBs(cotizacion.tarifa_bs), detalle: cotizacion.detalle_tarifa };
  } else {
    try {
      ruta = await obtenerRutaOSRM(origenDelivery, { lat: entregaLat, lng: entregaLng });
    } catch (e) {
      return error(res, e.estadoHttp ?? 502, e.codigo ?? 'RUTA_NO_DISPONIBLE', e.message ?? 'No se pudo calcular la distancia de delivery.');
    }
    try {
      calculoTarifa = await calcularTarifaDeUna({ tipoServicio: 'delivery_comercio', tipoVehiculo: tipoVehiculoDelivery, origen: origenDelivery, rutaServicio: ruta });
    } catch (e) {
      console.error('[tarifas] no se pudo cotizar delivery de comercio', e.message);
      return error(res, 503, 'TARIFA_NO_DISPONIBLE', 'No se pudo calcular la tarifa de entrega. Intenta nuevamente.');
    }
  }
  const tarifaEnvio = enteroBs(calculoTarifa.tarifa_bs);
  // Sistema de puntos: siempre config.puntosPorViaje puntos por pedido completado (se ignora el valor de cotizaciones antiguas).
  const comisionDelivery = config.puntosPorViaje;

  const resultado = await tx(async (cx) => {
    const [dupe] = await cx.execute('SELECT id, pasajero_id FROM pedidos WHERE empresa_id=? AND idempotency_key=? LIMIT 1 FOR UPDATE', [empresaId, clave]);
    if (dupe[0]) {
      if (String(dupe[0].pasajero_id ?? '') !== String(req.usuario.id)) return { e: [409, 'IDEMPOTENCIA_REUTILIZADA', 'La clave de pedido ya fue utilizada.'] };
      return { pedido_id: Number(dupe[0].id), repetido: true };
    }
    // Serializa creaciones del mismo pasajero para que dos solicitudes paralelas no superen el límite.
    await cx.execute('SELECT id FROM usuarios WHERE id=? LIMIT 1 FOR UPDATE', [req.usuario.id]);
    const [activos] = await cx.execute(
      `SELECT COUNT(*) AS total FROM pedidos WHERE pasajero_id=? AND estado IN ('creado','buscando_repartidor','asignado','recogido','en_camino','requiere_revision')`,
      [req.usuario.id],
    );
    if (Number(activos[0]?.total ?? 0) >= 2) return { e: [429, 'LIMITE_PEDIDOS_ACTIVOS', 'Ya tienes 2 pedidos activos. Espera a que uno termine o caduque antes de crear otro.', { limite: 2 }] };
    const [es] = await cx.execute(
      `SELECT e.id, e.usuario_id, e.nombre_comercial, e.qr_pago_url, e.qr_pago_vence_en, IF(e.qr_pago_url IS NOT NULL AND e.qr_pago_vence_en > UTC_TIMESTAMP(),1,0) AS qr_vigente, e.direccion, e.latitud, e.longitud,
              e.estado_aprobacion, e.saldo_comision, e.saldo_comision_reservado, u.estado AS usuario_estado
         FROM empresas e JOIN usuarios u ON u.id=e.usuario_id WHERE e.id=? LIMIT 1 FOR UPDATE`, [empresaId],
    );
    const empresa = es[0];
    if (!empresa || empresa.estado_aprobacion !== 'aprobado' || empresa.usuario_estado !== 'activo') return { e: [409, 'COMERCIO_NO_DISPONIBLE', 'El comercio dejó de estar disponible.'] };
    if (!empresa.qr_pago_url || Number(empresa.qr_vigente) !== 1) return { e: [409, 'QR_COMERCIO_NO_CONFIGURADO', 'El QR bancario del comercio no está vigente.'] };

    const ids = [...cantidades.keys()];
    const placeholders = ids.map(() => '?').join(',');
    const [productos] = await cx.execute(
      `SELECT id, empresa_id, nombre, precio, stock, activo FROM productos_comercio
        WHERE empresa_id=? AND id IN (${placeholders}) FOR UPDATE`, [empresaId, ...ids],
    );
    if (productos.length !== ids.length || productos.some((p) => Number(p.activo) !== 1)) return { e: [409, 'PRODUCTO_NO_DISPONIBLE', 'Uno o más productos no están disponibles en este comercio.'] };
    let subtotal = 0;
    const lineas = [];
    for (const prod of productos) {
      const cantidad = cantidades.get(Number(prod.id));
      if (prod.stock != null && Number(prod.stock) < cantidad) return { e: [409, 'STOCK_INSUFICIENTE', `${prod.nombre} no tiene stock suficiente.`, { producto_id: Number(prod.id), stock: Number(prod.stock), solicitado: cantidad }] };
      const unit = DINERO(prod.precio);
      const importe = DINERO(unit * cantidad);
      subtotal = DINERO(subtotal + importe);
      lineas.push({ producto_id: Number(prod.id), nombre: prod.nombre, cantidad, unit, importe, notas: String(listaRaw.find((x) => Number(x?.producto_id) === Number(prod.id))?.notas ?? '').trim().slice(0, 255) || null, stock: prod.stock });
    }
    if (subtotal <= 0) return { e: [422, 'TOTAL_INVALIDO', 'El subtotal de productos debe ser mayor que cero.'] };
    // Sistema de puntos: el comercio también paga una cantidad fija de puntos por pedido completado.
    const comisionVenta = config.puntosPorViaje;
    const saldo = await comprobarSaldoComercio(cx, empresaId, comisionVenta);
    if (saldo.e) return saldo;

    const montoTotal = DINERO(subtotal + tarifaEnvio);
    const descripcion = `Pedido app. Productos Bs ${subtotal.toFixed(2)}; delivery Bs ${tarifaEnvio}`;
    const [ins] = await cx.execute(
      `INSERT INTO pedidos
        (empresa_id,pasajero_id,estado,tipo_vehiculo_delivery,descripcion,recogida_lat,recogida_lng,recogida_direccion,
         entrega_lat,entrega_lng,entrega_direccion,cliente_nombre,cliente_telefono,distancia_m,duracion_estimada_s,
         distancia_aproximacion_m,duracion_aproximacion_s,detalle_tarifa_json,tarifa_envio,comision_porcentaje,comision_monto,
         ganancia_conductor,monto_a_cobrar,subtotal_productos,metodo_pago_producto,metodo_pago_delivery,estado_pago_producto,estado_pago_delivery,
         comision_venta_porcentaje,comision_venta_monto,comision_venta_reservada,comision_delivery_reservada,
         qr_comercio_snapshot,idempotency_key,expira_en)
       VALUES (?,?,'creado',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pendiente','pendiente',?,?,1,0,?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE))`,
      [empresaId, req.usuario.id, tipoVehiculoDelivery, descripcion, Number(empresa.latitud), Number(empresa.longitud), empresa.direccion,
        entregaLat, entregaLng, entregaDireccion, clienteNombre, clienteTelefono, ruta.distancia_m, ruta.duracion_estimada_s,
        calculoTarifa.detalle.distancia_aproximacion_m, calculoTarifa.detalle.duracion_aproximacion_s, JSON.stringify(calculoTarifa.detalle),
        tarifaEnvio, comisionDeliveryPct, comisionDelivery, tarifaEnvio, montoTotal,
        subtotal, metodoProducto, metodoDelivery, comisionVentaPct, comisionVenta,
        empresa.qr_pago_url, clave],
    );
    const pedidoId = Number(ins.insertId);
    for (const item of lineas) {
      await cx.execute(
        `INSERT INTO pedido_items (pedido_id,producto_id,nombre_producto,cantidad,precio_unitario,subtotal,notas)
         VALUES (?,?,?,?,?,?,?)`, [pedidoId,item.producto_id,item.nombre,item.cantidad,item.unit,item.importe,item.notas],
      );
      if (item.stock != null) {
        const [upd] = await cx.execute('UPDATE productos_comercio SET stock=stock-? WHERE id=? AND stock>=?', [item.cantidad,item.producto_id,item.cantidad]);
        if (!upd.affectedRows) return { e: [409, 'STOCK_CAMBIO', `El stock de ${item.nombre} cambió mientras se creaba el pedido. Vuelve a intentarlo.`] };
      }
    }
    await cx.execute('UPDATE empresas SET saldo_comision_reservado=saldo_comision_reservado+? WHERE id=?', [comisionVenta, empresaId]);
    // Registro contable de los dos cobros directos; la confirmación la realiza el receptor tras verificar el banco.
    await cx.execute(
      `INSERT INTO pagos (usuario_id,tipo,pedido_id,metodo,monto,moneda,estado,proveedor,idempotency_key,detalle_json)
       VALUES (?,'pedido',?,? ,?,'BOB','pendiente',?,?,JSON_OBJECT('componente','productos','empresa_id',?))`,
      [req.usuario.id,pedidoId,metodoProducto,subtotal,metodoProducto === 'qr' ? 'qr_directo_comercio' : 'efectivo_repartidor',`pedido:${pedidoId}:productos`,empresaId],
    );
    await cx.execute(
      `INSERT INTO pagos (usuario_id,tipo,pedido_id,metodo,monto,moneda,estado,proveedor,idempotency_key,detalle_json)
       VALUES (?,'pedido',?,? ,?,'BOB','pendiente',?,?,JSON_OBJECT('componente','delivery','empresa_id',?))`,
      [req.usuario.id,pedidoId,metodoDelivery,tarifaEnvio,metodoDelivery === 'qr' ? 'qr_directo_conductor' : 'efectivo_repartidor',`pedido:${pedidoId}:delivery`,empresaId],
    );
    return { pedido_id: pedidoId, repetido: false };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  const detalle = await pedidoDetalle(db, resultado.pedido_id, req.usuario.id, req.usuario.rol);
  if (!resultado.repetido) { await avisarPedidoNuevo(resultado.pedido_id); await notificarPedidoActualizado(resultado.pedido_id); }
  return ok(res, { pedido: detalle, repetido: resultado.repetido, mensaje: resultado.repetido ? 'Este pedido ya había sido recibido.' : 'Pedido creado. Tienes 15 minutos para que el comercio lo acepte; los productos se pagan solo por QR directo al comercio.' }, resultado.repetido ? 200 : 201);
});

// Listas estáticas se declaran antes que /:id.
rutaPedidos.get('/mios', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'pasajero', 'Solo pasajeros pueden consultar sus pedidos.')) return;
  const [rows] = await db.execute(
    `SELECT id, empresa_id, nombre_comercial, estado, tarifa_envio, subtotal_productos, monto_a_cobrar,
            metodo_pago_producto, metodo_pago_delivery, estado_pago_producto, estado_pago_delivery,
            creado_en, actualizado_en, expira_en, estado_reembolso
       FROM (SELECT p.*, e.nombre_comercial FROM pedidos p JOIN empresas e ON e.id=p.empresa_id) pedidos_pasajero
      WHERE pasajero_id=? ORDER BY creado_en DESC LIMIT 50`, [req.usuario.id],
  );
  return ok(res, { pedidos: rows });
});

rutaPedidos.get('/comercio/mios', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'comercio', 'Solo comercios pueden consultar pedidos de su negocio.')) return;
  const [erows] = await db.execute('SELECT id FROM empresas WHERE usuario_id=? LIMIT 1', [req.usuario.id]);
  if (!erows[0]) return error(res, 409, 'COMERCIO_INCOMPLETO', 'Completa el perfil del comercio.');
  const estado = String(req.query.estado ?? '').trim();
  const permitidos = new Set(['creado','buscando_repartidor','asignado','recogido','en_camino','entregado','cancelado','requiere_revision','reembolso_pendiente']);
  if (estado && !permitidos.has(estado)) return error(res, 422, 'ESTADO_INVALIDO', 'Filtro de estado no válido.');
  const params = [erows[0].id];
  let where = 'p.empresa_id=?';
  if (estado) { where += ' AND p.estado=?'; params.push(estado); }
  const [rows] = await db.execute(
    `SELECT p.id,p.pasajero_id,p.estado,p.descripcion,p.cliente_nombre,p.cliente_telefono,
            p.entrega_direccion,p.tarifa_envio,p.subtotal_productos,p.monto_a_cobrar,
            p.metodo_pago_producto,p.metodo_pago_delivery,p.estado_pago_producto,p.estado_pago_delivery,
            p.comision_venta_monto,p.comision_monto,p.distancia_m,p.creado_en,p.expira_en,p.estado_reembolso,p.referencia_reembolso,p.reembolso_solicitado_en,p.reembolso_en,p.revision_motivo,p.asignado_en,p.recogido_en,p.entregado_en,
            u.nombre AS pasajero_nombre,u.apellido AS pasajero_apellido,
            (SELECT GROUP_CONCAT(CONCAT(pi.cantidad,'x ',pi.nombre_producto) ORDER BY pi.id SEPARATOR ', ')
               FROM pedido_items pi WHERE pi.pedido_id=p.id) AS resumen_productos
       FROM pedidos p LEFT JOIN usuarios u ON u.id=p.pasajero_id WHERE ${where}
      ORDER BY p.creado_en DESC LIMIT 100`, params,
  );
  return ok(res, { pedidos: rows.map((x) => ({ ...x, id: Number(x.id), subtotal_productos: Number(x.subtotal_productos), tarifa_envio: enteroBs(x.tarifa_envio), monto_a_cobrar: Number(x.monto_a_cobrar), comision_venta_monto: Number(x.comision_venta_monto), comision_monto: enteroBs(x.comision_monto) })) });
});

rutaPedidos.get('/conductor/ofertas', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'conductor', 'Solo conductores pueden consultar ofertas de delivery.')) return;
  const [cs] = await db.execute(
    `SELECT c.id AS conductor_id,c.estado_aprobacion,c.estado_operativo,c.qr_pago_url,c.qr_pago_vence_en,
            m.tipo_vehiculo,
            b.id AS billetera_id,b.saldo_prepago,b.saldo_comision_reservado,b.estado AS billetera_estado,
            cu.latitud,cu.longitud,cu.actualizado_en,cu.es_mock,
            IF(cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND,1,0) AS ubicacion_reciente
       FROM conductores c JOIN billeteras b ON b.conductor_id=c.id
       JOIN motos m ON m.conductor_id=c.id
       LEFT JOIN conductor_ubicacion cu ON cu.conductor_id=c.id WHERE c.usuario_id=? LIMIT 1`, [req.usuario.id],
  );
  const c = cs[0];
  if (!c || c.estado_aprobacion !== 'aprobado' || c.estado_operativo !== 'disponible' || c.billetera_estado !== 'activa') return error(res, 409, 'CONDUCTOR_NO_DISPONIBLE', 'Debes estar aprobado, conectado y con una billetera activa.');
  if (c.latitud == null || c.longitud == null || Number(c.es_mock) === 1 || Number(c.ubicacion_reciente) !== 1) return error(res, 409, 'UBICACION_NO_ACTUALIZADA', 'Actualiza tu ubicación GPS antes de recibir pedidos.');
  // Sistema de puntos: basta con tener los puntos de un servicio; no hay mínimo adicional en Bs.
  const minSaldo = 0;
  const disponible = saldoDisponible(c.saldo_prepago, c.saldo_comision_reservado);
  if (disponible < config.puntosPorViaje) return error(res, 409, 'SALDO_COMISION_INSUFICIENTE', `Recarga puntos para recibir delivery. Necesitas al menos ${config.puntosPorViaje} puntos.`, { disponible_bs: disponible, minimo_bs: config.puntosPorViaje, puntos_disponibles: disponible, puntos_requeridos: config.puntosPorViaje });
  const radio = Math.max(1, Math.min(20, await ajusteNumero('radio_busqueda_delivery_km', 5)));
  const [rows] = await db.execute(
    `SELECT p.id,p.empresa_id,p.estado,p.nombre_comercial,p.recogida_lat,p.recogida_lng,p.recogida_direccion,
            p.entrega_lat,p.entrega_lng,p.entrega_direccion,p.distancia_m,
            p.tarifa_envio,p.comision_porcentaje,p.comision_monto,p.subtotal_productos,p.monto_a_cobrar,
            p.metodo_pago_producto,p.metodo_pago_delivery,p.estado_pago_producto,p.tipo_vehiculo_delivery,
            (SELECT GROUP_CONCAT(CONCAT(pi.cantidad,'x ',pi.nombre_producto) ORDER BY pi.id SEPARATOR ', ')
               FROM pedido_items pi WHERE pi.pedido_id=p.id) AS resumen_productos,
            ROUND(ST_Distance_Sphere(POINT(p.recogida_lng,p.recogida_lat),POINT(?,?))) AS distancia_recogida_m
       FROM (SELECT o.*,e.nombre_comercial FROM pedidos o JOIN empresas e ON e.id=o.empresa_id) p
      WHERE p.estado='buscando_repartidor' AND p.tipo_vehiculo_delivery=?
        AND (p.metodo_pago_delivery <> 'qr' OR (? IS NOT NULL AND ? > UTC_TIMESTAMP()))
        AND ST_Distance_Sphere(POINT(p.recogida_lng,p.recogida_lat),POINT(?,?)) <= ?
      ORDER BY distancia_recogida_m ASC,p.creado_en ASC LIMIT 40`,
    [Number(c.longitud),Number(c.latitud),c.tipo_vehiculo,c.qr_pago_url,c.qr_pago_vence_en,Number(c.longitud),Number(c.latitud),radio*1000],
  );
  const ofertas = rows.filter((o) => disponible >= Number(o.comision_monto) + minSaldo).map((o) => ({ ...o, tarifa_envio: enteroBs(o.tarifa_envio), comision_monto: enteroBs(o.comision_monto) }));
  return ok(res, { ofertas, radio_km: radio, saldo_comision_disponible_bs: disponible });
});

rutaPedidos.get('/conductor/activos', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'conductor', 'Solo conductores pueden consultar deliveries activos.')) return;
  const [rows] = await db.execute(
    `SELECT p.id,p.empresa_id,p.estado,p.nombre_comercial,p.cliente_nombre,p.cliente_telefono,
            p.recogida_direccion,p.entrega_direccion,p.recogida_lat,p.recogida_lng,p.entrega_lat,p.entrega_lng,
            p.tarifa_envio,p.subtotal_productos,p.monto_a_cobrar,p.metodo_pago_producto,p.metodo_pago_delivery,
            p.estado_pago_producto,p.estado_pago_delivery,p.qr_conductor_snapshot,p.creado_en
       FROM (SELECT o.*,e.nombre_comercial,
                    (SELECT GROUP_CONCAT(CONCAT(pi.cantidad,'x ',pi.nombre_producto) ORDER BY pi.id SEPARATOR ', ')
                       FROM pedido_items pi WHERE pi.pedido_id=o.id) AS resumen_productos
               FROM pedidos o JOIN empresas e ON e.id=o.empresa_id) p
       JOIN conductores c ON c.id=p.conductor_id
      WHERE c.usuario_id=? AND p.estado IN ('asignado','recogido','en_camino') ORDER BY p.asignado_en DESC LIMIT 20`, [req.usuario.id],
  );
  return ok(res, { pedidos: rows.map((p) => { const { qr_conductor_snapshot, ...seguro } = p; return { ...seguro, tarifa_envio: enteroBs(p.tarifa_envio), subtotal_productos: Number(p.subtotal_productos), monto_a_cobrar: Number(p.monto_a_cobrar), qr_conductor_url: p.metodo_pago_delivery === 'qr' && p.estado_pago_delivery !== 'confirmado' && ['asignado','recogido','en_camino'].includes(p.estado) ? qr_conductor_snapshot : null }; }) });
});

rutaPedidos.get('/:id', async (req, res) => {
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const pedido = await pedidoDetalle(db, id, req.usuario.id, req.usuario.rol);
  if (!pedido) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido o no tienes permiso para verlo.');
  return ok(res, { pedido });
});

// El cliente solo puede cancelar mientras el comercio no haya aceptado. El conductor debe soltar, no cancelar la compra.
rutaPedidos.post('/:id/cancelar', async (req, res) => {
  if (req.usuario.rol !== 'pasajero') return error(res, 403, 'SOLO_PASAJERO', 'Solo el pasajero puede solicitar la cancelación del pedido. El conductor debe usar “Soltar pedido” y el comercio puede rechazarlo desde su bandeja.');
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || String(p.pasajero_id ?? '') !== String(req.usuario.id)) return { e: [404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró un pedido de tu cuenta.'] };
    if (p.estado !== 'creado') return { e: [409, 'CANCELACION_NO_PERMITIDA', 'Solo puedes cancelar mientras el comercio aún no ha aceptado ni está preparando tu pedido.'] };
    return cancelarPedidoTx(cx, p, req.usuario.id, String(req.body?.motivo ?? '').trim().slice(0, 120));
  });
  if (resultado?.e) return error(res, ...resultado.e);
  await notificarPedidoActualizado(id);
  return ok(res, resultado);
});

// Comercio confirma el QR del producto solo después de comprobar el abono real en su banco.
rutaPedidos.post('/:id/comercio/confirmar-pago-producto', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'comercio', 'Solo el comercio puede confirmar el pago del producto.')) return;
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || String(p.usuario_comercio_id) !== String(req.usuario.id)) return { e: [404, 'PEDIDO_NO_ENCONTRADO', 'Pedido no encontrado para este comercio.'] };
    if (p.metodo_pago_producto !== 'qr') return { e: [409, 'PAGO_NO_QR', 'Este pedido no se configuró para pagar productos por QR.'] };
    if (p.estado_pago_producto === 'confirmado') return { e: [409, 'PAGO_YA_CONFIRMADO', 'El pago de los productos ya fue confirmado.'] };
    if (p.estado !== 'creado') return { e: [409, 'ESTADO_INVALIDO', 'Solo se confirma el pago de productos antes de aceptar el pedido.'] };
    const ref = String(req.body?.referencia_pago ?? '').trim().slice(0, 100) || null;
    if (!ref || ref.length < 3) return { e: [422, 'REFERENCIA_REQUERIDA', 'Introduce la referencia bancaria después de comprobar el depósito real.'] };
    await cx.execute("UPDATE pedidos SET estado_pago_producto='confirmado',pagado_producto_en=UTC_TIMESTAMP() WHERE id=?", [id]);
    await cx.execute("UPDATE pagos SET estado='confirmado',referencia_proveedor=COALESCE(?,referencia_proveedor),confirmado_en=UTC_TIMESTAMP(),actualizado_en=UTC_TIMESTAMP() WHERE pedido_id=? AND detalle_json->>'$.componente'='productos' AND estado='pendiente'", [ref, id]);
    return { pedido_id: id, estado_pago_producto: 'confirmado', mensaje: 'Pago anotado por el comercio. Se habilita aceptar el pedido.' };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  await notificarPedidoActualizado(id);
  return ok(res, resultado);
});

rutaPedidos.post('/:id/comercio/aceptar', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'comercio', 'Solo el comercio puede aceptar pedidos.')) return;
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || String(p.usuario_comercio_id) !== String(req.usuario.id)) return { e: [404, 'PEDIDO_NO_ENCONTRADO', 'Pedido no encontrado para este comercio.'] };
    if (p.estado !== 'creado') return { e: [409, 'ESTADO_INVALIDO', 'El pedido ya fue procesado.'] };
    if (p.metodo_pago_producto === 'qr' && p.estado_pago_producto !== 'confirmado') return { e: [409, 'PAGO_PRODUCTO_PENDIENTE', 'Confirma el abono del QR en tu banco antes de aceptar el pedido.'] };
    await cx.execute("UPDATE pedidos SET estado='buscando_repartidor',asignado_en=NULL WHERE id=?", [id]);
    return { pedido_id: id, estado: 'buscando_repartidor', mensaje: 'Pedido aceptado. Se está buscando un repartidor cercano.' };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  await notificarPedidoActualizado(id);
  await avisarOfertaDelivery(id);
  return ok(res, resultado);
});

rutaPedidos.post('/:id/comercio/rechazar', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'comercio', 'Solo el comercio puede rechazar pedidos.')) return;
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || String(p.usuario_comercio_id) !== String(req.usuario.id)) return { e: [404, 'PEDIDO_NO_ENCONTRADO', 'Pedido no encontrado para este comercio.'] };
    if (p.estado !== 'creado') return { e: [409, 'ESTADO_INVALIDO', 'El comercio solo puede rechazar un pedido antes de aceptarlo.'] };
    return cancelarPedidoTx(cx, p, req.usuario.id, `rechazado por comercio: ${String(req.body?.motivo ?? 'sin stock').slice(0,100)}`);
  });
  if (resultado?.e) return error(res, ...resultado.e);
  return ok(res, resultado);
});

// El comercio registra la devolución bancaria real de un producto QR cancelado.
rutaPedidos.post('/:id/comercio/confirmar-reembolso', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'comercio', 'Solo el comercio puede confirmar el reembolso.')) return;
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const referencia = String(req.body?.referencia_reembolso ?? '').trim().slice(0, 100);
  if (referencia.length < 3) return error(res, 422, 'REFERENCIA_REQUERIDA', 'Registra la referencia de la transferencia de devolución ya realizada.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || String(p.usuario_comercio_id) !== String(req.usuario.id)) return { e: [404, 'PEDIDO_NO_ENCONTRADO', 'Pedido no encontrado para este comercio.'] };
    if (p.estado !== 'reembolso_pendiente' || p.estado_reembolso !== 'pendiente') return { e: [409, 'REEMBOLSO_NO_PENDIENTE', 'Este pedido no tiene un reembolso pendiente.'] };
    await cx.execute("UPDATE pedidos SET estado='cancelado',estado_reembolso='reembolsado',referencia_reembolso=?,reembolso_en=UTC_TIMESTAMP() WHERE id=?", [referencia, id]);
    await cx.execute("UPDATE pagos SET estado='reembolsado',referencia_proveedor=COALESCE(referencia_proveedor,?),actualizado_en=UTC_TIMESTAMP() WHERE pedido_id=? AND detalle_json->>'$.componente'='productos' AND estado='confirmado'", [referencia,id]);
    return { pedido_id: id, estado: 'cancelado', estado_reembolso: 'reembolsado', mensaje: 'Devolución bancaria registrada. El comercio confirma que realizó el reembolso y se guardó la referencia.' };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  await notificarPedidoActualizado(id);
  return ok(res, resultado);
});

// El comercio confirma que entregó físicamente el pedido al repartidor.
rutaPedidos.post('/:id/comercio/entregar-a-repartidor', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'comercio', 'Solo el comercio puede confirmar la entrega al repartidor.')) return;
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || String(p.usuario_comercio_id) !== String(req.usuario.id)) return { e: [404, 'PEDIDO_NO_ENCONTRADO', 'Pedido no encontrado para este comercio.'] };
    if (p.estado !== 'asignado') return { e: [409, 'ESTADO_INVALIDO', 'Solo se marca la entrega al repartidor cuando hay un conductor asignado.'] };
    await cx.execute("UPDATE pedidos SET estado='recogido',recogido_en=UTC_TIMESTAMP() WHERE id=?", [id]);
    return { pedido_id: id, estado: 'recogido' };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  await notificarPedidoActualizado(id);
  return ok(res, resultado);
});

// Comercio recibe del repartidor el efectivo del producto (solo para pedidos con producto pagado en efectivo).
rutaPedidos.post('/:id/comercio/confirmar-liquidacion-efectivo', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'comercio', 'Solo el comercio puede confirmar la liquidación de efectivo.')) return;
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || String(p.usuario_comercio_id) !== String(req.usuario.id)) return { e: [404, 'PEDIDO_NO_ENCONTRADO', 'Pedido no encontrado para este comercio.'] };
    if (p.metodo_pago_producto !== 'efectivo' || p.estado_pago_producto !== 'liquidacion_pendiente' || p.estado !== 'entregado') return { e: [409, 'LIQUIDACION_NO_PENDIENTE', 'No hay una liquidación de efectivo pendiente para este pedido.'] };
    await cx.execute("UPDATE pedidos SET estado_pago_producto='confirmado',liquidacion_comercio_en=UTC_TIMESTAMP() WHERE id=?", [id]);
    return { pedido_id: id, estado_pago_producto: 'confirmado', mensaje: 'Entrega del efectivo al comercio confirmada.' };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  await notificarPedidoActualizado(id);
  return ok(res, resultado);
});

// Conductor acepta un delivery. La comisión se reserva ahora para que otro viaje no gaste ese saldo.
rutaPedidos.post('/:id/aceptar', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'conductor', 'Solo el conductor puede aceptar un delivery.')) return;
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || p.estado !== 'buscando_repartidor') return { e: [409, 'PEDIDO_NO_DISPONIBLE', 'Este pedido ya no está disponible.'] };
    if (p.metodo_pago_producto === 'qr' && p.estado_pago_producto !== 'confirmado') return { e: [409, 'PAGO_PRODUCTO_PENDIENTE', 'El comercio aún no confirma el pago de los productos.'] };
    const [cs] = await cx.execute(
      `SELECT c.id AS conductor_id,c.estado_aprobacion,c.estado_operativo,c.qr_pago_url,c.qr_pago_vence_en,IF(c.qr_pago_url IS NOT NULL AND c.qr_pago_vence_en > UTC_TIMESTAMP(),1,0) AS qr_vigente,c.licencia_vence_en,
              b.id AS billetera_id,b.saldo_prepago,b.saldo_comision_reservado,b.estado AS billetera_estado,
              m.id AS moto_id,m.tipo_vehiculo,u.restringido_hasta,cu.latitud,cu.longitud,cu.es_mock,cu.actualizado_en,
              IF(cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL 120 SECOND,1,0) AS ubicacion_reciente
         FROM conductores c JOIN usuarios u ON u.id=c.usuario_id
         JOIN billeteras b ON b.conductor_id=c.id LEFT JOIN motos m ON m.conductor_id=c.id
         LEFT JOIN conductor_ubicacion cu ON cu.conductor_id=c.id
        WHERE c.usuario_id=? LIMIT 1 FOR UPDATE`, [req.usuario.id],
    );
    const c = cs[0];
    if (!c || c.estado_aprobacion !== 'aprobado' || c.estado_operativo !== 'disponible' || c.billetera_estado !== 'activa' || !c.moto_id) return { e: [409, 'CONDUCTOR_NO_DISPONIBLE', 'Debes tener cuenta aprobada, vehículo registrado, billetera activa y estar disponible.'] };
    if (String(c.tipo_vehiculo) !== String(p.tipo_vehiculo_delivery ?? 'moto')) return { e: [409, 'VEHICULO_NO_COINCIDE', `Este pedido requiere ${p.tipo_vehiculo_delivery ?? 'moto'}.`] };
    if (p.metodo_pago_delivery === 'qr' && (!c.qr_pago_url || Number(c.qr_vigente) !== 1)) return { e: [409, 'QR_CONDUCTOR_NO_CONFIGURADO', 'Sube o renueva tu QR bancario; el QR guardado no está vigente.'] };
    if (c.restringido_hasta && new Date(c.restringido_hasta).getTime() > Date.now()) return { e: [403, 'CUENTA_RESTRINGIDA', 'Tu cuenta tiene una restricción temporal.'] };
    if (c.licencia_vence_en == null || String(c.licencia_vence_en).slice(0,10) < new Date().toISOString().slice(0,10)) return { e: [403, 'LICENCIA_VENCIDA', 'Registra una licencia vigente.'] };
    if (c.latitud == null || c.longitud == null || Number(c.es_mock) === 1 || Number(c.ubicacion_reciente) !== 1) return { e: [409, 'UBICACION_NO_ACTUALIZADA', 'Actualiza tu ubicación GPS antes de aceptar pedidos.'] };
    const [docs] = await cx.execute(
      `SELECT DISTINCT tipo FROM documentos_conductor WHERE conductor_id=? AND estado='aprobado' AND (vence_en IS NULL OR vence_en >= DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR))`, [c.conductor_id],
    );
    const requeridos = c.tipo_vehiculo === 'auto'
      ? ['ci_frente','ci_reverso','selfie','licencia_frente','licencia_reverso','selfie_licencia','soat','tarjeta_propiedad','foto_placa','foto_auto_frente','foto_auto_atras','foto_auto_lateral','ruat']
      : ['ci_frente','ci_reverso','selfie','licencia_frente','licencia_reverso','selfie_licencia','soat','tarjeta_propiedad','foto_placa','foto_moto'];
    const present = new Set(docs.map((x) => x.tipo));
    const faltan = requeridos.filter((x) => !present.has(x));
    if (faltan.length) return { e: [403, 'DOCUMENTOS_NO_VIGENTES', 'Debes tener todos los documentos requeridos aprobados y vigentes.', { faltan }] };
    const radio = Math.max(1, Math.min(20, await ajusteNumero('radio_busqueda_delivery_km', 5)));
    const distancia = Math.hypot(
      (Number(c.latitud) - Number(p.recogida_lat)) * 111_000,
      (Number(c.longitud) - Number(p.recogida_lng)) * 111_000 * Math.cos(Number(c.latitud) * Math.PI / 180),
    );
    if (distancia > radio * 1000) return { e: [409, 'FUERA_DEL_RADIO', `Debes estar a menos de ${radio} km del comercio.`, { distancia_m: Math.round(distancia), radio_km: radio }] };
    const [activeTrips] = await cx.execute("SELECT id FROM viajes WHERE conductor_id=? AND estado IN ('aceptado','conductor_llego','en_curso') LIMIT 1 FOR UPDATE", [c.conductor_id]);
    const [activeOrders] = await cx.execute("SELECT id FROM pedidos WHERE conductor_id=? AND estado IN ('asignado','recogido','en_camino') LIMIT 1 FOR UPDATE", [c.conductor_id]);
    const [activeEnvios] = await cx.execute("SELECT id FROM envios WHERE conductor_id=? AND estado IN ('asignado','recogido','en_camino','en_punto_entrega','requiere_revision') LIMIT 1 FOR UPDATE", [c.conductor_id]);
    if (activeTrips[0] || activeOrders[0] || activeEnvios[0]) return { e: [409, 'SERVICIO_ACTIVO', 'Termina el viaje o delivery activo antes de aceptar otro servicio.'] };
    // Sistema de puntos: se reservan exactamente los puntos del pedido (fijados al crearlo).
    const disponible = saldoDisponible(c.saldo_prepago, c.saldo_comision_reservado);
    const requerido = DINERO(Number(p.comision_monto));
    if (disponible < requerido) return { e: [409, 'SALDO_INSUFICIENTE', `No tienes puntos suficientes para aceptar este pedido. Necesitas ${requerido} puntos disponibles; recarga puntos para seguir recibiendo servicios.`, { disponible_bs: disponible, requerido_bs: requerido, comision_bs: Number(p.comision_monto), minimo_bs: 0, puntos_disponibles: disponible, puntos_requeridos: requerido }] };
    await cx.execute('UPDATE billeteras SET saldo_comision_reservado=saldo_comision_reservado+? WHERE id=?', [Number(p.comision_monto),c.billetera_id]);
    await cx.execute(
      `UPDATE pedidos SET estado='asignado',conductor_id=?,moto_id=?,asignado_en=UTC_TIMESTAMP(),
              qr_conductor_snapshot=?,comision_delivery_reservada=1
        WHERE id=? AND estado='buscando_repartidor'`, [c.conductor_id,c.moto_id,c.qr_pago_url,id],
    );
    await cx.execute("UPDATE conductores SET estado_operativo='en_viaje' WHERE id=?", [c.conductor_id]);
    return { pedido_id: id, estado: 'asignado', mensaje: 'Pedido aceptado. Dirígete al comercio y espera a que confirme la entrega del paquete.' };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  await notificarPedidoActualizado(id);
  return ok(res, resultado);
});

// Un conductor puede devolver a la bolsa una asignación no recogida; nunca cancela el pedido del cliente.
rutaPedidos.post('/:id/soltar', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'conductor', 'Solo el conductor asignado puede soltar un pedido.')) return;
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || String(p.usuario_conductor_id ?? '') !== String(req.usuario.id)) return { e: [404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró un pedido asignado a tu cuenta.'] };
    if (p.estado !== 'asignado') return { e: [409, 'NO_SE_PUEDE_SOLTAR', 'Solo puedes soltar un pedido antes de confirmar la recogida.'] };
    await liberarReservaConductor(cx, p);
    await cx.execute(`UPDATE pedidos SET estado='buscando_repartidor',conductor_id=NULL,moto_id=NULL,asignado_en=NULL,qr_conductor_snapshot=NULL,comision_delivery_reservada=0 WHERE id=?`, [id]);
    const [wallets] = await cx.execute('SELECT saldo_prepago,saldo_comision_reservado FROM billeteras WHERE conductor_id=? LIMIT 1', [p.conductor_id]);
    const minSaldo = config.puntosPorViaje;
    const disponible = saldoDisponible(wallets[0]?.saldo_prepago, wallets[0]?.saldo_comision_reservado);
    await cx.execute('UPDATE conductores SET estado_operativo=? WHERE id=?', [disponible >= minSaldo ? 'disponible' : 'bloqueado_saldo', p.conductor_id]);
    return { pedido_id: id, estado: 'buscando_repartidor', mensaje: 'Pedido devuelto a la bolsa de ofertas. La compra del cliente sigue activa.' };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  await notificarPedidoActualizado(id);
  await avisarOfertaDelivery(id);
  return ok(res, resultado);
});

rutaPedidos.post('/:id/iniciar', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'conductor', 'Solo el conductor asignado puede iniciar el delivery.')) return;
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || String(p.usuario_conductor_id ?? '') !== String(req.usuario.id)) return { e: [404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró un pedido asignado a tu cuenta.'] };
    if (p.estado !== 'recogido') return { e: [409, 'PEDIDO_NO_RECOGIDO', 'El comercio debe marcar primero “Pedido entregado a tu repartidor”.'] };
    if (p.metodo_pago_producto === 'qr' && p.estado_pago_producto !== 'confirmado') return { e: [409, 'PAGO_PRODUCTO_PENDIENTE', 'El pago de los productos todavía no está confirmado por el comercio.'] };
    const ubicacion = await gpsConductorReciente(cx, p.conductor_id);
    if (!ubicacion) return { e: [409, 'GPS_NO_VALIDO', 'Activa el GPS y actualiza tu ubicación antes de iniciar el reparto.'] };
    const tolerancia = Math.max(50, Math.min(300, await ajusteNumero('tolerancia_recogida_delivery_m', 150)));
    const metros = haversineMetros(ubicacion.lat, ubicacion.lng, Number(p.recogida_lat), Number(p.recogida_lng));
    if (metros > tolerancia) return { e: [409, 'LEJOS_DEL_COMERCIO', `Debes estar a ${tolerancia} m o menos del comercio para iniciar el reparto.`, { distancia_m: Math.round(metros), tolerancia_m: tolerancia }] };
    await cx.execute("UPDATE pedidos SET estado='en_camino' WHERE id=?", [id]);
    return { pedido_id: id, estado: 'en_camino' };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  await notificarPedidoActualizado(id);
  return ok(res, resultado);
});

// Confirmar que recibió el importe de delivery. En QR la referencia es informativa y la verificación la hace el conductor en su banco.
rutaPedidos.post('/:id/confirmar-cobro-delivery', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'conductor', 'Solo el conductor asignado puede confirmar el cobro del delivery.')) return;
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || String(p.usuario_conductor_id ?? '') !== String(req.usuario.id)) return { e: [404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró un pedido asignado a tu cuenta.'] };
    if (p.estado !== 'en_camino') return { e: [409, 'ESTADO_INVALIDO', 'El cobro se confirma durante el reparto, antes de finalizar.'] };
    if (p.estado_pago_delivery === 'confirmado') return { e: [409, 'PAGO_YA_CONFIRMADO', 'El cobro de delivery ya fue registrado.'] };
    const ref = String(req.body?.referencia_pago ?? '').trim().slice(0,100) || null;
    if (p.metodo_pago_delivery === 'qr' && !ref) return { e: [422, 'REFERENCIA_REQUERIDA', 'Indica la referencia que ves en tu aplicación bancaria después de comprobar el abono.'] };
    await cx.execute("UPDATE pedidos SET estado_pago_delivery='confirmado',pagado_delivery_en=UTC_TIMESTAMP() WHERE id=?", [id]);
    await cx.execute("UPDATE pagos SET estado='confirmado',referencia_proveedor=COALESCE(?,referencia_proveedor),confirmado_en=UTC_TIMESTAMP(),actualizado_en=UTC_TIMESTAMP() WHERE pedido_id=? AND detalle_json->>'$.componente'='delivery' AND estado='pendiente'", [ref,id]);
    return { pedido_id: id, estado_pago_delivery: 'confirmado', estado_pago_producto: p.estado_pago_producto, mensaje: p.metodo_pago_delivery === 'qr' ? 'Pago QR marcado como recibido tras verificación manual en tu banco.' : 'Pago de delivery en efectivo registrado; los productos se pagan directamente al QR del comercio.' };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  await notificarPedidoActualizado(id);
  return ok(res, resultado);
});

// Finaliza el delivery y convierte las dos reservas en descuentos reales, idempotentes y transaccionales.
rutaPedidos.post('/:id/finalizar', async (req, res) => {
  if (!rol(res, req.usuario.rol, 'conductor', 'Solo el conductor asignado puede finalizar el delivery.')) return;
  const id = ID(req.params.id);
  if (!id) return error(res, 404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró el pedido.');
  const resultado = await tx(async (cx) => {
    const p = await pedidoRow(cx, id, true);
    if (!p || String(p.usuario_conductor_id ?? '') !== String(req.usuario.id)) return { e: [404, 'PEDIDO_NO_ENCONTRADO', 'No se encontró un pedido asignado a tu cuenta.'] };
    if (p.estado === 'entregado') return { e: [409, 'PEDIDO_YA_FINALIZADO', 'Este pedido ya fue finalizado.'] };
    if (p.estado !== 'en_camino') return { e: [409, 'ESTADO_INVALIDO', 'El pedido debe estar en camino para finalizarlo.'] };
    if (p.estado_pago_delivery !== 'confirmado') return { e: [409, 'COBRO_DELIVERY_PENDIENTE', 'Confirma primero que recibiste el pago del delivery (efectivo o QR verificado).'] };
    if (p.metodo_pago_producto === 'qr' && p.estado_pago_producto !== 'confirmado') return { e: [409, 'PAGO_PRODUCTO_PENDIENTE', 'El comercio todavía no confirmó el pago QR de los productos.'] };
    const ubicacion = await gpsConductorReciente(cx, p.conductor_id);
    if (!ubicacion) return { e: [409, 'GPS_NO_VALIDO', 'Activa el GPS y actualiza tu ubicación antes de finalizar el reparto.'] };
    const toleranciaEntrega = Math.max(50, Math.min(300, await ajusteNumero('tolerancia_entrega_delivery_m', 150)));
    const metrosEntrega = haversineMetros(ubicacion.lat, ubicacion.lng, Number(p.entrega_lat), Number(p.entrega_lng));
    if (metrosEntrega > toleranciaEntrega) return { e: [409, 'LEJOS_DEL_DESTINO', `Debes estar a ${toleranciaEntrega} m o menos de la dirección de entrega para finalizar.`, { distancia_m: Math.round(metrosEntrega), tolerancia_m: toleranciaEntrega }] };
    const [ws] = await cx.execute(
      'SELECT id,saldo_prepago,saldo_comision_reservado FROM billeteras WHERE conductor_id=? LIMIT 1 FOR UPDATE', [p.conductor_id],
    );
    const w = ws[0];
    const comDelivery = enteroBs(p.comision_monto);
    const [es] = await cx.execute('SELECT id,saldo_comision,saldo_comision_reservado FROM empresas WHERE id=? LIMIT 1 FOR UPDATE', [p.empresa_id]);
    const e = es[0];
    const comVenta = DINERO(p.comision_venta_monto);
    const driverBad = !w || Number(p.comision_delivery_reservada) !== 1
      || Number(w.saldo_prepago) < comDelivery
      || Number(w.saldo_comision_reservado) < comDelivery
      || Number(w.saldo_prepago) < Number(w.saldo_comision_reservado);
    const merchantBad = !e || Number(p.comision_venta_reservada) !== 1
      || Number(e.saldo_comision) < comVenta
      || Number(e.saldo_comision_reservado) < comVenta
      || Number(e.saldo_comision) < Number(e.saldo_comision_reservado);
    if (driverBad || merchantBad) {
      const motivos = [driverBad ? 'Saldo o reserva de comisión del conductor inconsistente' : '', merchantBad ? 'Saldo o reserva de comisión del comercio inconsistente' : ''].filter(Boolean).join('; ');
      await cx.execute("UPDATE pedidos SET estado='requiere_revision',revision_motivo=?,revision_en=UTC_TIMESTAMP() WHERE id=?", [motivos.slice(0,255),id]);
      await cx.execute("UPDATE conductores SET estado_operativo='bloqueado_saldo' WHERE id=?", [p.conductor_id]);
      return { requiere_revision: true, pedido_id: id, estado: 'requiere_revision', motivo: motivos, mensaje: 'El pedido se guardó en la cola de revisión administrativa. No se aplicó ningún descuento parcial.' };
    }
    const saldoDriverAntes = Number(w.saldo_prepago);
    const saldoDriverDespues = DINERO(saldoDriverAntes - comDelivery);
    await cx.execute('UPDATE billeteras SET saldo_prepago=?,saldo_comision_reservado=saldo_comision_reservado-? WHERE id=?', [saldoDriverDespues,comDelivery,w.id]);
    if (comDelivery > 0) {
      await cx.execute(
        `INSERT INTO movimientos_billetera (billetera_id,cuenta,tipo,monto,saldo_antes,saldo_despues,pedido_id,descripcion,idempotency_key)
         VALUES (?,'prepago','comision',?,?,?,?,?,?)`,
        [w.id,-comDelivery,saldoDriverAntes,saldoDriverDespues,id,`Comisión pedido #${id}: -${comDelivery} pts`,`comision:pedido:${id}`],
      );
    }
    const saldoEmpresaAntes = Number(e.saldo_comision);
    const saldoEmpresaDespues = DINERO(saldoEmpresaAntes - comVenta);
    await cx.execute('UPDATE empresas SET saldo_comision=?,saldo_comision_reservado=saldo_comision_reservado-? WHERE id=?', [saldoEmpresaDespues,comVenta,e.id]);
    if (comVenta > 0) {
      await cx.execute(
        `INSERT INTO movimientos_comision_comercio (empresa_id,tipo,monto,saldo_antes,saldo_despues,pedido_id,descripcion,idempotency_key)
         VALUES (?,'comision_venta',?,?,?,?,?,?)`,
        [e.id,-comVenta,saldoEmpresaAntes,saldoEmpresaDespues,id,`Comisión venta pedido #${id}: -${comVenta} pts`,`comision:venta:pedido:${id}`],
      );
    }
    await cx.execute("UPDATE pedidos SET estado='entregado',entregado_en=UTC_TIMESTAMP(),comision_delivery_reservada=0,comision_venta_reservada=0 WHERE id=?", [id]);
    const saldoMinimo = config.puntosPorViaje;
    await cx.execute("UPDATE conductores SET estado_operativo=? WHERE id=? AND estado_operativo='en_viaje'", [saldoDriverDespues < saldoMinimo ? 'bloqueado_saldo' : 'disponible', p.conductor_id]);
    return { pedido_id: id, estado: 'entregado', subtotal_productos_bs: Number(p.subtotal_productos), tarifa_delivery_bs: enteroBs(p.tarifa_envio),
      comision_comercio_bs: comVenta, saldo_comision_comercio_bs: saldoEmpresaDespues,
      comision_conductor_bs: comDelivery, saldo_comision_conductor_bs: saldoDriverDespues,
      conductor_puede_seguir_operando: saldoDriverDespues >= saldoMinimo,
      liquidacion_comercio: 'no_aplica: los productos se pagan directamente al QR del comercio',
      puntos_descontados_conductor: comDelivery, puntos_descontados_comercio: comVenta,
      mensaje: 'Delivery finalizado. Se descontaron los puntos De Volada del conductor y del comercio; los cobros de cliente siguen siendo directos al efectivo/QR de sus receptores.' };
  });
  if (resultado?.e) return error(res, ...resultado.e);
  if (resultado?.requiere_revision) {
    await notificarPedidoActualizado(id);
    return error(res, 409, 'REVISION_ADMINISTRATIVA', resultado.mensaje, { pedido_id: id, motivo: resultado.motivo });
  }
  await notificarPedidoActualizado(id);
  return ok(res, resultado);
});

export default rutaPedidos;
