// /api/sitemap.js
//
// Genera un sitemap.xml DINÁMICO: cada vez que Google (o quien sea) pide
// /sitemap.xml, esta función consulta tu catálogo real en Firestore y
// arma la lista de URLs al vuelo — así, cuando agregas un producto nuevo
// desde el panel admin, aparece solo en el sitemap la próxima vez que
// alguien lo pida, sin que tengas que editar ningún archivo a mano.
//
// CÓMO ACTIVARLO (2 pasos):
// 1) Sube este archivo a /api/sitemap.js (junto a tus otras funciones).
// 2) En tu vercel.json, agrega esta línea a "rewrites" (ANTES del
//    catch-all "/(.*)" -> "/index.html", el orden importa):
//      { "source": "/sitemap.xml", "destination": "/api/sitemap" }
//    Y BORRA el archivo estático /sitemap.xml de tu repo (si sigue ahí,
//    Vercel lo serviría a él primero y esta función nunca se ejecutaría).
//
// No necesita ninguna llave ni variable de entorno nueva: usa la misma
// lectura pública de Firestore que ya permiten tus reglas de seguridad
// para "admin_products" (allow read: if true), a través de la API REST
// de Firestore — por eso no hace falta el SDK de Firebase Admin aquí.

const FIREBASE_PROJECT_ID = 'zayde-4ce71';

function escapeXml(str){
  return String(str || '').replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));
}

function slugify(text){
  return (text || '').toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'producto';
}

// Convierte un valor con tipo de la API REST de Firestore a un valor JS plano.
function readField(fieldObj){
  if(!fieldObj) return undefined;
  if('stringValue' in fieldObj) return fieldObj.stringValue;
  if('integerValue' in fieldObj) return Number(fieldObj.integerValue);
  if('doubleValue' in fieldObj) return Number(fieldObj.doubleValue);
  if('timestampValue' in fieldObj) return fieldObj.timestampValue;
  return undefined;
}

async function fetchAllProducts(){
  const products = [];
  let pageToken = undefined;
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/admin_products`;

  do {
    const url = new URL(baseUrl);
    url.searchParams.set('pageSize', '300');
    if(pageToken) url.searchParams.set('pageToken', pageToken);

    const resp = await fetch(url.toString());
    if(!resp.ok) break;
    const data = await resp.json();

    (data.documents || []).forEach((doc) => {
      const f = doc.fields || {};
      const id = readField(f.id);
      const brand = readField(f.brand) || '';
      const name = readField(f.name) || '';
      const createdAt = readField(f.createdAt);
      if(id !== undefined){
        products.push({ id, slug: slugify(`${brand}-${name}`), createdAt });
      }
    });

    pageToken = data.nextPageToken;
  } while(pageToken);

  return products;
}

export default async function handler(req, res) {
  const host = req.headers.host || 'zayde-kappa.vercel.app';
  const origin = `https://${host}`;

  let products = [];
  try{
    products = await fetchAllProducts();
  }catch(err){
    console.error('No se pudo leer el catálogo de Firestore para el sitemap:', err);
    // Si Firestore falla, igual se manda un sitemap válido con solo las
    // páginas estáticas — mejor eso que un error 500 para Google.
  }

  const staticUrls = [
    { loc: '/', priority: '1.0', changefreq: 'daily' },
    { loc: '/catalogo', priority: '0.9', changefreq: 'daily' },
    { loc: '/favoritos', priority: '0.3', changefreq: 'weekly' },
    { loc: '/mayoreo', priority: '0.6', changefreq: 'weekly' },
    { loc: '/catalogo/ropa', priority: '0.7', changefreq: 'daily' },
    { loc: '/catalogo/perfumes', priority: '0.7', changefreq: 'daily' },
    { loc: '/catalogo/bolsos', priority: '0.7', changefreq: 'daily' },
    { loc: '/catalogo/lentes', priority: '0.7', changefreq: 'daily' },
    { loc: '/catalogo/relojes', priority: '0.7', changefreq: 'daily' },
    { loc: '/catalogo/sneakers', priority: '0.7', changefreq: 'daily' },
    { loc: '/catalogo/joyeria', priority: '0.7', changefreq: 'daily' }
  ];

  const urlEntries = [
    ...staticUrls.map(u => `  <url>
    <loc>${origin}${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`),
    ...products.map(p => {
      const lastmod = p.createdAt ? new Date(p.createdAt).toISOString().slice(0,10) : undefined;
      return `  <url>
    <loc>${escapeXml(`${origin}/producto/${p.id}-${p.slug}`)}</loc>
${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
    })
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries.join('\n')}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate'); // se recalcula cada hora como máximo, no en cada visita
  res.status(200).send(xml);
}
