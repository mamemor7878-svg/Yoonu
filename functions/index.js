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
  onDocumentDeleted,
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
  } else if (after.status === "trip_cancelled") {
    await sendPushToUser(
      after.passengerId,
      "Trajet annulé",
      `Le conducteur a annulé le trajet ${after.from || ""} → ${after.to || ""} du ${after.date || ""}.`,
      { type: "trip_cancelled", tripId: after.tripId || "" }
    );
  }
});

// ===== 2bis. Réservation annulée par le passager (suppression du document) -> notifie le conducteur =====
exports.onBookingCancelled = onDocumentDeleted("bookings/{bookingId}", async (event) => {
  const b = event.data.data();
  if (!b || !b.driverId) return;
  await sendPushToUser(
    b.driverId,
    "Réservation annulée",
    `${b.passengerPhone || "Le passager"} a annulé sa réservation pour ${b.from || ""} → ${b.to || ""}.`,
    { type: "booking_cancelled", tripId: b.tripId || "" }
  );
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

// ===== 4. Nouvelle proposition sur une demande passager -> notifie le passager =====
exports.onNewTripProposal = onDocumentCreated("proposals/{proposalId}", async (event) => {
  const p = event.data.data();
  if (!p || !p.requesterId) return;
  const tripSnap = await db.collection("trips").doc(p.tripId).get();
  const trip = tripSnap.exists ? tripSnap.data() : {};
  await sendPushToUser(
    p.requesterId,
    "Nouvelle proposition de conducteur",
    `${p.driverName || "Un conducteur"} propose de vous emmener sur ${trip.from || ""} → ${trip.to || ""}`,
    { type: "proposal_passager", tripId: p.tripId || "" }
  );
});

// ===== 5. Statut d'une proposition sur demande passager -> notifie le conducteur proposant (ou le passager en cas d'annulation) =====
exports.onTripProposalStatusChange = onDocumentUpdated("proposals/{proposalId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!after) return;
  if (before.status === after.status) return;

  const tripSnap = await db.collection("trips").doc(after.tripId).get();
  const trip = tripSnap.exists ? tripSnap.data() : {};

  if (after.status === "cancelled" && after.requesterId) {
    await sendPushToUser(
      after.requesterId,
      "Engagement annulé",
      `${after.driverName || "Un conducteur"} a annulé son engagement sur votre demande ${trip.from || ""} → ${trip.to || ""}. Votre annonce est à nouveau disponible.`,
      { type: "proposal_passager_cancelled", tripId: after.tripId || "" }
    );
    return;
  }

  if (!after.driverId) return;
  if (after.status !== "accepted" && after.status !== "refused") return;

  const title = after.status === "accepted" ? "Proposition acceptée !" : "Proposition refusée";
  const body =
    after.status === "accepted"
      ? `Votre proposition pour ${trip.from || ""} → ${trip.to || ""} a été acceptée`
      : `Votre proposition pour ${trip.from || ""} → ${trip.to || ""} n'a pas été retenue`;
  await sendPushToUser(after.driverId, title, body, {
    type: "proposal_passager_status",
    tripId: after.tripId || "",
  });
});

// ===== 6. Nouvelle proposition sur un colis -> notifie le propriétaire du colis =====
exports.onNewParcelProposal = onDocumentCreated("parcelProposals/{proposalId}", async (event) => {
  const p = event.data.data();
  if (!p || !p.requesterId) return;
  const parcelSnap = await db.collection("parcels").doc(p.parcelId).get();
  const parcel = parcelSnap.exists ? parcelSnap.data() : {};
  await sendPushToUser(
    p.requesterId,
    "Nouvelle proposition pour votre colis",
    `${p.driverName || "Un transporteur"} propose de prendre en charge votre colis ${parcel.from || ""} → ${parcel.to || ""}`,
    { type: "proposal_colis", parcelId: p.parcelId || "" }
  );
});

// ===== 7. Statut d'une proposition colis -> notifie le transporteur proposant (ou le propriétaire en cas d'annulation) =====
exports.onParcelProposalStatusChange = onDocumentUpdated("parcelProposals/{proposalId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!after) return;
  if (before.status === after.status) return;

  const parcelSnap = await db.collection("parcels").doc(after.parcelId).get();
  const parcel = parcelSnap.exists ? parcelSnap.data() : {};

  if (after.status === "cancelled" && after.requesterId) {
    await sendPushToUser(
      after.requesterId,
      "Engagement annulé",
      `${after.driverName || "Un transporteur"} a annulé son engagement sur votre colis ${parcel.from || ""} → ${parcel.to || ""}. Votre annonce est à nouveau disponible.`,
      { type: "proposal_colis_cancelled", parcelId: after.parcelId || "" }
    );
    return;
  }

  if (!after.driverId) return;
  if (after.status !== "accepted" && after.status !== "refused") return;

  const title = after.status === "accepted" ? "Proposition colis acceptée !" : "Proposition colis refusée";
  const body =
    after.status === "accepted"
      ? `Votre proposition pour le colis ${parcel.from || ""} → ${parcel.to || ""} a été acceptée`
      : `Votre proposition pour le colis ${parcel.from || ""} → ${parcel.to || ""} n'a pas été retenue`;
  await sendPushToUser(after.driverId, title, body, {
    type: "proposal_colis_status",
    parcelId: after.parcelId || "",
  });
});

