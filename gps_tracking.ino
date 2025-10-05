// Library
#include <TinyGPS++.h>      
#include <HardwareSerial.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ======= CONFIG WIFI & MQTT=======
const char* ssid = "*********"; //username wifi
const char* password = "*********";  //password wifi
const char* mqtt_server = "broker.emqx.io";  // MQTT broker (EMQX public)


// ======= MQTT TOPICS =======
const char* TOPIC_LOCATION = "motor/location";              // Lokasi GPS
const char* TOPIC_SYSTEM = "motor/system";                 // Sistem aktif / mati
const char* TOPIC_ALARM = "motor/alarm";                  // Alarm manual
const char* TOPIC_CAMERA = "motor/camera";               // Trigger kamera
const char* TOPIC_NOTIFICATION = "motor/notification";  // Notifikasi keluar zona

// ======= GPS =======
TinyGPSPlus gps;
HardwareSerial GPSSerial(1);  // UART1 untuk GPS (pin RX/TX)

// ======= MQTT client =======
WiFiClient espClient;
PubSubClient client(espClient);

// ======= Pins =======
const int pinBuzzer = 13;     // Buzzer output
const int pinTriggerCam = 14; // Pin untuk trigger kamera ESP32-CAM

// ======= Geofence  =======
double safeLat = 0.0, safeLng = 0.0;     // Koordinat zona aman
bool zonaAmanDiset = false;             // Apakah sudah diset zona aman
bool geofenceAktif = false;            // Status aktif geofence
const double ZONA_AMAN_RADIUS = 20.0;  // Radius aman (meter)
unsigned long waktuSetZona = 0;        // Waktu zona diset

// ================== STATE SISTEM ==================
bool deviceOn = false;        // Status sistem dari dashboard
bool buzzerOnRemote = false;  // Status alarm dari dashboard (manual)
bool alarmManual = false;     // Mode alarm manual
enum AlarmMode { OFF_TOTAL, MANUAL, AUTO };
AlarmMode modeAlarm = OFF_TOTAL;   // Mode alarm default

// ================== TIMER & INTERVAL ==================
unsigned long lastTriggerTime = 0;
unsigned long lastPublish = 0;
const unsigned long TRIGGER_COOLDOWN = 30000UL;  // Cooldown kamera 30 detik
const unsigned long PUBLISH_INTERVAL = 1000UL;   // Publish GPS tiap 1 detik

// ======= Kalman Filter vars =======
double lat_est = 0.0, lng_est = 0.0;     // Estimasi lokasi
double err_est_lat = 1.0, err_est_lng = 1.0;
const double q = 0.0001;    // Process noise
const double r = 0.01;      // Measurement noise

// ======= Kalman Filter =======
double kalmanUpdate(double measurement, double& estimate, double& err_est) {
  double k_gain = err_est / (err_est + r);
  estimate += k_gain * (measurement - estimate);
  err_est = (1.0 - k_gain) * err_est + fabs(estimate - measurement) * q;
  return estimate;
}

// ================== HITUNG JARAK HAVERSINE ==================
double hitungJarak(double lat1, double lon1, double lat2, double lon2) {
  const double R = 6371000.0;  // Jari-jari bumi (m)
  double dLat = radians(lat2 - lat1);
  double dLon = radians(lon2 - lon1);
  double a = sin(dLat / 2.0) * sin(dLat / 2.0) + cos(radians(lat1)) * cos(radians(lat2)) * sin(dLon / 2.0) * sin(dLon / 2.0);
  return R * 2.0 * atan2(sqrt(a), sqrt(1 - a));
}

// ================== WAKTU FORMAT ISO ==================
String getIsoTime() {
  if (gps.date.isValid() && gps.time.isValid()) {
    char buf[30];
    sprintf(buf, "%04d-%02d-%02dT%02d:%02d:%02dZ",
            gps.date.year(), gps.date.month(), gps.date.day(),
            gps.time.hour(), gps.time.minute(), gps.time.second());
    return String(buf);
  }
  return String(millis());
}

// ======= WiFi =======
void connectWiFi() {
  Serial.print("🔌 Connecting WiFi ");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println("\n✅ WiFi connected: " + WiFi.localIP().toString());
}

// ======= MQTT =======
String makeClientId() {
  uint64_t chipid = ESP.getEfuseMac();
  char cid[30];
  sprintf(cid, "ESP32-%04X", (uint16_t)(chipid & 0xFFFF));
  return String(cid);
}

