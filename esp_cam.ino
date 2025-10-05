 #include <esp_camera.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

//======== KONFIGURASI========
// ===== WiFi =====
const char* ssid = "**********";          //SSID Wifi
const char* password = "********"; //Password Wifi

// ===== MQTT =====
const char* mqtt_server = "44.232.241.40";  // IP broker MQTT (EMQX)
const int mqtt_port = 1883;                // Port MQTT
const char* mqtt_topic_trigger = "motor/camera"; // Topik untuk trigger ambil foto

// ===== Telegram Bot =====
const char* TELEGRAM_HOST = "api.telegram.org";                     // Server Telegram
String BOTtoken = "8159523908:AAH5u34kRwm0F9kttMGj2K1C2f712z8BDf4"; // Token Bot
String CHAT_ID = "1771619682";                                      // Chat ID 


// ===== Variabel untuk /photo di Telegram =====
unsigned long lastTelegramCheck = 0;                // Waktu terakhir cek pesan
const unsigned long TELEGRAM_CHECK_INTERVAL = 5000; // Cek pesan tiap 5 detik
long lastUpdateId = 0;                              // ID update terakhir dari telegram


// ===== Pins =====
#define FLASH_LED_PIN 4   // Pin untuk LED flash 
#define FEEDBACK_PIN 15   // Pin feedback  

WiFiClient wifiClient;                // koneksi dasar WiFi
PubSubClient mqttClient(wifiClient);  // MQTT client

bool isCameraBusy = false;                     // Flag untuk hindari double capture
unsigned long lastTriggerTime = 0;             // Simpan waktu terakhir capture


// ================== SETUP KAMERA ================== //
// Fungsi untuk inisialisasi konfigurasi kamera ESP32-CAM
void configInitCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = 5;
  config.pin_d1 = 18;
  config.pin_d2 = 19;
  config.pin_d3 = 21;
  config.pin_d4 = 36;
  config.pin_d5 = 39;
  config.pin_d6 = 34;
  config.pin_d7 = 35;
  config.pin_xclk = 0;
  config.pin_pclk = 22;
  config.pin_vsync = 25;
  config.pin_href = 23;
  config.pin_sscb_sda = 26;
  config.pin_sscb_scl = 27;
  config.pin_pwdn = 32;
  config.pin_reset = -1;
  config.xclk_freq_hz = 20000000;       // clock kamera 20 MHz
  config.pixel_format = PIXFORMAT_JPEG; // format gambar JPEG

  // Gunakan resolusi sedang untuk mengurangi DMA overflow
  if (psramFound()) {
    config.frame_size = FRAMESIZE_SVGA;  // 800x600
    config.jpeg_quality = 10;           // kualitas gambar menengah
    config.fb_count = 1;
  } else {
    config.frame_size = FRAMESIZE_SVGA;
    config.jpeg_quality = 10;
    config.fb_count = 1;
  }

  // Inisialisasi kamera
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    delay(2000);
    ESP.restart();  // restart jika gagal
  }
}


// ================== FEEDBACK ================== //
// Kirim pulse singkat ke pin FEEDBACK_PIN (bisa buzzer/LED) 
// untuk memberi tanda sukses atau gagal
void sendFeedbackPulse(bool success) {
  digitalWrite(FEEDBACK_PIN, HIGH);
  delay(120);
  digitalWrite(FEEDBACK_PIN, LOW);
  Serial.printf("Feedback pulse sent (%s)\n", success ? "SUCCESS" : "FAIL");
}


