import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.STADIA_MAPS_API_KEY = 'clave-ficticia-de-prueba';

const { obtenerRutaStadia } = await import('../src/servicios/rutasStadia.js');
const { buscarDireccionesStadia, buscarDireccionInversaStadia } = await import('../src/servicios/geocodificacionStadia.js');

function respuestaJson(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

test('Stadia Routing normaliza distancia, duración y geometría GeoJSON', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let llamada; let opciones;
  globalThis.fetch = async (url, init) => {
    llamada = new URL(url);
    opciones = init;
    return respuestaJson({ code: 'Ok', routes: [{ distance: 1460.4, duration: 322.7, geometry: { type: 'LineString', coordinates: [[-68.12, -16.49], [-68.1, -16.48]] } }] });
  };
  const ruta = await obtenerRutaStadia({ lat: -16.49, lng: -68.12 }, { lat: -16.48, lng: -68.1 });
  assert.equal(llamada.hostname, 'api.stadiamaps.com');
  assert.equal(llamada.pathname, '/route/v1');
  assert.equal(llamada.searchParams.get('format'), 'osrm');
  assert.equal(llamada.searchParams.get('overview'), 'full');
  assert.equal(llamada.searchParams.get('geometries'), 'geojson');
  assert.equal(llamada.searchParams.get('steps'), 'false');
  assert.equal(opciones.method, 'POST');
  assert.equal(opciones.headers.Authorization, 'Stadia-Auth clave-ficticia-de-prueba');
  const cuerpo = JSON.parse(opciones.body);
  assert.deepEqual(cuerpo.locations, [
    { lat: -16.49, lon: -68.12, type: 'break' },
    { lat: -16.48, lon: -68.1, type: 'break' },
  ]);
  assert.equal(cuerpo.costing, 'auto');
  assert.equal(ruta.distancia_m, 1460);
  assert.equal(ruta.duracion_estimada_s, 323);
  assert.equal(ruta.geometria.coordinates.length, 2);
});

test('Stadia Routing rechaza coordenadas fuera de rango antes de llamar al proveedor', async () => {
  await assert.rejects(
    obtenerRutaStadia({ lat: -190, lng: 0 }, { lat: 0, lng: 0 }),
    (e) => e.codigo === 'COORDENADAS_INVALIDAS' && e.estadoHttp === 422,
  );
});

test('Stadia Routing devuelve error 422 cuando no encuentra ruta', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => respuestaJson({ code: 'NoRoute', routes: [] }, 400);
  await assert.rejects(
    obtenerRutaStadia({ lat: -16.49, lng: -68.12 }, { lat: -16.48, lng: -68.1 }),
    (e) => e.codigo === 'RUTA_NO_DISPONIBLE' && e.estadoHttp === 422,
  );
});

test('Stadia Routing identifica falta de autorización o plan', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => respuestaJson({ error: 'Forbidden' }, 403);
  await assert.rejects(
    obtenerRutaStadia({ lat: -16.49, lng: -68.12 }, { lat: -16.48, lng: -68.1 }),
    (e) => e.codigo === 'STADIA_RUTAS_NO_AUTORIZADAS' && e.estadoHttp === 502,
  );
});

test('Stadia normaliza resultados del autocompletado y envía la clave desde el servidor', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let llamada;
  globalThis.fetch = async (url) => {
    llamada = new URL(url);
    return respuestaJson({ features: [
      { properties: { label: 'Av. Arce, La Paz, Bolivia' }, geometry: { coordinates: [-68.12, -16.5] } },
      { properties: { name: 'Resultado sin coordenadas' }, geometry: { coordinates: [] } },
    ] });
  };
  const resultados = await buscarDireccionesStadia('Av Arce', -16.5, -68.12);
  assert.equal(llamada.hostname, 'api.stadiamaps.com');
  assert.equal(llamada.pathname, '/geocoding/v2/autocomplete');
  assert.equal(llamada.searchParams.get('api_key'), 'clave-ficticia-de-prueba');
  assert.equal(llamada.searchParams.get('boundary.country'), 'BO');
  assert.deepEqual(resultados, [{ texto: 'Av. Arce, La Paz, Bolivia', lat: -16.5, lng: -68.12 }]);
});

test('Stadia reverse geocoding y validación de consulta corta', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => respuestaJson({ features: [{ properties: { label: 'Zona Central, La Paz, Bolivia' }, geometry: { coordinates: [-68.13, -16.5] } }] });
  assert.equal(await buscarDireccionInversaStadia(-16.5, -68.13), 'Zona Central, La Paz, Bolivia');
  await assert.rejects(
    buscarDireccionesStadia('ab'),
    (e) => e.codigo === 'CONSULTA_INVALIDA' && e.estadoHttp === 422,
  );
});
