const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const mqtt = require("mqtt");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

// Konfigurasi broker MQTT (pakai broker publik emqx)
const MQTT_BROKER = "mqtt://broker.emqx.io";

// Topic MQTT untuk publish/subscribe
const TOPIC_LOCATION = "motor/location";
const TOPIC_SYSTEM = "motor/system";
const TOPIC_ALARM = "motor/alarm";
const TOPIC_CAMERA = "motor/camera";

const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors());
app.use(bodyParser.json());

let safeZoneCenter = null; // zona aman{ lat, lon }
const SAFE_RADIUS = 20; // meter, radius zona aman

// ====== CONFIG TELEGRAM ======
const axios = require("axios");

const TELEGRAM_BOT_TOKEN = "8159523908:AAH5u34kRwm0F9kttMGj2K1C2f712z8BDf4";
const TELEGRAM_CHAT_ID = "1771619682";

async function sendTelegram(message) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }
    );
    console.log("✅ Telegram terkirim:", message);
  } catch (err) {
    console.error("❌ Gagal kirim Telegram:", err.message);
  }
}

// ----- Firebase Admin (FCM) -----
let hasFirebase = false;
try {
  const serviceAccount = require("./serviceAccountKey.json");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  hasFirebase = true;
  console.log("✅ Firebase admin initialized (FCM available)");
} catch (e) {
  console.warn(
    "⚠️ Firebase serviceAccountKey.json not found - FCM disabled until configured."
  );
}

// ----- CSV Logging -----
// Simpan waktu terakhir log
let lastLogTime = 0;
const logFile = path.join(__dirname, "gps_log.csv");
if (!fs.existsSync(logFile)) {
  fs.writeFileSync(
    logFile,
    "waktu,lat_raw,lon_raw,lat_kalman,lon_kalman,statusZona\n"
  );
}

function getDistanceMeter(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function logGPSData() {
  const now = Date.now();
  // Catat hanya jika sudah lewat 30 detik dari log terakhir
  if (now - lastLogTime >= 30000) {
    lastLogTime = now;
    const csvLine = `${latestData.waktu},${latestData.lat_raw},${latestData.lon_raw},${latestData.lat_kalman},${latestData.lon_kalman},${latestData.statusZona}\n`;
    fs.appendFile(logFile, csvLine, (err) => {
      if (err) console.error("❌ CSV append error", err);
    });
  }
}

// ----- State -----
let latestData = {
  lat_raw: null,
  lon_raw: null,
  lat_kalman: null,
  lon_kalman: null,
  statusZona: "Tidak Diketahui",
  waktu: null,
};
let latestSystemStatus = false;
let latestAlarmStatus = false; // default off

// SSE clients
let sseClients = [];
function broadcastEvent(name, data) {
  const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res) => res.write(payload));
}

// ----- MQTT Client -----
const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on("connect", () => {
  console.log("✅ Connected to MQTT broker:", MQTT_BROKER);

  // Subscribe ke semua topik
  mqttClient.subscribe(TOPIC_LOCATION);
  mqttClient.subscribe(TOPIC_SYSTEM);
  mqttClient.subscribe(TOPIC_ALARM);
  mqttClient.subscribe(TOPIC_CAMERA);
  // Set default: sistem off saat awal
  mqttClient.publish(TOPIC_SYSTEM, JSON.stringify({ active: false }));
});

let prevStatusZona = "Tidak Diketahui";

