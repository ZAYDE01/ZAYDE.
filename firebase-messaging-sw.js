// Colócalo en la RAÍZ del sitio (junto a vendedor.html).
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js','https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');
firebase.initializeApp({
    apiKey: "AIzaSyAzSSYstPqksVnCdWIjmUe1qRqozyVjjgU",
    authDomain: "zayde-4ce71.firebaseapp.com",
    projectId: "zayde-4ce71",
    appId: "1:575273733541:web:2d06b61b077a044178ec4c"
  });
firebase.messaging().onBackgroundMessage(m => self.registration.showNotification((m.notification||{}).title||'ZAYDE',{body:(m.notification||{}).body||'',icon:'/icons/apple-touch-icon.png'}));
