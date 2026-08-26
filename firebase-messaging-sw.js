// firebase-messaging-sw.js
// Doit rester à la RACINE du site (même niveau que index.html) pour couvrir toute l'app.
// Ce fichier gère les notifications reçues quand l'onglet Yoonu n'est PAS au premier plan.

importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js");

// Même config que dans index.html
firebase.initializeApp({
  apiKey: "AIzaSyCU0GMylHCTFOE2AynS25bIJn260kqQtuQ",
  authDomain: "yoonu-senegal.firebaseapp.com",
  projectId: "yoonu-senegal",
  storageBucket: "yoonu-senegal.firebasestorage.app",
  messagingSenderId: "286129406157",
  appId: "1:286129406157:web:5d8835ce71499a9e67e984"
});

const messaging = firebase.messaging();

// Notification affichée quand l'app est en arrière-plan ou fermée
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'Yoonu';
  const options = {
    body: payload.notification?.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: payload.data || {},
    tag: payload.data?.tag || undefined
  };
  self.registration.showNotification(title, options);
});

// Clic sur la notification -> ouvre/focus l'app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