void reconnectMQTT() {
  if (client.connected()) return;
  Serial.print("🔄 Reconnect MQTT...");
  String clientId = makeClientId();
  while (!client.connected()) {
    if (client.connect(clientId.c_str())) {
      Serial.println("✅ MQTT connected");
      client.subscribe(TOPIC_SYSTEM);
      client.subscribe(TOPIC_ALARM);
      client.subscribe(TOPIC_CAMERA);
      Serial.println("📡 Subscribed to system, alarm, and camera topics");
    } else {
      Serial.print("❌ failed, rc=");
      Serial.println(client.state());
      delay(2000);
    }
  }
}

// ================== TRIGGER KAMERA ==================
void triggerCamera() {
  Serial.println("📸 Trigger camera (local pin)");
  digitalWrite(pinTriggerCam, HIGH);
  delay(120);
  digitalWrite(pinTriggerCam, LOW);
}

// ================== PUBLISH DATA GPS ==================
void publishLocation(double rawLat, double rawLng, double kalmanLat, double kalmanLng, const char* statusZona) {
  if (!client.connected()) return;
  StaticJsonDocument<256> doc;
  doc["lat_raw"] = rawLat;
  doc["lon_raw"] = rawLng;
  doc["lat_kalman"] = kalmanLat;
  doc["lon_kalman"] = kalmanLng;
  doc["statusZona"] = statusZona;
  doc["waktu"] = getIsoTime();

  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (n > 0) {
    client.publish(TOPIC_LOCATION, buf);
    Serial.println(String("📤 Published location: ") + String(buf));
  }
}

// ================== PARSE PAYLOAD MQTT (JSON/STRING) ==================
bool parseBoolPayload(const String& msg, const char* key = nullptr) {
  String s = msg;
  s.trim();
  if (s.equalsIgnoreCase("true")) return true;
  if (s.equalsIgnoreCase("false")) return false;

  StaticJsonDocument<128> doc;
  DeserializationError err = deserializeJson(doc, s);
  if (!err) {
    if (key != nullptr && doc.containsKey(key)) return doc[key];
    if (doc.containsKey("active")) return doc["active"];
    if (doc.containsKey("on")) return doc["on"];
    if (doc.containsKey("capture")) return doc["capture"];
    if (doc.containsKey("value")) return doc["value"];
  }
  return false;
}

// ================== CALLBACK MQTT ==================
void callback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
  Serial.println(String("📩 MQTT recv [") + topic + "] -> " + msg);

  // === di MQTT callback ===
  if (String(topic) == TOPIC_SYSTEM) {
    bool newStatus = parseBoolPayload(msg, "active");

    // Deteksi perubahan status
    if (deviceOn != newStatus) {
      deviceOn = newStatus;
      Serial.println(String("📡 deviceOn = ") + (deviceOn ? "true" : "false"));

      if (deviceOn) {
        // Hanya set zona aman sekali saat toggle ON
        if (gps.location.isValid() && gps.satellites.value() >= 4 && gps.hdop.hdop() <= 2.5) {
          safeLat = gps.location.lat();
          safeLng = gps.location.lng();
          zonaAmanDiset = true;
          waktuSetZona = millis();
          geofenceAktif = false;  // aktifkan setelah delay di loop
          Serial.printf("🏠 Safe zone SET (toggle ON) -> %.6f, %.6f\n", safeLat, safeLng);
        } else {
          Serial.println("⚠ GPS belum fix, zona aman belum diset");
          zonaAmanDiset = false;  // nanti coba ulang jika sudah fix
          geofenceAktif = false;
        }
      } else {
        geofenceAktif = false;
        digitalWrite(pinBuzzer, LOW);
        alarmManual = false;
      }

      // Publish status
      StaticJsonDocument<64> doc;
      doc["active"] = deviceOn;
      char buf[64];
      serializeJson(doc, buf);
      client.publish(TOPIC_SYSTEM, buf, true);
    }
  }


  // ---- Handle pesan dari TOPIC_ALARM ----
  else if (String(topic) == TOPIC_ALARM) {
    bool newBuzzerState = parseBoolPayload(msg, "on");

    buzzerOnRemote = newBuzzerState;
    if (buzzerOnRemote) {
      modeAlarm = MANUAL;
    } else {
      // kalau user OFF, kita kunci OFF_TOTAL
      modeAlarm = OFF_TOTAL;
    }

    Serial.println(String("🔔 Alarm mode = ") + (modeAlarm == MANUAL ? "MANUAL" : "OFF_TOTAL"));
  }


 // ---- Handle pesan dari TOPIC_CAMERA ----
  else if (String(topic) == TOPIC_CAMERA) {
    if (parseBoolPayload(msg, "capture")) triggerCamera();
  }
}

