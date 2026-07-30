// /api/stripe-webhook.js
//
// Este es el "seguro de vida" del flujo de pago: Stripe llama a esta URL
// directamente desde SUS servidores (no desde el navegador del cliente)
// en cuanto un cobro se completa de verdad. Así, el pedido se marca como
// "pagado" en Firestore sin importar qué le pase al navegador del
// cliente después de pagar (que se cierre la pestaña, se vaya el
// internet, etc.) — antes, todo dependía de que el navegador del
// cliente terminara su trabajo, y si no lo hacía, el cliente quedaba
// cobrado sin ningún pedido registrado.
//
// CÓMO ACTIVARLO:
// 1) Sube este archivo a /api/stripe-webhook.js
// 2) Agrega "stripe" y "firebase-admin" a tu package.json (ver el archivo
//    que te dieron junto a este) y vuelve a desplegar.
// 3) En Vercel, agrega estas variables de entorno (aparte de las que ya
//    tenías):
//      STRIPE_WEBHOOK_SECRET = whsec_xxxxx  (te lo dio Stripe al crear el
//                               webhook en Dashboard > Developers > Webhooks)
//      FIREBASE_SERVICE_ACCOUNT_B64 = el archivo .json completo de cuenta
//                               de servicio de Firebase, codificado en
//                               Base64 (esto evita los errores de "llave
//                               privada mal pegada" que dan el típico
//                               error "DECODER routines::unsupported").
//      GMAIL_USER / GMAIL_APP_PASSWORD = las mismas que ya configuraste
//                               para send-status-email.js (se reutilizan
//                               aquí como respaldo, por si el correo desde
//                               el navegador del cliente nunca se mandó)
// 4) En Stripe Dashboard > Developers > Webhooks, confirma que el evento
//    "payment_intent.succeeded" esté marcado para este endpoint.
//
// IMPORTANTE: este archivo necesita el cuerpo (body) de la petición SIN
// procesar, para poder verificar la firma de Stripe — por eso existe el
// "export const config" de abajo, que le dice a Vercel que no lo
// convierta a JSON automáticamente como hace con los demás endpoints.

import Stripe from 'stripe';
import admin from 'firebase-admin';
import nodemailer from 'nodemailer';

export const config = {
  api: { bodyParser: false }
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

// Normaliza FIREBASE_PRIVATE_KEY sin importar cómo se haya pegado en Vercel
// (respaldo, por si no se configuró FIREBASE_SERVICE_ACCOUNT_B64):
function normalizeFirebasePrivateKey(raw){
  if(!raw) return raw;
  let key = raw.trim();
  if((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))){
    key = key.slice(1, -1);
  }
  if(key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  return key;
}

// MÉTODO PRINCIPAL: el archivo .json de cuenta de servicio completo,
// codificado en Base64 en una sola variable de entorno
// (FIREBASE_SERVICE_ACCOUNT_B64). Como nunca se pega/edita la llave a
// mano, es inmune a errores de copiado que rompen el formato PEM (el
// error "DECODER routines::unsupported" que daba antes).
function getServiceAccountCredentials(){
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if(b64){
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    return {
      projectId: json.project_id,
      clientEmail: json.client_email,
      privateKey: json.private_key
    };
  }
  // Respaldo: las 3 variables sueltas (método anterior)
  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: normalizeFirebasePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
  };
}

function getFirestore(){
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(getServiceAccountCredentials())
    });
  }
  return admin.firestore();
}

async function readRawBody(readable){
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

let cachedTransporter = null;
function getMailer(){
  if(cachedTransporter) return cachedTransporter;
  if(!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
  return cachedTransporter;
}

// Correo de respaldo — solo se manda si, por lo que sea, el navegador del
// cliente nunca alcanzó a mandar el suyo (ver checkeo de idempotencia abajo).
async function sendBackupConfirmationEmail(order){
  const mailer = getMailer();
  if(!mailer || !order.email) return;
  const greetingName = order.name ? order.name.split(' ')[0] : 'Hola';
  const html = `
    <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#0E0E10;">
      <h2 style="margin:0 0 16px;">ZAYDE</h2>
      <p>${greetingName}, tu pedido <b>${order.orderNum}</b> tiene una actualización:</p>
      <p style="font-size:18px; font-weight:700; margin:16px 0; padding:12px 16px; background:#F1F0EC; border-radius:6px;">
        ¡Pedido confirmado y pagado! ✅
      </p>
      <p>Puedes revisar el detalle completo de tu pedido en cualquier momento desde la sección "Rastrear pedido" en el sitio, usando tu número de pedido o teléfono.</p>
      <p style="color:#6B6D76; font-size:13px; margin-top:24px;">Gracias por tu compra en ZAYDE.</p>
    </div>
  `;
  try{
    await mailer.sendMail({
      from: `"ZAYDE" <${process.env.GMAIL_USER}>`,
      to: order.email,
      subject: `Tu pedido ${order.orderNum} — ¡Pedido confirmado y pagado! ✅`,
      html
    });
  }catch(e){ console.error('Webhook: no se pudo mandar el correo de respaldo:', e); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Método no permitido');
    return;
  }

  if(!process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY){
    console.error('Webhook: faltan STRIPE_WEBHOOK_SECRET o STRIPE_SECRET_KEY en Vercel.');
    res.status(500).send('Falta configuración del servidor.');
    return;
  }

  let event;
  try{
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  }catch(err){
    // Firma inválida: alguien (o algo) que no es Stripe de verdad está
    // llamando a esta URL — se rechaza, no se procesa nada.
    console.error('Webhook: firma inválida —', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try{
    if(event.type === 'payment_intent.succeeded'){
      const paymentIntent = event.data.object;
      const orderNum = paymentIntent.metadata && paymentIntent.metadata.orderNum;

      if(!orderNum){
        console.error('Webhook: el PaymentIntent', paymentIntent.id, 'no trae orderNum en metadata — no se puede confirmar ningún pedido.');
        res.status(200).json({ received: true, warning: 'sin orderNum' });
        return;
      }

      const db = getFirestore();
      const orderRef = db.collection('orders').doc(orderNum);
      const snap = await orderRef.get();

      if(!snap.exists){
        // No debería pasar casi nunca (el pedido se guarda como "pendiente"
        // ANTES de cobrar), pero por si acaso: se registra el error para
        // poder investigarlo manualmente en vez de perder el rastro del pago.
        console.error(`Webhook: no se encontró el pedido ${orderNum} en Firestore para el pago ${paymentIntent.id}.`);
        res.status(200).json({ received: true, warning: 'pedido no encontrado' });
        return;
      }

      const order = snap.data();

      // Idempotencia: Stripe puede reenviar el mismo evento más de una vez.
      // Si ya estaba marcado como pagado (porque el navegador del cliente sí
      // alcanzó a hacerlo), no se hace nada más — así nunca se manda un
      // correo de confirmación duplicado.
      if(order.paymentStatus !== 'pagado'){
        await orderRef.update({
          paymentStatus: 'pagado',
          stripePaymentIntentId: paymentIntent.id
        });
        await sendBackupConfirmationEmail({ ...order, stripePaymentIntentId: paymentIntent.id });
      }
    }

    res.status(200).json({ received: true });
  }catch(err){
    console.error('Webhook: error procesando el evento:', err);
    // 500 le dice a Stripe "algo salió mal, reinténtalo más tarde" —
    // Stripe reintenta automáticamente los webhooks que fallan.
    res.status(500).json({ error: 'Error procesando el webhook.' });
  }
}
