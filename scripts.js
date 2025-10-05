// ====== CONFIG ======
const API_BASE = "http://localhost:3000"; // URL backend ubah jika server beda
const POLL_INTERVAL = 3000; // Interval polling data dari server (ms)
const MAX_POINTS = 1000; // Maksimal jumlah titik jalur disimpan (agar tidak menumpuk)

let map, motorMarkerRaw, motorMarkerKalman, userMarker, safeCircle;
let lastData = null; // data GPS terbaru
let isConnected = false; // status koneksi ke server
let notifyPermission = false; // apakah browser izinkan notifikasi
let lastInZone = true; // status terakhir motor (dalam zona?)
let systemActive = false; // status sistem aktif / nonaktif

let pathRaw = []; // array untuk jalur raw GPS
let pathKalman = []; // array untuk jalur hasil filter Kalman
let polylineRaw, polylineKalman;
let safeZoneCenter = null; // titik pusat zona aman
let safeZoneCircle = null; // objek circle zona aman di peta

const SAFE_RADIUS = 20; // radius zona aman default (meter)
const COLOR_SAFE = "#28a745"; // warna zona aman
const COLOR_DANGER = "#dc3545"; // warna zona bahaya

// Event listener untuk update lokasi
eventSource.addEventListener("location", (e) => {
  const data = JSON.parse(e.data);

  // Update marker posisi motor
  updateMarker(data.latitude, data.longitude);

  // Jika sistem ON dan ada zona aman, gambar circle
  if (systemActive && safeZoneCenter) {
    if (safeZoneCircle) {
      map.removeLayer(safeZoneCircle); // hapus circle lama
    }
    safeZoneCircle = L.circle([safeZoneCenter.lat, safeZoneCenter.lon], {
      radius: SAFE_RADIUS, // pastikan sama seperti di backend (20 meter)
      color: "blue",
      fillColor: "#3f51b5",
      fillOpacity: 0.2,
    }).addTo(map);
  }
});

// ========================================================
// === TOGGLE SISTEM: aktifkan/nonaktifkan sistem geofence
// ========================================================
document.getElementById("toggleSystemBtn").addEventListener("click", () => {
  console.log("[DEBUG] Toggle button clicked. System active:", systemActive);

  if (!systemActive) {
    // 🔵 AKTIFKAN sistem
    console.log("[DEBUG] Trying to activate system...");
    console.log("[DEBUG] LatestLat:", latestLat, "LatestLon:", latestLon);

    if (latestLat && latestLon) {
      // kirim koordinat ke server sebagai pusat zona
      fetch("/system-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true, lat: latestLat, lon: latestLon }),
      })
        .then((res) => res.json())
        .then((resp) => {
          console.log("[DEBUG] Server response:", resp);

          if (resp.active) {
            // simpan titik zona aman
            safeZoneCenter = { lat: latestLat, lon: latestLon };
            console.log("[DEBUG] Safe zone center set:", safeZoneCenter);

            drawSafeZoneCircle();
          } else {
            console.warn("[DEBUG] Server did not activate system");
          }
        })
        .catch((err) => console.error("[DEBUG] Fetch error:", err));
    } else {
      alert("Lokasi belum tersedia");
      console.warn("[DEBUG] Location not available yet.");
    }
  } else {
    // 🔴 NONAKTIFKAN sistem
    console.log("[DEBUG] Deactivating system...");
    fetch("/system-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    })
      .then(() => {
        if (safeZoneCircle) {
          map.removeLayer(safeZoneCircle);
          safeZoneCircle = null;
          console.log("[DEBUG] Safe zone circle removed.");
        } else {
          console.warn("[DEBUG] No circle to remove.");
        }
      })
      .catch((err) => console.error("[DEBUG] Fetch error:", err));
  }
});

// ========================================================
// === FUNGSI: menggambar circle zona aman di peta
// ========================================================
function drawSafeZoneCircle() {
  console.log("[DEBUG] Drawing safe zone circle...");

  if (!safeZoneCenter) {
    console.error("[DEBUG] Cannot draw circle: safeZoneCenter is undefined");
    return;
  }

  if (safeZoneCircle) {
    map.removeLayer(safeZoneCircle);
    console.log("[DEBUG] Previous circle removed.");
  }

  safeZoneCircle = L.circle([safeZoneCenter.lat, safeZoneCenter.lon], {
    radius: SAFE_RADIUS,
    color: "blue",
    fillColor: "#3f51b5",
    fillOpacity: 0.2,
  }).addTo(map);

  console.log(
    "[DEBUG] Circle added at:",
    safeZoneCenter,
    "with radius:",
    SAFE_RADIUS
  );
}

