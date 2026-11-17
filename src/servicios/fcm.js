import crypto from 'node:crypto';
import { db } from '../db.js';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
let accessTokenCache = { token: null, expiresAt: 0 };
let advertidoSinConfig = false;

function b64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

function leerCredencial() {
  const raw = (process.env.FCM_SERVICE_ACCOUNT_JSON ?? '').trim();
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    if (!json.project_id || !json.client_email || !json.private_key) throw new Error('faltan project_id, client_email o private_key');
    return { ...json, private_key: String(json.private_key).replace(/\\n/g, '\n') };
  } catch (e) {
    console.error('[FCM] FCM_SERVICE_ACCOUNT_JSON no es un JSON válido:', e.message);
    return null;
  }
}

async function obtenerAccessToken(credencial) {
  if (accessTokenCache.token && accessTokenCache.expiresAt > Date.now() + 60_000) return accessTokenCache.token;
  const ahora = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({ iss: credencial.client_email, scope: SCOPE, aud: TOKEN_URL, iat: ahora, exp: ahora + 3600 });
  const unsigned = `${header}.${claims}`;
  const firma = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credencial.private_key).toString('base64url');
  const assertion = `${unsigned}.${firma}`;
  const respuesta = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(12_000),
  });
  const json = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok || !json.access_token) throw new Error(`OAuth Google ${respuesta.status}: ${json.error_description ?? json.error ?? 'no se obtuvo access_token'}`);
  accessTokenCache = { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000 };
  return accessTokenCache.token;
}

/** Envía un mensaje visible a todos los dispositivos registrados de los usuarios. Nunca bloquea una operación de negocio. */
export async function enviarPushAUsuarios(usuarioIds, { titulo, cuerpo, data = {} }) {
  const ids = [...new Set((usuarioIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return { enviados: 0, omitidos: 0 };
  const credencial = leerCredencial();
  if (!credencial) {
    if (!advertidoSinConfig) {
      console.warn('[FCM] Notificaciones push desactivadas: configura FCM_SERVICE_ACCOUNT_JSON en Railway. Socket.IO sigue funcionando con la app abierta.');
      advertidoSinConfig = true;
    }
    return { enviados: 0, omitidos: ids.length };
  }

  const [filas] = await db.execute(
    `SELECT id, token FROM notificaciones_dispositivos WHERE usuario_id IN (${ids.map(() => '?').join(',')})`, ids,
  );
  if (!filas.length) return { enviados: 0, omitidos: ids.length };
  const token = await obtenerAccessToken(credencial);
  const projectId = (process.env.FCM_PROJECT_ID || credencial.project_id).trim();
  const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
  let enviados = 0;
  const borrar = [];
  for (const dispositivo of filas) {
    const payloadData = Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k), String(v ?? '')]));
    try {
      const respuesta = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          message: {
            token: dispositivo.token,
            notification: { title: String(titulo).slice(0, 100), body: String(cuerpo).slice(0, 240) },
            data: payloadData,
            android: { priority: 'HIGH', notification: { channel_id: 'devolada_operaciones', sound: 'default' } },
          },
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const json = await respuesta.json().catch(() => ({}));
      if (respuesta.ok) enviados += 1;
      else {
        const detalle = JSON.stringify(json.error ?? json).slice(0, 500);
        console.warn(`[FCM] No se pudo enviar al dispositivo ${dispositivo.id}: HTTP ${respuesta.status} ${detalle}`);
        const codigo = `${json.error?.details?.[0]?.errorCode ?? ''} ${json.error?.status ?? ''}`;
        if (/UNREGISTERED|INVALID_ARGUMENT/.test(codigo) && /UNREGISTERED/.test(codigo)) borrar.push(Number(dispositivo.id));
      }
    } catch (e) {
      console.warn('[FCM] Error de red al enviar push:', e.message);
    }
  }
  if (borrar.length) {
    await db.execute(`DELETE FROM notificaciones_dispositivos WHERE id IN (${borrar.map(() => '?').join(',')})`, borrar).catch(() => {});
  }
  return { enviados, omitidos: Math.max(0, filas.length - enviados) };
}

export function enviarPushNoBloqueante(usuarioIds, payload) {
  enviarPushAUsuarios(usuarioIds, payload).catch((e) => console.error('[FCM] Error no bloqueante:', e.message));
}
