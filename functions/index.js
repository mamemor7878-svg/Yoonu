/**
 * Cloud Functions Yoonu — envoi des notifications push (FCM)
 *
 * Ces fonctions se déclenchent automatiquement sur des événements Firestore
 * et envoient une notification push aux utilisateurs concernés, via les
 * tokens stockés côté client dans users/{uid}.fcmTokens (voir index.html).
 */

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

// Région la plus proche du Sénégal : Belgique (europe-west1)
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

/**
 * Envoie une notification push à un utilisateur (tous ses appareils),
 * puis nettoie les tokens devenus invalides.
 */
async function sendPushToUser(uid, title, body, data = {}) {
  if (!uid) return;
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return;

  const tokensObj = userSnap.data().fcmTokens || {};
  const tokens = Object.keys(tokensObj);
  if (tokens.length === 0) return;

  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data,
    webpush: {
      fcmOptions: { link: "/" },
    },
  });

  // Retire les tokens invalides / désinscrits pour garder Firestore propre
  const invalidTokens = [];
  response.responses.forEach((res, idx) => {
    if (!res.success) {
      const code = res.error && res.error.code;
      if (
        code === "messaging/invalid-registration-token" ||
        code === "messaging/registration-token-not-registered"
      ) {
        invalidTokens.push(tokens[idx]);
      }
    }
  });
  if (invalidTokens.length > 0) {
    const updates = {};
    invalidTokens.forEach((t) => {
      updates[`fcmTokens.${t}`] = FieldValue.delete();
    });
    await userRef.update(updates);
  }
}

// ===== 1. Nouvelle réservation -> notifie le conducteur =====
exports.onNewBooking = onDocumentCreated("bookings/{bookingId}", async (event) => {
  const b = event.data.data();
  if (!b || !b.driverId) return;
  await sendPushToUser(
    b.driverId,
    "Nouvelle réservation",
    `${b.passengerPhone || "Un passager"} a réservé votre trajet ${b.from || ""} → ${b.to || ""}`,
    { type: "booking", tripId: b.tripId || "" }
  );
});

// ===== 2. Réservation acceptée/refusée -> notifie le passager =====
exports.onBookingStatusChange = onDocumentUpdated("bookings/{bookingId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!after || !after.passengerId) return;
  if (before.status === after.status) return;

  if (after.status === "accepted") {
    await sendPushToUser(
      after.passengerId,
      "Réservation acceptée !",
      `Votre place pour ${after.from || ""} → ${after.to || ""} le ${after.date || ""} a été acceptée. Bon voyage !`,
      { type: "accepted", tripId: after.tripId || "" }
    );
  } else if (after.status === "refused") {
    await sendPushToUser(
      after.passengerId,
      "Réservation refusée",
      `Le conducteur a refusé votre demande pour ${after.from || ""} → ${after.to || ""}.`,
      { type: "refused", tripId: after.tripId || "" }
    );
  }
});

// ===== 3. Nouveau message -> notifie l'autre personne de la conversation =====
exports.onNewMessage = onDocumentCreated(
  "chats/{chatId}/messages/{messageId}",
  async (event) => {
    const msg = event.data.data();
    const { chatId } = event.params;
    if (!msg || !msg.senderId) return;

    const chatSnap = await db.collection("chats").doc(chatId).get();
    if (!chatSnap.exists) return;
    const chat = chatSnap.data();
    const participants = chat.participants || [];
    const recipientId = participants.find((p) => p !== msg.senderId);
    if (!recipientId) return;

    const senderName =
      msg.senderName || (chat.names && chat.names[msg.senderId]) || "Un utilisateur";
    const preview = (msg.text || "").slice(0, 80);

    await sendPushToUser(recipientId, senderName, preview, { type: "message", chatId });
  }
);