// ================== KIRIM FOTO KE TELEGRAM ================== //
// Fungsi untuk upload foto ke Telegram dengan protokol HTTP multipart/form-data
String sendPhotoTelegram_HTTP(camera_fb_t* fb) {
  if (!fb) return String("no_fb");

  WiFiClientSecure clientTCP;
  clientTCP.setTimeout(30000);
  clientTCP.setInsecure();  // abaikan sertifikat SSL (lebih mudah di ESP32)

  if (!clientTCP.connect(TELEGRAM_HOST, 443)) {
    Serial.println("Failed to connect to Telegram");
    return String("connect_fail");
  }

 // Format HTTP body (multipart)
  String boundary = "----ESP32CAMBoundary123";
  String head = "--" + boundary + "\r\n";
  head += "Content-Disposition: form-data; name=\"chat_id\"\r\n\r\n";
  head += CHAT_ID + "\r\n";
  head += "--" + boundary + "\r\n";
  head += "Content-Disposition: form-data; name=\"photo\"; filename=\"esp32-cam.jpg\"\r\n";
  head += "Content-Type: image/jpeg\r\n\r\n";

  String tail = "\r\n--" + boundary + "--\r\n";
  uint32_t contentLength = head.length() + fb->len + tail.length();


  // Kirim request HTTP POST
  clientTCP.print(String("POST /bot") + BOTtoken + "/sendPhoto HTTP/1.1\r\n");
  clientTCP.print(String("Host: ") + TELEGRAM_HOST + "\r\n");
  clientTCP.print("User-Agent: ESP32-CAM\r\n");
  clientTCP.print("Content-Type: multipart/form-data; boundary=" + boundary + "\r\n");
  clientTCP.print("Content-Length: " + String(contentLength) + "\r\n");
  clientTCP.print("Connection: close\r\n\r\n");

  // Upload data gambar (buffer kamera dikirim bertahap)
  clientTCP.print(head);
  uint8_t* fbBuf = fb->buf;
  size_t fbLen = fb->len;
  size_t chunkSize = 1024;
  size_t sent = 0;
  while (sent < fbLen) {
    size_t toSend = (fbLen - sent) > chunkSize ? chunkSize : (fbLen - sent);
    clientTCP.write(fbBuf + sent, toSend);
    sent += toSend;
    yield();
  }

  clientTCP.print(tail);

 // Baca respon dari server Telegram
  String resp;
  long start = millis();
  while (millis() - start < 30000) {
    while (clientTCP.available()) {
      char c = clientTCP.read();
      resp += c;
    }
    if (!clientTCP.connected() && clientTCP.available() == 0) break;
    yield();
  }
  clientTCP.stop();

  Serial.println("Telegram response: " + resp);

  return resp;
}


// ================== AMBIL FOTO DAN KIRIM ================== //
// Fungsi utama untuk trigger kamera lalu upload ke Telegram
bool captureAndSendPhoto() {
  if (isCameraBusy) return false;
  isCameraBusy = true;
  lastTriggerTime = millis();

  Serial.println("Taking photo...");

  
  camera_fb_t* fb = esp_camera_fb_get();   // ambil frame dari kamera
  if (!fb) {
    Serial.println("Camera capture failed");
    isCameraBusy = false;
    //digitalWrite(FLASH_LED_PIN, LOW); // matikan flash jika gagal
    return false;
  }

  String response = sendPhotoTelegram_HTTP(fb);  // kirim foto ke Telegram
  esp_camera_fb_return(fb);                      // kembalikan buffer
 

  delay(150); // Delay untuk stabilisasi
  
  bool ok = (response.indexOf("\"ok\":true") >= 0);
  Serial.printf("Telegram upload %s\n", ok ? "SUCCESS" : "FAIL");

  sendFeedbackPulse(ok);  // kasih tanda ke buzzer/LED

  isCameraBusy = false;
  return ok;
}

// ================== CALLBACK MQTT ================== //
// Fungsi ini otomatis dipanggil setiap ada pesan masuk ke topic MQTT
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message;
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.printf("MQTT message arrived on topic %s: %s\n", topic, message.c_str());

// Jika ada pesan ke topic trigger
  if (String(topic) == mqtt_topic_trigger) {
    StaticJsonDocument<200> doc;
    DeserializationError error = deserializeJson(doc, message);

    if (!error) {
      // Jika pesan JSON, contoh: {"capture":true}
      bool capture = doc["capture"] | false;
      if (capture) {
        Serial.println("Trigger photo via MQTT (JSON)");
        captureAndSendPhoto();
      }
    } else {
       // Jika pesan string biasa: "true" atau "1"
      if (message == "true" || message == "1") {
        Serial.println("Trigger photo via MQTT (string)");
        captureAndSendPhoto();
      }
    }
  }
}

