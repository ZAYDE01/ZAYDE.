// /api/_lib/rateLimit.js
// ============================================================
// Límite de peticiones por IP, usando Firestore como "contador" — así no
// hace falta contratar/configurar un servicio nuevo (Redis, Upstash, etc.):
// ya tienes Firestore conectado en todas tus funciones.
//
// Por qué hacía falta: sin esto, cualquier función pública (crear un pago,
// mandar un correo, publicar una reseña) podía ser llamada sin límite por
// un bot — para saturar tu cuenta de Gmail, generar cargos de prueba en
// Stripe, o llenar Firestore de basura. Vercel NO limita esto por ti.
//
// Nota sobre el costo: cada verificación hace 1 lectura + 1 escritura en
// Firestore. Con los límites de abajo (pocas peticiones por IP por
// ventana de tiempo) esto es una fracción mínima de la franja gratuita de
// Firestore — no vas a acercarte a un costo real por esto.
//
// USO en cualquier función:
//   const { checkRateLimit } = require('./_lib/rateLimit');
//   ...
//   const rl = await checkRateLimit(db, req, 'nombre-de-la-funcion', { windowMs: 10*60*1000, max: 10 });
//   if (!rl.allowed) {
//     res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
//     res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' });
//     return;
//   }
// ============================================================

function getClientIp(req) {
  // Vercel manda la IP real del visitante en x-forwarded-for (puede traer
  // varias separadas por coma si hubo proxies intermedios — la primera es
  // la del cliente original).
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Convierte una IP en un ID de documento válido para Firestore (no puede
// contener "/", y los dos puntos de IPv6 tampoco causan problema, pero los
// normalizamos para mantenerlo simple y legible en la consola).
function safeIpKey(ip) {
  return String(ip).replace(/[^a-zA-Z0-9.:_-]/g, '_').slice(0, 120);
}

/**
 * @param {FirebaseFirestore.Firestore} db - instancia ya inicializada (admin.firestore())
 * @param {import('http').IncomingMessage} req
 * @param {string} bucket - nombre de la función/acción (ej. 'submit-review')
 * @param {{windowMs:number, max:number}} opts - ventana de tiempo en ms y máximo de peticiones permitidas en esa ventana
 */
async function checkRateLimit(db, req, bucket, opts) {
  const { windowMs, max } = opts;
  const ip = safeIpKey(getClientIp(req));
  const key = `${bucket}__${ip}`;
  const ref = db.collection('rate_limits').doc(key);
  const now = Date.now();

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : null;

      if (!data || (now - data.windowStart) > windowMs) {
        // Ventana nueva (o la anterior ya expiró): reinicia el contador.
        tx.set(ref, { windowStart: now, count: 1, updatedAt: now });
        return { allowed: true, remaining: max - 1 };
      }

      if (data.count >= max) {
        return { allowed: false, retryAfterMs: windowMs - (now - data.windowStart) };
      }

      tx.set(ref, { windowStart: data.windowStart, count: data.count + 1, updatedAt: now });
      return { allowed: true, remaining: max - data.count - 1 };
    });
  } catch (e) {
    // Si Firestore falla por lo que sea, NO bloqueamos al usuario real por
    // un problema de infraestructura — dejamos pasar la petición. Es la
    // decisión correcta aquí: un rate limiter caído no debe tumbar el
    // checkout completo.
    console.error(`Rate limit (${bucket}): no se pudo verificar, se deja pasar la petición —`, e);
    return { allowed: true, remaining: null };
  }
}

module.exports = { checkRateLimit, getClientIp };