// ===== 8. Nouvelle proposition sur une location -> notifie le propriétaire du véhicule =====
exports.onNewRentalProposal = onDocumentCreated("rentalProposals/{proposalId}", async (event) => {
  const p = event.data.data();
  if (!p || !p.requesterId) return;
  const rentalSnap = await db.collection("rentals").doc(p.rentalId).get();
  const rental = rentalSnap.exists ? rentalSnap.data() : {};
  const vehicleName = [rental.marque, rental.modele].filter(Boolean).join(" ") || "votre véhicule";
  await sendPushToUser(
    p.requesterId,
    "Nouvelle proposition pour votre annonce",
    `${p.driverName || "Quelqu'un"} est intéressé par ${vehicleName}`,
    { type: "proposal_location", rentalId: p.rentalId || "" }
  );
});

/**
 * Notifie les utilisateurs dont une alerte sauvegardée correspond à une nouvelle annonce.
 * Une alerte correspond si son départ ET sa destination sont contenus dans ceux de
 * l'annonce (comparaison souple, insensible à la casse). Une alerte sans départ ni
 * destination est ignorée, sinon elle capterait tout.
 * L'auteur de l'annonce n'est jamais notifié de sa propre publication.
 */
async function notifyMatchingAlerts(listing, { title, bodyFor, data }) {
  const from = (listing.from || "").toLowerCase().trim();
  const to = (listing.to || "").toLowerCase().trim();
  if (!from && !to) return;

  const ownerId = listing.driverId || listing.ownerId || "";
  const snap = await db.collection("savedSearches").get();

  const recipients = new Set();
  snap.forEach((d) => {
    const s = d.data();
    if (!s.userId || s.userId === ownerId) return;

    const sFrom = (s.from || "").toLowerCase().trim();
    const sTo = (s.to || "").toLowerCase().trim();
    if (!sFrom && !sTo) return; // alerte vide : on ne spamme pas

    const fromOk = !sFrom || from.includes(sFrom);
    const toOk = !sTo || to.includes(sTo);
    if (fromOk && toOk) recipients.add(s.userId);
  });

  if (recipients.size === 0) return;

  await Promise.all(
    [...recipients].map((uid) =>
      sendPushToUser(uid, title, bodyFor(listing), data)
    )
  );
}

// ===== 10. Nouveau trajet publié -> alerte les utilisateurs concernés =====
exports.onNewTripPublished = onDocumentCreated("trips/{tripId}", async (event) => {
  const t = event.data.data();
  if (!t) return;
  const isPassenger = (t.type || "conducteur") === "passager";
  await notifyMatchingAlerts(t, {
    title: isPassenger ? "Nouvelle demande de passager" : "Nouveau trajet disponible",
    bodyFor: (l) =>
      `${l.from || ""} → ${l.to || ""}` +
      (l.date ? ` le ${l.date}` : "") +
      (l.price ? ` · ${Number(l.price).toLocaleString("fr-FR")} FCFA` : ""),
    data: { type: "alert_trip", tripId: event.params.tripId },
  });
});

// ===== 11. Nouveau colis publié -> alerte les utilisateurs concernés =====
exports.onNewParcelPublished = onDocumentCreated("parcels/{parcelId}", async (event) => {
  const p = event.data.data();
  if (!p) return;
  const isGpOffer = p.scope === "gp" && p.type === "offre";
  await notifyMatchingAlerts(p, {
    title: isGpOffer ? "Nouveau GP disponible" : "Nouveau colis à transporter",
    bodyFor: (l) =>
      `${l.from || ""} → ${l.to || ""}` +
      (isGpOffer && l.flightDate ? ` · vol du ${l.flightDate}` : ""),
    data: { type: "alert_parcel", parcelId: event.params.parcelId },
  });
});

// ===== 12. Nouvelle location publiée -> alerte les utilisateurs concernés =====
// Les annonces de location n'ont pas de from/to mais une ville : on la mappe
// sur les deux champs pour réutiliser la même logique de correspondance.
exports.onNewRentalPublished = onDocumentCreated("rentals/{rentalId}", async (event) => {
  const r = event.data.data();
  if (!r || !r.ville) return;
  const vehicleName = [r.marque, r.modele].filter(Boolean).join(" ") || "Un véhicule";
  await notifyMatchingAlerts(
    { from: r.ville, to: r.ville, ownerId: r.ownerId },
    {
      title: "Nouveau véhicule à louer",
      bodyFor: () =>
        `${vehicleName} à ${r.ville}` +
        (r.price ? ` · ${Number(r.price).toLocaleString("fr-FR")} FCFA/jour` : ""),
      data: { type: "alert_rental", rentalId: event.params.rentalId },
    }
  );
});
exports.onRentalProposalStatusChange = onDocumentUpdated("rentalProposals/{proposalId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!after) return;
  if (before.status === after.status) return;

  const rentalSnap = await db.collection("rentals").doc(after.rentalId).get();
  const rental = rentalSnap.exists ? rentalSnap.data() : {};
  const vehicleName = [rental.marque, rental.modele].filter(Boolean).join(" ") || "le véhicule";

  if (after.status === "cancelled" && after.requesterId) {
    await sendPushToUser(
      after.requesterId,
      "Engagement annulé",
      `${after.driverName || "Un utilisateur"} a annulé son engagement pour ${vehicleName}. Votre annonce est à nouveau disponible.`,
      { type: "proposal_location_cancelled", rentalId: after.rentalId || "" }
    );
    return;
  }

  if (!after.driverId) return;
  if (after.status !== "accepted" && after.status !== "refused") return;

  const title = after.status === "accepted" ? "Proposition location acceptée !" : "Proposition location refusée";
  const body =
    after.status === "accepted"
      ? `Votre proposition pour ${vehicleName} a été acceptée`
      : `Votre proposition pour ${vehicleName} n'a pas été retenue`;
  await sendPushToUser(after.driverId, title, body, {
    type: "proposal_location_status",
    rentalId: after.rentalId || "",
  });
});