// Handle pesan masuk dari MQTT
mqttClient.on("message", (topic, message) => {
  const msg = message.toString();
  console.log(`📥 [MQTT] ${topic}:`, msg);

  // ---- 1. Pesan lokasi GPS ----
  if (topic === TOPIC_LOCATION) {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (e) {
      console.error("❌ Invalid JSON from LOCATION topic", e);
      return;
    }

    // Ambil data posisi
    const latRaw = parseFloat(data.lat_raw ?? data.latitude ?? null);
    const lonRaw = parseFloat(data.lon_raw ?? data.longitude ?? null);
    const latKal = parseFloat(data.lat_kalman ?? null);
    const lonKal = parseFloat(data.lon_kalman ?? null);

    // Update state
    latestData = {
      lat_raw: isNaN(latRaw) ? null : latRaw,
      lon_raw: isNaN(lonRaw) ? null : lonRaw,
      lat_kalman: isNaN(latKal) ? null : latKal,
      lon_kalman: isNaN(lonKal) ? null : lonKal,
      waktu: data.waktu || new Date().toISOString(),
      statusZona: "Tidak Diketahui",
    };

    // Hitung jarak dan status zona
    if (
      safeZoneCenter &&
      latestSystemStatus &&
      latestData.lat_kalman !== null &&
      latestData.lon_kalman !== null
    ) {
      const dist = getDistanceMeter(
        safeZoneCenter.lat,
        safeZoneCenter.lon,
        latestData.lat_kalman,
        latestData.lon_kalman
      );
      if (dist <= SAFE_RADIUS) {
        latestData.statusZona = "Aman";
      } else {
        latestData.statusZona = "Bahaya";
      }
    }

    logGPSData();
    broadcastEvent("location", latestData);

    // Jika status berubah ke Bahaya
    if (prevStatusZona !== "Bahaya" && latestData.statusZona === "Bahaya") {
      // 🚨 Nyalakan alarm via MQTT
      mqttClient.publish(TOPIC_ALARM, JSON.stringify({ on: true }), () => {
        console.log("✅ Alarm ON dipublish ke MQTT (keluar zona)");
      });
      latestAlarmStatus = true;
      broadcastEvent("alarm", { on: latestAlarmStatus });

      // Kirim FCM kalau Firebase ada
      if (hasFirebase) {
        admin
          .messaging()
          .send({
            notification: {
              title: "🚨 Motor keluar zona!",
              body: `Motor berada di ${
                latestData.lat_kalman || latestData.lat_raw
              }, ${latestData.lon_kalman || latestData.lon_raw}`,
            },
            topic: "motor_alerts",
            data: {
              lat: String(latestData.lat_kalman || latestData.lat_raw || ""),
              lon: String(latestData.lon_kalman || latestData.lon_raw || ""),
            },
          })
          .then((resp) => console.log("📣 FCM sent:", resp))
          .catch((err) => console.error("❌ FCM error", err));
      }

      // Kirim Telegram selalu
      sendTelegram(
        `🚨 Motor keluar zona!\nLokasi: ${
          latestData.lat_kalman || latestData.lat_raw
        }, ${latestData.lon_kalman || latestData.lon_raw}\nWaktu: ${
          latestData.waktu
        }`
      );
    }
    // Jika status berubah ke Aman
    else if (prevStatusZona !== "Aman" && latestData.statusZona === "Aman") {
      // ✅ Matikan alarm via MQTT
      mqttClient.publish(TOPIC_ALARM, JSON.stringify({ on: false }), () => {
        console.log("✅ Alarm OFF dipublish ke MQTT (kembali ke zona aman)");
      });
      latestAlarmStatus = false;
      broadcastEvent("alarm", { on: latestAlarmStatus });

      // Bisa juga kirim notifikasi
      sendTelegram(
        `✅ Motor kembali ke zona aman.\nLokasi: ${
          latestData.lat_kalman || latestData.lat_raw
        }, ${latestData.lon_kalman || latestData.lon_raw}\nWaktu: ${
          latestData.waktu
        }`
      );
    }

    // update terakhir
    prevStatusZona = latestData.statusZona;
  }

  // ---- 2. Pesan status sistem ----
  else if (topic === TOPIC_SYSTEM) {
    try {
      const parsed = JSON.parse(msg);
      latestSystemStatus = parsed.active ?? null;
      broadcastEvent("system", { active: latestSystemStatus });
    } catch {
      console.error("❌ Invalid JSON from SYSTEM topic");
    }
  }
  // ---- 3. Pesan status alarm ----
  else if (topic === TOPIC_ALARM) {
    try {
      const parsed = JSON.parse(message.toString());
      latestAlarmStatus = parsed.on === true;
      broadcastEvent("alarm", { on: latestAlarmStatus });
    } catch {
      console.error("❌ Invalid JSON from ALARM topic");
    }
  }

  // ---- 4. Trigger kamera ----
  else if (topic === TOPIC_CAMERA) {
    broadcastEvent("camera", { capture: true });
  }
});

// ----- Express Endpoints -----
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: connected\n\n`);
  sseClients.push(res);
  req.on("close", () => {
    sseClients = sseClients.filter((s) => s !== res);
  });
});

app.get("/api/monitoring", (req, res) => {
  res.json({
    latitude: latestData.lat_kalman || latestData.lat_raw,
    longitude: latestData.lon_kalman || latestData.lon_raw,
    lat_raw: latestData.lat_raw,
    lon_raw: latestData.lon_raw,
    lat_kalman: latestData.lat_kalman,
    lon_kalman: latestData.lon_kalman,
    statusZona: latestData.statusZona,
    waktu: latestData.waktu,
    deviceOn: latestSystemStatus,
    alarmOn: latestAlarmStatus,
  });
});

app.get("/api/gps-log", (req, res) => {
  res.download(logFile);
});

app.post("/system-status", (req, res) => {
  const { active, lat, lon } = req.body;

  if (active) {
    // coba koersi ke number jika string
    const latN = typeof lat === "number" ? lat : lat ? Number(lat) : NaN;
    const lonN = typeof lon === "number" ? lon : lon ? Number(lon) : NaN;

    // Fallback: jika tidak diberikan, gunakan latestData apabila tersedia
    if (isNaN(latN) || isNaN(lonN)) {
      if (latestData && latestData.lat_raw && latestData.lon_raw) {
        safeZoneCenter = { lat: latestData.lat_raw, lon: latestData.lon_raw };
        console.log("Zona aman diset via fallback latestData:", safeZoneCenter);
      } else {
        return res.status(400).json({
          status: "error",
          message:
            "lat dan lon harus diberikan saat aktifkan sistem (atau pastikan device sudah mengirim lokasi)",
        });
      }
    } else {
      safeZoneCenter = { lat: latN, lon: lonN };
      console.log("Zona aman diset di:", safeZoneCenter);
    }
  } else {
    safeZoneCenter = null;
  }

  mqttClient.publish(TOPIC_SYSTEM, JSON.stringify({ active }));
  latestSystemStatus = active;
  broadcastEvent("system", { active });
  res.json({ status: "ok", active, safeZoneCenter });
});

app.post("/alarm", (req, res) => {
  const { on } = req.body;
  if (typeof on !== "boolean") {
    return res
      .status(400)
      .json({ status: "error", message: '"on" harus boolean true atau false' });
  }
  mqttClient.publish(TOPIC_ALARM, JSON.stringify({ on }));
  latestAlarmStatus = on;
  broadcastEvent("alarm", { on: latestAlarmStatus });
  res.json({ status: "ok", on: latestAlarmStatus });
});

app.post("/trigger-camera", (req, res) => {
  mqttClient.publish(TOPIC_CAMERA, JSON.stringify({ capture: true }));
  broadcastEvent("camera", { capture: true });
  res.json({ status: "ok", message: "trigger sent" });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});