// ========================================================
// === FUNGSI: inisialisasi peta & marker
// ========================================================
function init() {
  map = L.map("map", { zoomControl: true }).setView([-6.2, 106.816], 16);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);

  // marker motor GPS raw, Kalman, dan user
  motorMarkerRaw = L.marker([0, 0], {
    icon: L.icon({
      iconUrl: "https://maps.gstatic.com/mapfiles/ms2/micons/red.png",
      iconSize: [32, 32],
    }),
  }).addTo(map);
  motorMarkerKalman = L.marker([0, 0], {
    icon: L.icon({
      iconUrl: "https://maps.gstatic.com/mapfiles/ms2/micons/orange.png",
      iconSize: [32, 32],
    }),
  }).addTo(map);
  userMarker = L.marker([0, 0], {
    icon: L.icon({
      iconUrl: "https://maps.gstatic.com/mapfiles/ms2/micons/blue.png",
      iconSize: [32, 32],
    }),
  }).addTo(map);

  // garis jalur motor (raw & kalman)
  polylineRaw = L.polyline([], { color: "red", weight: 3 }).addTo(map);
  polylineKalman = L.polyline([], { color: "blue", weight: 3 }).addTo(map);

  // tombol reset jalur
  const resetBtn = L.control({ position: "topright" });
  resetBtn.onAdd = function (map) {
    const btn = L.DomUtil.create("button", "reset-button");
    btn.innerHTML = "Reset Jalur";
    btn.style.background = "white";
    btn.style.padding = "5px";
    btn.style.cursor = "pointer";
    btn.onclick = resetPaths;
    return btn;
  };
  resetBtn.addTo(map);

  // deteksi lokasi user
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = [pos.coords.latitude, pos.coords.longitude];
        userMarker.setLatLng(p);
        document.getElementById("user-coord").textContent = `${p[0].toFixed(
          6
        )}, ${p[1].toFixed(6)}`;
      },
      (e) => console.warn("Cannot get user location", e),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  }

  // hubungkan ui tombol dengan fungsi
  const systemToggle = document.getElementById("system-toggle");
  const alarmToggle = document.getElementById("alarm-toggle");
  const btnTrigger = document.getElementById("btn-trigger");
  const btnUpdateZone = document.getElementById("btn-update-zone");
  const btnCenter = document.getElementById("btn-center");

  if (!systemToggle) console.warn("system-toggle element not found!");
  else {
    systemToggle.addEventListener("change", onToggleSystem);
    // disable sampai dapat titik GPS pertama
    systemToggle.disabled = true;
    systemToggle.title = "Tunggu data lokasi motor tersedia...";
  }

  if (alarmToggle) alarmToggle.addEventListener("change", onToggleAlarm);
  if (btnTrigger) btnTrigger.addEventListener("click", triggerCamera);
  if (btnUpdateZone)
    btnUpdateZone.addEventListener("click", updateZoneFromMotor);
  if (btnCenter) btnCenter.addEventListener("click", centerMapToMotor);

  if ("Notification" in window)
    Notification.requestPermission().then(
      (p) => (notifyPermission = p === "granted")
    );

  poll(); // polling pertama
  setInterval(poll, POLL_INTERVAL);
  initSSE(); // inisialisasi SSE
}

// ========================================================
// === FUNGSI: reset jalur (hapus polyline)
// ========================================================
function resetPaths() {
  pathRaw = [];
  pathKalman = [];
  polylineRaw.setLatLngs([]);
  polylineKalman.setLatLngs([]);
}

