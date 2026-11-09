import { Router } from 'express';
import { db } from '../db.js';
import { ok, error } from '../respuesta.js';
import { autenticar } from '../middleware/autenticar.js';
import { desconectarSesion } from '../tiempoReal.js';
import { borrarDocumento } from '../servicios/almacenamiento.js';

export const rutaCuenta = Router();

/**
 * Ejecuta una sentencia opcional: si la tabla/columna no existe en esta instalación,
 * se registra y se continúa (en MySQL un error de sentencia no aborta la transacción).
 */
async function opcional(cx, sql, params) {
  try {
    await cx.execute(sql, params);
  } catch (e) {
    console.warn('[De Volada] Eliminación de cuenta: sentencia opcional omitida:', e.code ?? e.message);
  }
}

// DELETE /cuenta  (requerido por Google Play: el usuario elimina su cuenta desde la app)
// Anonimiza los datos personales, borra documentos de identidad, revoca todas las sesiones
// y desconecta el tiempo real. Los registros de viajes/pedidos/envíos y movimientos de puntos
// se conservan sin datos personales por obligaciones contables y de seguridad.
// Cuerpo opcional: { confirmacion: "ELIMINAR" }
rutaCuenta.delete('/', autenticar, async (req, res) => {
  const confirmacion = String(req.body?.confirmacion ?? 'ELIMINAR').trim().toUpperCase();
  if (confirmacion !== 'ELIMINAR') {
    return error(res, 422, 'CONFIRMACION_REQUERIDA', 'Escribe ELIMINAR para confirmar la eliminación de tu cuenta.');
  }
  const usuarioId = req.usuario.id;
  if (req.usuario.rol === 'admin') {
    return error(res, 403, 'NO_PERMITIDO', 'Las cuentas de administrador se eliminan desde el servidor.');
  }

  // No se elimina una cuenta con un servicio en curso: primero hay que terminarlo o cancelarlo.
  const [activos] = await db.execute(
    `SELECT v.id FROM viajes v LEFT JOIN conductores c ON c.id = v.conductor_id
      WHERE (v.pasajero_id = ? OR c.usuario_id = ?)
        AND v.estado IN ('solicitado','aceptado','conductor_llego','en_curso')
     UNION ALL
     SELECT p.id FROM pedidos p LEFT JOIN conductores c ON c.id = p.conductor_id
      WHERE (p.pasajero_id = ? OR c.usuario_id = ?)
        AND p.estado IN ('creado','aceptado_comercio','buscando_repartidor','asignado','recogido','en_camino')
     UNION ALL
     SELECT e.id FROM envios e LEFT JOIN conductores c ON c.id = e.conductor_id
      WHERE (e.remitente_id = ? OR c.usuario_id = ?)
        AND e.estado IN ('solicitado','asignado','recogido','en_camino','en_punto_entrega')
     LIMIT 1`,
    [usuarioId, usuarioId, usuarioId, usuarioId, usuarioId, usuarioId],
  );
  if (activos[0]) {
    return error(res, 409, 'SERVICIO_EN_CURSO', 'Tienes un viaje, pedido o envío en curso. Termínalo o cancélalo antes de eliminar tu cuenta.');
  }

  const conexion = await db.getConnection();
  let documentos = [];
  let sesiones = [];
  try {
    await conexion.beginTransaction();

    const [ses] = await conexion.execute(
      'SELECT id FROM sesiones WHERE usuario_id = ? AND revocada_en IS NULL',
      [usuarioId],
    );
    sesiones = ses.map((s) => s.id);

    const [cond] = await conexion.execute('SELECT id FROM conductores WHERE usuario_id = ?', [usuarioId]);
    const conductorId = cond[0]?.id ?? null;
    if (conductorId) {
      const [docs] = await conexion.execute(
        'SELECT archivo_ruta FROM documentos_conductor WHERE conductor_id = ?',
        [conductorId],
      );
      documentos = docs.map((d) => d.archivo_ruta).filter(Boolean);
      await conexion.execute('DELETE FROM documentos_conductor WHERE conductor_id = ?', [conductorId]);
      await opcional(conexion, 'DELETE FROM conductor_ubicacion WHERE conductor_id = ?', [conductorId]);
      await opcional(conexion, "UPDATE conductores SET estado_operativo = 'offline' WHERE id = ?", [conductorId]);
      await opcional(conexion, 'UPDATE conductores SET documento_identidad = NULL, qr_pago_url = NULL WHERE id = ?', [conductorId]);
      await opcional(conexion, "UPDATE motos SET placa = 'ELIMINADA' WHERE conductor_id = ?", [conductorId]);
    }

    // Comercio: se suspende y se quitan los datos de contacto.
    await opcional(
      conexion,
      "UPDATE empresas SET estado_aprobacion = 'suspendido', telefono_contacto = NULL, nit = NULL, razon_social = NULL WHERE usuario_id = ?",
      [usuarioId],
    );

    // Datos personales del usuario: valores únicos y no identificables.
    await conexion.execute(
      `UPDATE usuarios
          SET telefono = ?, nombre = 'Usuario', apellido = 'eliminado', estado = 'eliminado'
        WHERE id = ?`,
      [`X${usuarioId}`.slice(0, 20), usuarioId],
    );
    await opcional(conexion, 'UPDATE usuarios SET email = ? WHERE id = ?', [`eliminado-${usuarioId}@devolada.invalid`, usuarioId]);
    await opcional(conexion, 'UPDATE usuarios SET fecha_nacimiento = NULL, sexo = NULL WHERE id = ?', [usuarioId]);
    await opcional(conexion, 'UPDATE usuarios SET fcm_token = NULL, ip_registro = NULL WHERE id = ?', [usuarioId]);
    await opcional(conexion, 'UPDATE usuarios SET telefono_verificado = 0 WHERE id = ?', [usuarioId]);
    await opcional(conexion, 'UPDATE usuarios SET eliminado_en = UTC_TIMESTAMP() WHERE id = ?', [usuarioId]);

    await conexion.execute(
      'UPDATE sesiones SET revocada_en = UTC_TIMESTAMP() WHERE usuario_id = ? AND revocada_en IS NULL',
      [usuarioId],
    );
    await conexion.commit();
  } catch (e) {
    await conexion.rollback().catch(() => {});
    throw e;
  } finally {
    conexion.release();
  }

  // Fuera de la transacción: archivos y sockets (no deben bloquear la respuesta si fallan).
  await Promise.all(documentos.map(borrarDocumento));
  for (const id of sesiones) desconectarSesion(id);

  return ok(res, { mensaje: 'Tu cuenta y tus datos personales fueron eliminados.' });
});