// ================== RECONNECT MQTT ================== //
// Jika MQTT terputus, coba koneksi ulang
void reconnectMQTT() {
  while (!mqttClient.connected()) {
    Serial.print("Connecting MQTT...");
    if (mqttClient.connect("ESP32CAMClient")) {
      Serial.println("connected");
      mqttClient.subscribe(mqtt_topic_trigger);        // subscribe ke topic
      Serial.printf("Subscribed to topic: %s\n", mqtt_topic_trigger);
    } else {
      Serial.print("failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" try again in 5 seconds");
      delay(5000);
    }
  }
}

// ================== SETUP ================== //
void setup() {
  Serial.begin(115200);
  delay(200);

  // Set pin output
  pinMode(FLASH_LED_PIN, OUTPUT);
  pinMode(FEEDBACK_PIN, OUTPUT);
  digitalWrite(FEEDBACK_PIN, LOW);
  digitalWrite(FLASH_LED_PIN, LOW);

 // Koneksi ke WiFi
  Serial.println("Connecting to WiFi...");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected.");

  // Inisialisasi kamera
  configInitCamera();

  // Inisialisasi MQTT
  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setCallback(mqttCallback);

  Serial.println("Setup complete.");
}


// ================== CEK PESAN TELEGRAM ================== //
// Fungsi ini cek apakah ada pesan baru di Telegram
// Kalau ada pesan "/photo", maka ambil foto dan kirim balik
void checkTelegramMessages() {
  WiFiClientSecure client;
  client.setInsecure();

  if (!client.connect(TELEGRAM_HOST, 443)) {
    Serial.println("Telegram connection failed");
    return;
  }

  String url = "/bot" + BOTtoken + "/getUpdates?offset=" + String(lastUpdateId + 1);
  client.print(String("GET ") + url + " HTTP/1.1\r\n" +
               "Host: " + TELEGRAM_HOST + "\r\n" +
               "Connection: close\r\n\r\n");

  String response;
  while (client.connected() || client.available()) {
    if (client.available()) {
      response += client.readStringUntil('\n');
    }
  }
  client.stop();

  // Cari bagian JSON dari respon/"result"
  int idx = response.indexOf("{\"ok\":true");
  if (idx == -1) return;

  String jsonStr = response.substring(idx);
  StaticJsonDocument<4096> doc;
  DeserializationError err = deserializeJson(doc, jsonStr);
  if (err) {
    Serial.println("JSON parse error");
    return;
  }

 // Loop tiap pesan baru
  JsonArray results = doc["result"].as<JsonArray>();
  for (JsonObject update : results) {
    long update_id = update["update_id"];
    String text = update["message"]["text"] | "";

    if (update_id > lastUpdateId) {
      lastUpdateId = update_id;
    }

   // Jika ada perintah "/photo"
    if (text == "/photo") {
      Serial.println("Telegram command: /photo");
      captureAndSendPhoto();
    }
  }
}

// ================== LOOP ================== //
void loop() {
  // Pastikan MQTT selalu terhubung
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  // Cek pesan Telegram setiap interval tertentu
  if (millis() - lastTelegramCheck > TELEGRAM_CHECK_INTERVAL) {
    lastTelegramCheck = millis();
    checkTelegramMessages();
  }
}




// configInitCamera() → inisialisasi kamera.
// sendPhotoTelegram_HTTP() → fungsi khusus untuk upload foto ke Telegram.
// captureAndSendPhoto() → ambil foto + nyalakan flash + upload ke Telegram.
// mqttCallback() → dipanggil kalau ada pesan dari MQTT.
// checkTelegramMessages() → cek apakah ada perintah /photo di Telegram.
// reconnectMQTT() → supaya koneksi MQTT otomatis nyambung lagi kalau putus.
// sendFeedbackPulse() → kasih sinyal feedback (buzzer/LED).




