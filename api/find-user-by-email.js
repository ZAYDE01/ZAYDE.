// /api/find-user-by-email.js
//
// [VENDEDORES] Dado un correo, devuelve el UID de la cuenta de Firebase que
// ya existe con ese correo. Lo usa la pestaña "Vendedores" del panel admin
// para convertir en vendedor a alguien que YA tiene cuenta en ZAYDE (por
// ejemplo, un cliente), sin crearle una cuenta nueva: así entra al portal
// /vendedor con la misma contraseña que ya usa en el sitio.
//
// SEGURIDAD: este endpoint revela si un correo tiene cuenta, así que solo
// responde a un administrador. Verifica (1) el token de Firebase que manda
// el panel y (2) que el UID de ese token tenga su documento en la colección
// "admins" — exactamente lo mismo que revisa isAdmin() en tus reglas de
// Firestore. A cualquier otra persona le responde 401 o 403.
//
// CÓMO ACTIVARLO: sube este archivo a /api/find-user-by-email.js y vuelve a
// desplegar. No necesita variables de entorno nuevas: usa las mismas de
// Firebase que ya tiene stripe-webhook.js (FIREBASE_SERVICE_ACCOUNT_B64).

import admin from 'firebase-admin';

function normalizeFirebasePrivateKey(raw){
  if(!raw) return raw;
  let key = raw.trim();
  if((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))){
    key = key.slice(1, -1);
  }
  if(key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  return key;
}

function getServiceAccountCredentials(){
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if(b64){
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    return { projectId: json.project_id, clientEmail: json.client_email, privateKey: json.private_key };
  }
  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: normalizeFirebasePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
  };
}

function initAdmin(){
  if(!admin.apps.length){
    admin.initializeApp({ credential: admin.credential.cert(getServiceAccountCredentials()) });
  }
}

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');

  if(req.method !== 'POST'){
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  try{
    initAdmin();

    // 1) ¿Quién pregunta? Token de Firebase en el encabezado Authorization.
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if(!token){ res.status(401).json({ error: 'no-token' }); return; }

    let decoded;
    try{ decoded = await admin.auth().verifyIdToken(token); }
    catch(e){ res.status(401).json({ error: 'invalid-token' }); return; }

    // 2) ¿Es administrador? Mismo criterio que isAdmin() en firestore.rules.
    const adminDoc = await admin.firestore().collection('admins').doc(decoded.uid).get();
    if(!adminDoc.exists){ res.status(403).json({ error: 'not-admin' }); return; }

    // 3) Buscar la cuenta por correo.
    let body = req.body;
    if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = {}; } }
    const email = String((body && body.email) || '').trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
      res.status(400).json({ error: 'invalid-email' });
      return;
    }

    try{
      const user = await admin.auth().getUserByEmail(email);
      res.status(200).json({ uid: user.uid });
    }catch(e){
      if(e && e.code === 'auth/user-not-found'){ res.status(404).json({ error: 'no-user' }); return; }
      throw e;
    }
  }catch(err){
    console.error('find-user-by-email: error inesperado:', err);
    res.status(500).json({ error: 'server-error' });
  }
}
