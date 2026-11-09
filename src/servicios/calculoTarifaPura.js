/**
 * Cálculo puro de importes del motor tarifario De Volada.
 * No consulta base de datos ni servicios externos; todos los importes son Bs enteros.
 */
export const enteroBs = (valor) => Math.max(0, Math.round(Number(valor) || 0));
const ceilPositivo = (valor) => Math.max(0, Math.ceil(Number(valor) || 0));

export function calcularImporteTransportes({
  base,
  distanciaServicioM,
  duracionServicioS,
  distanciaAproximacionM = 0,
  duracionAproximacionS = 0,
  precioPorKm,
  precioTiempo5Min,
  precioAproximacionPorKm,
  precioAproximacionTiempo5Min,
}) {
  const kmServicio = ceilPositivo(Number(distanciaServicioM) / 1000);
  const bloquesTiempoServicio = ceilPositivo(Number(duracionServicioS) / 300);
  const kmAproximacion = ceilPositivo(Number(distanciaAproximacionM) / 1000);
  const bloquesTiempoAproximacion = ceilPositivo(Number(duracionAproximacionS) / 300);

  const rateKm = enteroBs(precioPorKm);
  const rateTiempo = enteroBs(precioTiempo5Min);
  const rateAproximacionKm = enteroBs(precioAproximacionPorKm);
  const rateAproximacionTiempo = enteroBs(precioAproximacionTiempo5Min);

  const subtotalDistancia = kmServicio * rateKm;
  const subtotalTiempo = bloquesTiempoServicio * rateTiempo;
  const subtotalAproximacionDistancia = kmAproximacion * rateAproximacionKm;
  const subtotalAproximacionTiempo = bloquesTiempoAproximacion * rateAproximacionTiempo;
  const tarifaBs = enteroBs(
    enteroBs(base)
      + subtotalDistancia
      + subtotalTiempo
      + subtotalAproximacionDistancia
      + subtotalAproximacionTiempo,
  );

  return {
    kmServicio,
    bloquesTiempoServicio,
    kmAproximacion,
    bloquesTiempoAproximacion,
    precioPorKm: rateKm,
    precioTiempo5Min: rateTiempo,
    precioAproximacionPorKm: rateAproximacionKm,
    precioAproximacionTiempo5Min: rateAproximacionTiempo,
    subtotalDistanciaBs: enteroBs(subtotalDistancia),
    subtotalTiempoBs: enteroBs(subtotalTiempo),
    subtotalAproximacionDistanciaBs: enteroBs(subtotalAproximacionDistancia),
    subtotalAproximacionTiempoBs: enteroBs(subtotalAproximacionTiempo),
    tarifaBs,
  };
}
