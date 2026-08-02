// /api/admin-upload-image.js
// ============================================================
// Sube fotos de PRODUCTO o de EXPERIENCIAS a Cloudinary usando la llave
// privada (API secret) — que nunca debe estar en el navegador. Antes de
// subir nada, verifica que quien llama de verdad inició sesión como admin
// en Firebase Auth (el mismo login del panel).
//
// Por qué existe este endpoint en vez de subir directo a Cloudinary desde
// el navegador con un "upload preset unsigned": un preset sin firmar es
// público para cualquiera que vea el código fuente del sitio, sin
// importar si tiene la contraseña del panel o no. Las fotos de reseña sí
// usan ese camino público a propósito (cualquiera puede reseñar sin
// cuenta), pero el catálogo de productos no debería poder ser alterado
// por cualquiera con las herramientas de desarrollador.
//
// Variables de entorno requeridas (Vercel):
//   FIREBASE_SERVICE_ACCOUNT_B64 (o FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY)
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
// ============================================================

const admin = require('firebase-admin');
const crypto = require('crypto');
const { checkRateLimit } = require('./_lib/rateLimit');

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    const json = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
    credential = admin.credential.cert(json);
  } else {
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    });
  }
  admin.initializeApp({ credential });
  return admin;
}

// Firma la subida a Cloudinary a mano (sin necesitar el SDK oficial de Cloudinary
// como dependencia) siguiendo el esquema de firma que ellos documentan:
// sha1(param1=valor1&param2=valor2...&API_SECRET), ordenando los parámetros alfabéticamente.
function signCloudinaryParams(params, apiSecret) {
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

const ALLOWED_FOLDERS = ['products', 'experiences'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Método no permitido' });
    return;
  }

  try {
    // ---- 1) Verificar que quien llama es tu admin autenticado ----
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).json({ success: false, error: 'Falta autenticación.' });
      return;
    }

    const fb = getFirebaseAdmin();
    let decoded;
    try {
      decoded = await fb.auth().verifyIdToken(idToken);
    } catch (e) {
      res.status(401).json({ success: false, error: 'Sesión inválida o expirada.' });
      return;
    }

    const adminDoc = await fb.firestore().collection('admins').doc(decoded.uid).get();
    if (!adminDoc.exists) {
      res.status(403).json({ success: false, error: 'Esta cuenta no tiene permisos de administrador.' });
      return;
    }

    // [NUEVO] Aunque ya está protegido por sesión de admin, un límite
    // ligero evita que una sesión comprometida (o un error en un script)
    // suba cientos de imágenes de golpe y agote tu cuota de Cloudinary.
    const rl = await checkRateLimit(fb.firestore(), req, 'admin-upload-image', { windowMs: 10 * 60 * 1000, max: 40 });
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      res.status(429).json({ success: false, error: 'Demasiadas subidas seguidas. Espera unos minutos.' });
      return;
    }

    // ---- 2) Validar entrada ----
    const { folder, image } = req.body || {};
    if (!ALLOWED_FOLDERS.includes(folder)) {
      res.status(400).json({ success: false, error: 'Carpeta no permitida.' });
      return;
    }
    if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
      res.status(400).json({ success: false, error: 'Imagen inválida.' });
      return;
    }
    // ~3MB de archivo original ya vienen validados en el navegador; aquí un
    // segundo tope de sanidad sobre el string base64 completo (~4MB tras codificar).
    if (image.length > 4.5 * 1024 * 1024) {
      res.status(400).json({ success: false, error: 'La imagen es demasiado pesada.' });
      return;
    }

    // ---- 3) Subir a Cloudinary con upload firmado (llave privada) ----
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
      res.status(500).json({ success: false, error: 'Cloudinary no está configurado en el servidor.' });
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = { folder: `zayde/${folder}`, timestamp };
    const signature = signCloudinaryParams(paramsToSign, apiSecret);

    const form = new URLSearchParams();
    form.append('file', image);
    form.append('folder', `zayde/${folder}`);
    form.append('timestamp', String(timestamp));
    form.append('api_key', apiKey);
    form.append('signature', signature);

    const uploadResp = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: 'POST',
      body: form,
    });
    const uploadData = await uploadResp.json();
    if (!uploadResp.ok || !uploadData.secure_url) {
      console.error('Error de Cloudinary:', uploadData);
      res.status(502).json({ success: false, error: 'No se pudo subir la imagen a Cloudinary.' });
      return;
    }

    res.status(200).json({ success: true, url: uploadData.secure_url });
  } catch (err) {
    console.error('Error en /api/admin-upload-image:', err);
    res.status(500).json({ success: false, error: 'Error interno al subir la imagen.' });
  }
};