// ========================================================
// === FUNGSI: polling data GPS terbaru dari server
// ========================================================
async function poll() {
  try {
    const res = await fetch(`${API_BASE}/api/monitoring`);
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    isConnected = true;
    document.getElementById("connect-indicator").textContent = "Connected";
    document.getElementById("connect-indicator").className = "dot connected";
    handleData(data); // kirim ke fungsi handleData()

    // aktifkan tombol sistem jika sudah ada koordinat motor
    const systemToggle = document.getElementById("system-toggle");
    if (systemToggle && data.lat_raw && data.lon_raw) {
      systemToggle.disabled = false;
      systemToggle.title = "";
    }
  } catch (err) {
    console.warn("Polling error", err);
    isConnected = false;
    document.getElementById("connect-indicator").textContent = "Disconnected";
    document.getElementById("connect-indicator").className = "dot connecting";
  }
}

// ========================================================
// === FUNGSI: handleData → update UI, marker, jalur, zona
// ========================================================
function handleData(data) {
  if (!data) return;
  lastData = data;
  const safeRadius = data.safe_radius || data.safeRadius || SAFE_RADIUS;

  // update panel status (koordinat, waktu, zona, status)
  document.getElementById("motor-coord").textContent =
    data.lat_raw && data.lon_raw
      ? `${parseFloat(data.lat_raw).toFixed(6)}, ${parseFloat(
          data.lon_raw
        ).toFixed(6)}`
      : "-";
  document.getElementById("last-update").textContent = data.waktu || "-";
  document.getElementById("zona-status").textContent = data.statusZona || "-";
  document.getElementById("zona-status").className =
    data.statusZona && data.statusZona.toLowerCase().includes("aman")
      ? "status"
      : "status danger";

  // update marker motor
  if (data.lat_raw && data.lon_raw) {
    const rawPos = [parseFloat(data.lat_raw), parseFloat(data.lon_raw)];
    motorMarkerRaw.setLatLng(rawPos);

    if (safeZoneCenter) {
      if (!safeCircle) {
        safeCircle = L.circle(safeZoneCenter, {
          radius: safeRadius,
          color: COLOR_SAFE,
          fillColor: COLOR_SAFE,
          fillOpacity: 0.15,
        }).addTo(map);
      } else {
        safeCircle.setLatLng(safeZoneCenter).setRadius(safeRadius);
      }
      updateSafeCircleColor(data.statusZona);
    } else if (!safeCircle) {
      safeCircle = L.circle(rawPos, {
        radius: safeRadius,
        color: COLOR_SAFE,
        fillColor: COLOR_SAFE,
        fillOpacity: 0.15,
      }).addTo(map);
    }

    if (!mapHasCenter()) map.setView(rawPos, 16);
  }

  // paths
  try {
    if (data.lat_raw && data.lon_raw) {
      const rawPos = [parseFloat(data.lat_raw), parseFloat(data.lon_raw)];
      pathRaw.push(rawPos);
      if (pathRaw.length > MAX_POINTS) pathRaw.shift();
      polylineRaw.setLatLngs(pathRaw);
    }
    if (data.lat_kalman && data.lon_kalman) {
      const kalPos = [parseFloat(data.lat_kalman), parseFloat(data.lon_kalman)];
      pathKalman.push(kalPos);
      if (pathKalman.length > MAX_POINTS) pathKalman.shift();
      polylineKalman.setLatLngs(pathKalman);
    }
  } catch (e) {
    console.error(e);
  }

  // distance
  try {
    const userLatLng = userMarker.getLatLng();
    let motorLatLng = null;
    const viewMode = document.getElementById("viewMode")?.value || "raw";
    if (viewMode === "raw" && data.lat_raw && data.lon_raw)
      motorLatLng = L.latLng(
        parseFloat(data.lat_raw),
        parseFloat(data.lon_raw)
      );
    if (viewMode === "kalman" && data.lat_kalman && data.lon_kalman)
      motorLatLng = L.latLng(
        parseFloat(data.lat_kalman),
        parseFloat(data.lon_kalman)
      );
    if (motorLatLng) {
      const meters = userLatLng.distanceTo(motorLatLng);
      document.getElementById("distance").textContent = `${meters.toFixed(
        1
      )} m`;
    }
  } catch (e) {}

  // notify alarm
  const nowInZone =
    data.statusZona && data.statusZona.toLowerCase().includes("aman");
  if (lastInZone && !nowInZone) {
    pushAlertNotification(data);
    addHistoryEntry(data);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }
  lastInZone = nowInZone;
}

