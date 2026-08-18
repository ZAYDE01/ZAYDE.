// /api/submit-review.js
// ============================================================
// Recibe una reseña desde el sitio, la valida, checa "compra verificada"
// comparando contra la colección `orders` de Firestore (con el SDK de
// Admin, que tiene acceso completo y nunca corre en el navegador), y
// guarda la reseña ya en Firestore con Timestamp del servidor.
//
// Por qué existe esta función en vez de escribir directo desde el
// navegador a Firestore:
//   1) El navegador NUNCA debe poder leer todos los pedidos (nombre,
//      teléfono, dirección de cada cliente) solo para comparar un
//      teléfono — eso es lo que hacía el código anterior.
//   2) Si el navegador escribiera directo a Firestore, nada evitaría que
//      alguien mandara verifiedPurchase:true sin haber comprado nada.
//      Al forzar que TODA escritura de reseñas pase por aquí (con
//      firestore.rules negando "create" público en /reviews), la
//      bandera de compra verificada solo la puede poner este servidor.
//
// Variables de entorno requeridas (ya las tienes configuradas en Vercel):
//   FIREBASE_SERVICE_ACCOUNT_B64  (opción A, recomendada)
//   — o, si no usas la anterior —
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY (opción B)
// ============================================================

const admin = require('firebase-admin');
const crypto = require('crypto');
const { checkRateLimit } = require('./_lib/rateLimit');

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;

  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    const json = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
    );
    credential = admin.credential.cert(json);
  } else {
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Las variables de entorno de Vercel guardan \n como texto literal;
      // hay que convertirlo a salto de línea real para que la llave sea válida.
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    });
  }

  admin.initializeApp({ credential });
  return admin;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// [FIX PRIVACIDAD] La colección "reviews" es de lectura pública (así debe
// ser, para que cualquiera vea las reseñas). Guardar el teléfono normalizado
// en texto plano ahí — aunque fuera solo para detectar duplicados — dejaba
// el número real de cada comprador verificado visible para cualquiera que
// listara las reseñas. Este hash no se puede revertir al número original,
// pero el mismo teléfono siempre produce el mismo hash, así que la
// detección de "ya dejaste una reseña verificada" sigue funcionando igual.
function hashPhone(normalizedPhone) {
  return crypto.createHash('sha256').update(normalizedPhone).digest('hex');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Método no permitido' });
    return;
  }

  try {
    const fb = getFirebaseAdmin();
    const db = fb.firestore();

    // [NUEVO] Máximo 5 reseñas por IP cada hora — sin esto, alguien podía
    // publicar reseñas falsas sin límite (buenas o malas, propias o de la
    // competencia) para inflar o hundir la reputación de un producto.
    const rl = await checkRateLimit(db, req, 'submit-review', { windowMs: 60 * 60 * 1000, max: 5 });
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      res.status(429).json({ success: false, error: 'Demasiadas reseñas desde esta conexión. Intenta de nuevo más tarde.' });
      return;
    }

    const { productId, name, text, stars, images, phone } = req.body || {};

    // ---- Validación básica de la reseña ----
    const cleanName = String(name || '').trim().slice(0, 40);
    const cleanText = String(text || '').trim().slice(0, 500);
    const cleanStars = Number(stars);
    const cleanImages = Array.isArray(images) ? images.slice(0, 6) : [];
    const cleanProductId = String(productId || '').trim();

    if (!cleanProductId || !cleanName || !cleanText) {
      res.status(400).json({ success: false, error: 'Faltan campos requeridos.' });
      return;
    }
    if (!(cleanStars >= 1 && cleanStars <= 5)) {
      res.status(400).json({ success: false, error: 'Calificación inválida.' });
      return;
    }

    // ---- Compra verificada: SOLO se calcula aquí, nunca la manda el cliente ----
    let verifiedPurchase = false;
    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone) {
      // Nota: si tienes muchos pedidos, conviene guardar el teléfono
      // normalizado en un campo indexado (ej. phoneNormalized) al crear el
      // pedido, y filtrar aquí con .where('phoneNormalized','==', normalizedPhone)
      // en vez de traer varios documentos y comparar en memoria.
      const snap = await db.collection('orders')
        .orderBy('date', 'desc')
        .limit(500)
        .get();
      verifiedPurchase = snap.docs.some(doc => {
        const o = doc.data();
        const orderPhone = normalizePhone(o.phone);
        return orderPhone === normalizedPhone &&
          Array.isArray(o.items) &&
          o.items.some(it => String(it.id) === cleanProductId);
      });
    }

    // [NUEVO] Una sola reseña verificada por comprador y producto — sin
    // esto, el mismo comprador real podía mandar varias reseñas del mismo
    // producto (hasta 5 por hora, por el rate limit de arriba) e inflar o
    // hundir el promedio de estrellas. Guardamos internamente un
    // "phoneKey" (nunca se muestra públicamente, igual que el teléfono)
    // solo para poder detectar este caso — no es el teléfono en texto
    // plano, es el mismo valor normalizado que ya se usa para verificar.
    if (verifiedPurchase) {
      const dupSnap = await db.collection('reviews')
        .where('productId', '==', cleanProductId)
        .where('phoneKey', '==', hashPhone(normalizedPhone))
        .limit(1)
        .get();
      if (!dupSnap.empty) {
        res.status(409).json({ success: false, error: 'Ya dejaste una reseña verificada para este producto.' });
        return;
      }
    }

    // ---- Guarda la reseña ----
    await db.collection('reviews').add({
      productId: cleanProductId,
      name: cleanName,
      text: cleanText,
      stars: cleanStars,
      images: cleanImages,
      verifiedPurchase,
      phoneKey: verifiedPurchase ? hashPhone(normalizedPhone) : null,
      date: Date.now(),
      createdAt: fb.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ success: true, verified: verifiedPurchase });
  } catch (err) {
    console.error('Error en /api/submit-review:', err);
    res.status(500).json({ success: false, error: 'No se pudo guardar la reseña. Intenta de nuevo.' });
  }
};
