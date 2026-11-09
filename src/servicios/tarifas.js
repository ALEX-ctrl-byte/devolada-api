import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { ajusteNumero } from './ajustes.js';
import { obtenerRutaOSRM } from './osrm.js';
import { calcularImporteTransportes, enteroBs } from './calculoTarifaPura.js';

function distanciaHaversineMetros(a, b) {
  const rad = (n) => n * Math.PI / 180;
  const dLat = rad(Number(b.lat) - Number(a.lat));
  const dLng = rad(Number(b.lng) - Number(a.lng));
  const lat1 = rad(Number(a.lat));
  const lat2 = rad(Number(b.lat));
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

function validarTipoVehiculo(tipo) {
  return tipo === 'auto' ? 'auto' : 'moto';
}

async function leerOfertaConductores(origen, tipoVehiculo, radioCercanoKm, radioAproximacionKm, gpsMaxSegundos, saldoMinimo) {
  const gpsMax = Math.max(30, Math.min(300, Math.floor(gpsMaxSegundos)));
  const condiciones = `c.estado_aprobacion='aprobado'
      AND c.estado_operativo='disponible'
      AND u.estado='activo'
      AND (u.restringido_hasta IS NULL OR u.restringido_hasta <= UTC_TIMESTAMP())
      AND c.licencia_vence_en IS NOT NULL
      AND c.licencia_vence_en >= DATE(UTC_TIMESTAMP() - INTERVAL 4 HOUR)
      AND m.tipo_vehiculo=?
      AND b.estado='activa'
      AND b.saldo_prepago - COALESCE(b.saldo_comision_reservado,0) >= ?
      AND cu.es_mock=0
      AND cu.actualizado_en >= UTC_TIMESTAMP() - INTERVAL ${gpsMax} SECOND`;
  const [cuentaRows] = await db.execute(
    `SELECT COUNT(*) AS total
       FROM conductores c
       JOIN usuarios u ON u.id=c.usuario_id
       JOIN motos m ON m.conductor_id=c.id
       JOIN billeteras b ON b.conductor_id=c.id
       JOIN conductor_ubicacion cu ON cu.conductor_id=c.id
      WHERE ${condiciones}
        AND ST_Distance_Sphere(POINT(cu.longitud,cu.latitud),POINT(?,?)) <= ?`,
    [tipoVehiculo, saldoMinimo, origen.lng, origen.lat, radioCercanoKm * 1000],
  );
  const disponiblesCercanos = Number(cuentaRows[0]?.total ?? 0);

  const [cercanos] = await db.execute(
    `SELECT cu.latitud,cu.longitud,
            ST_Distance_Sphere(POINT(cu.longitud,cu.latitud),POINT(?,?)) AS distancia_linea_m
       FROM conductores c
       JOIN usuarios u ON u.id=c.usuario_id
       JOIN motos m ON m.conductor_id=c.id
       JOIN billeteras b ON b.conductor_id=c.id
       JOIN conductor_ubicacion cu ON cu.conductor_id=c.id
      WHERE ${condiciones}
        AND ST_Distance_Sphere(POINT(cu.longitud,cu.latitud),POINT(?,?)) <= ?
      ORDER BY distancia_linea_m ASC
      LIMIT 1`,
    [origen.lng, origen.lat, tipoVehiculo, saldoMinimo, origen.lng, origen.lat, radioAproximacionKm * 1000],
  );
  const primero = cercanos[0];
  return {
    disponiblesCercanos,
    conductorMasCercano: primero ? {
      lat: Number(primero.latitud),
      lng: Number(primero.longitud),
      distanciaLineaM: Math.round(Number(primero.distancia_linea_m)),
    } : null,
  };
}

async function contarDemandaCercana(origen, tipoVehiculo, radioKm) {
  const radioM = radioKm * 1000;
  const [viajes] = await db.execute(
    `SELECT COUNT(*) AS total FROM viajes
      WHERE estado='solicitado'
        AND (tipo_vehiculo_solicitado=? OR tipo_vehiculo_solicitado IS NULL)
        AND ST_Distance_Sphere(POINT(origen_lng,origen_lat),POINT(?,?)) <= ?`,
    [tipoVehiculo, origen.lng, origen.lat, radioM],
  );
  const [envios] = await db.execute(
    `SELECT COUNT(*) AS total FROM envios
      WHERE estado='solicitado' AND tipo_vehiculo=?
        AND ST_Distance_Sphere(POINT(recogida_lng,recogida_lat),POINT(?,?)) <= ?`,
    [tipoVehiculo, origen.lng, origen.lat, radioM],
  );
  const [pedidos] = await db.execute(
    `SELECT COUNT(*) AS total FROM pedidos
      WHERE estado='buscando_repartidor' AND tipo_vehiculo_delivery=?
        AND ST_Distance_Sphere(POINT(recogida_lng,recogida_lat),POINT(?,?)) <= ?`,
    [tipoVehiculo, origen.lng, origen.lat, radioM],
  );
  return Number(viajes[0]?.total ?? 0) + Number(envios[0]?.total ?? 0) + Number(pedidos[0]?.total ?? 0);
}

async function estimarAproximacion(origen, conductor) {
  if (!conductor) {
    return {
      distancia_m: 0,
      duracion_estimada_s: 0,
      estimacion: 'sin_conductor_cercano',
    };
  }
  if (conductor.distanciaLineaM <= 50) {
    return { distancia_m: 0, duracion_estimada_s: 0, estimacion: 'conductor_junto_al_origen' };
  }
  try {
    const ruta = await obtenerRutaOSRM({ lat: conductor.lat, lng: conductor.lng }, origen);
    return {
      distancia_m: ruta.distancia_m,
      duracion_estimada_s: ruta.duracion_estimada_s,
      estimacion: 'ruta_osrm',
    };
  } catch {
    // Si falla solamente la ruta de aproximación, se usa una estimación prudente desde la
    // distancia en línea recta. La ruta principal sigue siendo obligatoriamente OSRM.
    const distancia = Math.round(conductor.distanciaLineaM * 1.25);
    return {
      distancia_m: distancia,
      duracion_estimada_s: Math.max(60, Math.ceil(distancia / 1000) * 180),
      estimacion: 'aproximacion_aproximada',
    };
  }
}

/**
 * Motor común de tarifas de transporte, envíos personales y delivery de comercios.
 * Todos los importes cobrados se redondean a bolivianos enteros. Las rutas y precios
 * se calculan en el servidor; el cliente no puede enviar su propia tarifa.
 */
export async function calcularTarifaDeUna({ tipoServicio, tipoVehiculo: tipoEntrada, origen, rutaServicio }) {
  const tipoVehiculo = validarTipoVehiculo(tipoEntrada);
  const radioCercanoKm = Math.max(1, Math.min(10, await ajusteNumero('tarifa_radio_conductores_km', 3)));
  const radioAproximacionKm = Math.max(radioCercanoKm, Math.min(20, await ajusteNumero('tarifa_radio_aproximacion_km', 20)));
  const gpsMax = Math.max(30, Math.min(300, await ajusteNumero('tarifa_ubicacion_max_s', 120)));
  const umbralMuchos = Math.max(2, Math.min(50, Math.floor(await ajusteNumero('tarifa_umbral_muchos_conductores', 5))));
  const baseNormal = enteroBs(await ajusteNumero('tarifa_base_normal_bs', 4));
  const baseExcesoOferta = enteroBs(await ajusteNumero('tarifa_base_muchos_conductores_bs', 3));
  // Sistema de puntos: cuentan como oferta los conductores con puntos para al menos un servicio.
  const saldoMinimo = config.puntosPorViaje;

  const [oferta, demanda] = await Promise.all([
    leerOfertaConductores(origen, tipoVehiculo, radioCercanoKm, radioAproximacionKm, gpsMax, saldoMinimo),
    contarDemandaCercana(origen, tipoVehiculo, radioCercanoKm),
  ]);
  const hayOfertaAbundante = oferta.disponiblesCercanos >= umbralMuchos
    && demanda < oferta.disponiblesCercanos;
  const base = hayOfertaAbundante ? baseExcesoOferta : baseNormal;
  const aproximacion = await estimarAproximacion(origen, oferta.conductorMasCercano);

  const precioPorKm = enteroBs(await ajusteNumero(
    tipoVehiculo === 'auto' ? 'tarifa_km_auto_bs' : 'tarifa_km_moto_bs',
    tipoVehiculo === 'auto' ? 2 : 1,
  ));
  const precioTiempo5Min = enteroBs(await ajusteNumero(
    tipoVehiculo === 'auto' ? 'tarifa_tiempo_auto_5min_bs' : 'tarifa_tiempo_moto_5min_bs', 1,
  ));
  const precioAproximacionPorKm = enteroBs(await ajusteNumero(
    tipoVehiculo === 'auto' ? 'tarifa_aproximacion_km_auto_bs' : 'tarifa_aproximacion_km_moto_bs',
    tipoVehiculo === 'auto' ? 2 : 1,
  ));
  const precioAproximacionTiempo5Min = enteroBs(await ajusteNumero(
    tipoVehiculo === 'auto' ? 'tarifa_aproximacion_tiempo_auto_5min_bs' : 'tarifa_aproximacion_tiempo_moto_5min_bs', tipoVehiculo === 'auto' ? 2 : 1,
  ));
  const importe = calcularImporteTransportes({
    base,
    distanciaServicioM: rutaServicio.distancia_m,
    duracionServicioS: rutaServicio.duracion_estimada_s,
    distanciaAproximacionM: aproximacion.distancia_m,
    duracionAproximacionS: aproximacion.duracion_estimada_s,
    precioPorKm,
    precioTiempo5Min,
    precioAproximacionPorKm,
    precioAproximacionTiempo5Min,
  });
  const {
    kmServicio, bloquesTiempoServicio, kmAproximacion, bloquesTiempoAproximacion,
    subtotalDistanciaBs: subtotalDistancia, subtotalTiempoBs: subtotalTiempo,
    subtotalAproximacionDistanciaBs: subtotalAproximacionDistancia,
    subtotalAproximacionTiempoBs: subtotalAproximacionTiempo,
    tarifaBs: tarifaTotal,
  } = importe;

  const detalle = {
    version: 1,
    tipo_servicio: String(tipoServicio ?? 'servicio'),
    tipo_vehiculo: tipoVehiculo,
    moneda: 'BOB',
    todos_los_importes_son_enteros: true,
    regla_base: hayOfertaAbundante ? 'oferta_abundante' : (demanda >= oferta.disponiblesCercanos && demanda > 0 ? 'demanda_igual_o_mayor_que_oferta' : 'oferta_normal'),
    tarifa_base_bs: base,
    conductores_disponibles_cercanos: oferta.disponiblesCercanos,
    solicitudes_pendientes_cercanas: demanda,
    umbral_muchos_conductores: umbralMuchos,
    radio_conductores_km: radioCercanoKm,
    distancia_aproximacion_m: aproximacion.distancia_m,
    duracion_aproximacion_s: aproximacion.duracion_estimada_s,
    estimacion_aproximacion: aproximacion.estimacion,
    distancia_servicio_m: Math.round(Number(rutaServicio.distancia_m)),
    duracion_servicio_s: Math.round(Number(rutaServicio.duracion_estimada_s)),
    kilometros_servicio_cobrados: kmServicio,
    bloques_tiempo_servicio_de_5_min: bloquesTiempoServicio,
    kilometros_aproximacion_cobrados: kmAproximacion,
    bloques_tiempo_aproximacion_de_5_min: bloquesTiempoAproximacion,
    tarifa_km_bs: importe.precioPorKm,
    tarifa_tiempo_por_5_min_bs: importe.precioTiempo5Min,
    tarifa_aproximacion_km_bs: importe.precioAproximacionPorKm,
    tarifa_aproximacion_por_5_min_bs: importe.precioAproximacionTiempo5Min,
    subtotal_distancia_bs: enteroBs(subtotalDistancia),
    subtotal_tiempo_bs: enteroBs(subtotalTiempo),
    subtotal_aproximacion_distancia_bs: enteroBs(subtotalAproximacionDistancia),
    subtotal_aproximacion_tiempo_bs: enteroBs(subtotalAproximacionTiempo),
    total_bs: tarifaTotal,
    nota: !oferta.conductorMasCercano
      ? 'No hay un conductor compatible con GPS reciente dentro del radio máximo de búsqueda; no se pudo estimar el acercamiento y esta cotización no lo cobra.'
      : oferta.disponiblesCercanos === 0
        ? 'No hay conductores compatibles dentro del radio cercano de disponibilidad; la aproximación se calculó con el más cercano disponible dentro del radio máximo.'
        : 'La aproximación se estima con el conductor disponible más cercano al punto de recogida; la tarifa queda fijada al confirmar la solicitud.',
  };
  return { tarifa_bs: tarifaTotal, detalle };
}

/** Firma cotizaciones de servicios distintos a viajes para congelar precio unos minutos. */
export function crearTokenCotizacionTarifa(datos) {
  const parte = Buffer.from(JSON.stringify(datos)).toString('base64url');
  const firma = crypto.createHmac('sha256', config.otpSecret).update(parte).digest('hex');
  return `${parte}.${firma}`;
}

/** Verifica integridad y caducidad de la cotización firmada por el servidor. */
export function leerTokenCotizacionTarifa(token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const partes = token.split('.');
  if (partes.length !== 2 || !partes[0] || !partes[1]) return null;
  const firmaEsperada = crypto.createHmac('sha256', config.otpSecret).update(partes[0]).digest('hex');
  const a = Buffer.from(firmaEsperada);
  const b = Buffer.from(partes[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
    if (!d || !Number.isSafeInteger(d.usuario_id) || !Number.isFinite(d.expira_en)) return null;
    return d.expira_en < Math.floor(Date.now() / 1000) ? { ...d, expirada: true } : d;
  } catch {
    return null;
  }
}

export { enteroBs };