// ================== SETUP ==================
void setup() {
  Serial.begin(115200);
  GPSSerial.begin(9600, SERIAL_8N1, 16, 17);  // GPS di pin RX=16, TX=17

  pinMode(pinBuzzer, OUTPUT);
  pinMode(pinTriggerCam, OUTPUT);
  digitalWrite(pinBuzzer, LOW);
  digitalWrite(pinTriggerCam, LOW);

  connectWiFi();
  client.setServer(mqtt_server, 1883);
  client.setCallback(callback);
}

// ================== PROSES GPS & GEOFENCE ==================
void processGPSAndGeofence() {
  // Update estimasi lokasi
  double rawLat = gps.location.lat();
  double rawLng = gps.location.lng();
  double kalmanLat = kalmanUpdate(rawLat, lat_est, err_est_lat);
  double kalmanLng = kalmanUpdate(rawLng, lng_est, err_est_lng);

  // Serial.printf("📍 GPS raw: %.6f, %.6f | sat=%d | HDOP=%.2f\n",
  //               rawLat, rawLng, gps.satellites.value(), gps.hdop.hdop());


  // Jika toggle ON tapi zona aman belum diset karena GPS belum fix
  if (deviceOn && !zonaAmanDiset && gps.satellites.value() >= 4 && gps.hdop.hdop() <= 2.5) {
    safeLat = kalmanLat;
    safeLng = kalmanLng;
    zonaAmanDiset = true;
    waktuSetZona = millis();
    geofenceAktif = false;
    Serial.printf("🏠 Safe zone SET (retry GPS fix) -> %.6f, %.6f\n", safeLat, safeLng);
  }

  // Aktifkan geofence 5 detik setelah zona aman di-set
  if (deviceOn && zonaAmanDiset && !geofenceAktif && (millis() - waktuSetZona > 5000UL)) {
    geofenceAktif = true;
    Serial.println("✅ Geofence ACTIVATED");
  }

  // Hitung jarak zona aman & status
  double distance = hitungJarak(safeLat, safeLng, kalmanLat, kalmanLng);
  const char* statusZona = (geofenceAktif && distance > ZONA_AMAN_RADIUS) ? "Bahaya" : "Aman";

  // Alarm 
switch (modeAlarm) {
  case OFF_TOTAL:  // Alarm mati total
    digitalWrite(pinBuzzer, LOW);
    break;

  case MANUAL:   // Alarm manual (dari dashboard)
    digitalWrite(pinBuzzer, buzzerOnRemote ? HIGH : LOW);
    break;

  case AUTO:  // Alarm otomatis (geofence)
    if (geofenceAktif && strcmp(statusZona, "Bahaya") == 0) {
      digitalWrite(pinBuzzer, HIGH);
      if (millis() - lastTriggerTime > TRIGGER_COOLDOWN) {
        triggerCamera();
        if (client.connected()) {
          client.publish(TOPIC_NOTIFICATION, "🚨 Kendaraan keluar dari zona aman!");
        }
        lastTriggerTime = millis();
      }
    } else {
      digitalWrite(pinBuzzer, LOW);
    }
    break;
}


  // Publish lokasi setiap interval
  if (millis() - lastPublish > PUBLISH_INTERVAL) {
    publishLocation(rawLat, rawLng, kalmanLat, kalmanLng, statusZona);
    lastPublish = millis();
  }
}

// ================== LOOP ==================
void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!client.connected()) reconnectMQTT();
  client.loop();

  while (GPSSerial.available()) {
    gps.encode(GPSSerial.read());
  }

  // Proses GPS & Geofence
  processGPSAndGeofence();
}

// Geofence → set titik aman saat device ON dan GPS fix.
// Kalman filter → bikin data GPS lebih stabil.
// Alarm → bisa OFF, MANUAL (kontrol dashboard), atau AUTO (aktif kalau keluar zona).
// MQTT → publish lokasi (motor/location), notifikasi (motor/notification), dan subscribe command (system, alarm, camera).
// Trigger kamera → aktif kalau keluar zona atau perintah MQTT.