// ========================================================
// === FUNGSI: memusatkan peta ke posisi motor
// ========================================================
function centerMapToMotor() {
  if (lastData && lastData.lat_raw && lastData.lon_raw) {
    map.setView(
      [parseFloat(lastData.lat_raw), parseFloat(lastData.lon_raw)],
      16
    );
  }
}

// ========================================================
// === FUNGSI: cek apakah peta sudah pernah dipusatkan
// ========================================================
function mapHasCenter() {
  try {
    const c = map.getCenter();
    return c && c.lat !== 0 && c.lng !== 0;
  } catch (e) {
    return false;
  }
}

// ========================================================
// === FUNGSI: catat riwayat alarm motor keluar zona
// ========================================================
function addHistoryEntry(data) {
  const list = document.getElementById("alarm-history");
  const li = document.createElement("li");
  const d = new Date();
  li.textContent = `${d.toLocaleTimeString()} - Motor keluar zona (${
    data.safe_radius || SAFE_RADIUS
  } m)`;
  list.prepend(li);
}

// ========================================================
// === FUNGSI: push notifikasi browser saat motor keluar zona
// ========================================================
function pushAlertNotification(data) {
  if (!notifyPermission) return;
  const lat = data.lat_raw ? parseFloat(data.lat_raw).toFixed(6) : "-";
  const lon = data.lon_raw ? parseFloat(data.lon_raw).toFixed(6) : "-";
  const title = "🚨 Motor keluar zona!";
  const body = `Motor keluar dari zona. Lokasi: ${lat}, ${lon}`;
  const n = new Notification(title, {
    body,
    tag: "motor-alert",
    renotify: true,
  });
  n.onclick = () => {
    window.focus();
  };
}

// --- improved onToggleSystem with validation, UI lock, rollback ---
async function onToggleSystem(e) {
  const toggle = e.target;
  const active = toggle.checked;
  toggle.disabled = true; // prevent double click
  try {
    // choose lat/lon to send:
    let lat = null,
      lon = null;
    if (active) {
      if (lastData && lastData.lat_raw && lastData.lon_raw) {
        lat = parseFloat(lastData.lat_raw);
        lon = parseFloat(lastData.lon_raw);
      } else {
        // try using userMarker (browser geolocation)
        try {
          const u = userMarker.getLatLng();
          if (u && typeof u.lat === "number") {
            lat = u.lat;
            lon = u.lng;
          }
        } catch (e) {}
      }

      if (
        typeof lat !== "number" ||
        typeof lon !== "number" ||
        isNaN(lat) ||
        isNaN(lon)
      ) {
        alert(
          "Lokasi motor belum tersedia. Tunggu hingga data GPS diterima lalu aktifkan sistem."
        );
        toggle.checked = false;
        return;
      }
    }

    const body = {
      active,
      ...(active ? { lat: Number(lat), lon: Number(lon) } : {}),
    };
    console.log("Sending /system-status", body);

    const res = await fetch(`${API_BASE}/system-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => null);
      console.error("Server error on /system-status", res.status, txt);
      alert("Gagal mengubah status sistem (server). Cek console/server log.");
      // rollback UI
      toggle.checked = !active;
      return;
    }

    const j = await res.json();
    console.log("/system-status response", j);

    // update frontend safeZoneCenter from server response (if ada)
    if (j.safeZoneCenter && typeof j.safeZoneCenter.lat === "number") {
      safeZoneCenter = [j.safeZoneCenter.lat, j.safeZoneCenter.lon];
      if (safeCircle) {
        safeCircle.setLatLng(safeZoneCenter).setRadius(SAFE_RADIUS);
        updateSafeCircleColor("aman");
      } else {
        safeCircle = L.circle(safeZoneCenter, {
          radius: SAFE_RADIUS,
          color: COLOR_SAFE,
          fillColor: COLOR_SAFE,
          fillOpacity: 0.15,
        }).addTo(map);
      }
    } else if (active && lastData && lastData.lat_raw && lastData.lon_raw) {
      safeZoneCenter = [
        parseFloat(lastData.lat_raw),
        parseFloat(lastData.lon_raw),
      ];
      if (safeCircle)
        safeCircle.setLatLng(safeZoneCenter).setRadius(SAFE_RADIUS);
      else
        safeCircle = L.circle(safeZoneCenter, {
          radius: SAFE_RADIUS,
          color: COLOR_SAFE,
          fillColor: COLOR_SAFE,
          fillOpacity: 0.15,
        }).addTo(map);
    } else if (!active) {
      safeZoneCenter = null;
      if (safeCircle) {
        map.removeLayer(safeCircle);
        safeCircle = null;
      }
    }
  } catch (err) {
    console.error("onToggleSystem error", err);
    alert("Terjadi kesalahan saat mengubah status sistem. Lihat console.");
    toggle.checked = !active;
  } finally {
    // re-enable toggle
    const systemToggle = document.getElementById("system-toggle");
    if (systemToggle) systemToggle.disabled = false;
  }
}

// ========================================================
// === FUNGSI: toggle alarm (nyalakan/matikan alarm motor)
// ========================================================
async function onToggleAlarm(e) {
  const on = e.target.checked;
  try {
    const res = await fetch(`${API_BASE}/alarm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on }),
    });
    if (!res.ok) throw new Error("Gagal update alarm");
  } catch (err) {
    console.error(err);
    e.target.checked = !on;
    alert("Gagal mengubah status alarm (cek server).");
  }
}

// ========================================================
// === FUNGSI: trigger kamera (via endpoint server)
// ========================================================
async function triggerCamera() {
  const b = document.getElementById("btn-trigger");
  if (b) {
    b.disabled = true;
    b.textContent = "Mengirim trigger...";
  }
  try {
    const res = await fetch(`${API_BASE}/trigger-camera`, { method: "POST" });
    if (!res.ok) throw new Error("Gagal memicu kamera");
    alert("Kamera dipicu. Foto akan dikirim ke Telegram.");
  } catch (err) {
    alert("Gagal memicu kamera");
    console.error(err);
  } finally {
    if (b) {
      b.disabled = false;
      b.innerHTML = '<i class="fa-solid fa-camera"></i> Trigger Kamera';
    }
  }
}

// ========================================================
// === FUNGSI: update zona aman pakai posisi motor terkini
// ========================================================
function updateZoneFromMotor() {
  if (!lastData || !lastData.lat_raw) {
    alert("Data motor belum tersedia");
    return;
  }
  const lat = parseFloat(lastData.lat_raw),
    lon = parseFloat(lastData.lon_raw);
  if (safeCircle) safeCircle.setLatLng([lat, lon]);
  else
    safeCircle = L.circle([lat, lon], {
      radius: lastData.safe_radius || SAFE_RADIUS,
      color: COLOR_SAFE,
      fillOpacity: 0.12,
    }).addTo(map);
  alert("Zona aman diperbarui (frontend saja, belum tersimpan di server).");
}

// ========================================================
// === FUNGSI: inisialisasi Server-Sent Events (real-time update)
// ========================================================
function initSSE() {
  try {
    const evtSource = new EventSource(`${API_BASE}/events`);

    evtSource.addEventListener("system", (e) => {
      try {
        const data = JSON.parse(e.data);
        console.log("📡 SSE system", data);
        const toggle = document.getElementById("system-toggle");
        if (toggle) toggle.checked = !!data.active;
        // If server broadcasts system active=false -> remove safe circle on frontend as well
        if (!data.active) {
          safeZoneCenter = null;
          if (safeCircle) {
            map.removeLayer(safeCircle);
            safeCircle = null;
          }
        }
      } catch (err) {
        console.error("SSE system error", err);
      }
    });

    evtSource.addEventListener("alarm", (e) => {
      try {
        const data = JSON.parse(e.data);
        console.log("🔔 SSE alarm", data);
        const toggle = document.getElementById("alarm-toggle");
        if (toggle) toggle.checked = !!data.on;
      } catch (err) {
        console.error("SSE alarm error", err);
      }
    });

    evtSource.addEventListener("camera", (e) => {
      console.log("📸 SSE camera", e.data);
    });

    evtSource.addEventListener("location", (e) => {
      try {
        const data = JSON.parse(e.data);
        handleData(data);
      } catch (err) {
        console.error("SSE location error", err);
      }
    });

    evtSource.onerror = (err) =>
      console.warn("SSE connection lost, retrying...", err);
  } catch (e) {
    console.warn("SSE not available", e);
  }
}

// ========================================================
// === ENTRY POINT: jalankan init() saat halaman load
// ========================================================
window.addEventListener("load", init);
