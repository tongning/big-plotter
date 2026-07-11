// Open Sauce plotter bridge (ESP32-S2 Mini).
//
// Serves the drawing web app from LittleFS, keeps the board state, and
// streams received gcode to the SKR 1.4 over UART with Marlin "ok" flow
// control. API matches server/server.py (the desktop mock).

#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>

#include <memory>

// ---------------- config ----------------

static const char *WIFI_SSID = "Anthony's iPhone";
static const char *WIFI_PASS = "choochootrain";
static const char *HOSTNAME  = "plotter"; // -> http://plotter.local
static const uint32_t WIFI_TIMEOUT_MS = 20000;

// Fallback access point if the hotspot can't be joined, so the exhibit
// is never stranded: connect to this network and use http://192.168.4.1
static const char *AP_SSID = "plotter-setup";
static const char *AP_PASS = "opensauce1";

// UART to the SKR 1.4 (TFT header). Any free GPIOs; keep in sync with wiring.
static const int PRINTER_TX_PIN = 17; // ESP TX -> SKR RX
static const int PRINTER_RX_PIN = 18; // ESP RX <- SKR TX
static const uint32_t PRINTER_BAUD = 115200;
static const uint32_t OK_TIMEOUT_MS = 10000;

// Board records live as comma-separated JSON objects (no wrapper), so
// GET /api/board can stream prefix + raw file + suffix without parsing.
static const char *BOARD_FILE = "/board.dat";
static const char *JOB_FILE = "/job.gcode";

// ---------------- gcode job state machine ----------------

enum JobState : uint8_t { JOB_IDLE, JOB_SEND, JOB_WAIT_OK };

static JobState jobState = JOB_IDLE;
static File jobFile;
static uint32_t jobLineNum = 0;
static uint32_t okDeadline = 0;
static bool okReceived = false;
static char jobError[96] = "";

static HardwareSerial &printer = Serial1;
static char rxBuf[160];
static size_t rxLen = 0;

static void startJob() {
  if (jobFile) jobFile.close();
  jobFile = LittleFS.open(JOB_FILE, "r");
  jobLineNum = 0;
  jobError[0] = '\0';
  okReceived = false;
  jobState = jobFile ? JOB_SEND : JOB_IDLE;
}

static void abortJob(const char *why) {
  snprintf(jobError, sizeof(jobError), "%s (line %u)", why, jobLineNum);
  Serial.printf("[job] aborted: %s\n", jobError);
  if (jobFile) jobFile.close();
  jobState = JOB_IDLE;
}

// Collect lines from the printer; flag Marlin's "ok" acks.
static void pumpPrinterRx() {
  while (printer.available()) {
    char c = (char)printer.read();
    if (c == '\n' || c == '\r') {
      if (rxLen > 0) {
        rxBuf[rxLen] = '\0';
        if (strncmp(rxBuf, "ok", 2) == 0) okReceived = true;
        Serial.printf("[printer] %s\n", rxBuf);
        rxLen = 0;
      }
    } else if (rxLen < sizeof(rxBuf) - 1) {
      rxBuf[rxLen++] = c;
    }
  }
}

static void pumpJob() {
  pumpPrinterRx();
  if (jobState == JOB_SEND) {
    while (true) {
      if (!jobFile.available()) { // done
        jobFile.close();
        jobState = JOB_IDLE;
        Serial.printf("[job] finished after %u lines\n", jobLineNum);
        return;
      }
      String line = jobFile.readStringUntil('\n');
      line.trim();
      jobLineNum++;
      if (line.length() == 0 || line[0] == ';') continue; // nothing to send
      printer.println(line);
      okReceived = false;
      okDeadline = millis() + OK_TIMEOUT_MS;
      jobState = JOB_WAIT_OK;
      return;
    }
  }
  if (jobState == JOB_WAIT_OK) {
    if (okReceived) {
      jobState = JOB_SEND;
    } else if ((int32_t)(millis() - okDeadline) > 0) {
      abortJob("printer not responding");
    }
  }
}

// ---------------- HTTP API ----------------

static AsyncWebServer server(80);

// POST /api/print and /api/command: body chunks stream to JOB_FILE, then
// the loop() state machine feeds it to the printer. Never blocks here.
static void gcodeBody(AsyncWebServerRequest *req, uint8_t *data, size_t len,
                      size_t index, size_t total) {
  if (jobState != JOB_IDLE) return; // request handler answers 409
  File f = LittleFS.open(JOB_FILE, index == 0 ? "w" : "a");
  if (f) {
    f.write(data, len);
    f.close();
  }
}

static void gcodeRequest(AsyncWebServerRequest *req) {
  if (jobState != JOB_IDLE) {
    req->send(409, "application/json", "{\"error\":\"busy\"}");
    return;
  }
  startJob();
  req->send(200, "application/json", "{\"ok\":true,\"queued\":true}");
}

struct BoardStream {
  File f;
  uint8_t phase = 0;
};

static void setupRoutes() {
  server.on("/api/board", HTTP_GET, [](AsyncWebServerRequest *req) {
    auto st = std::make_shared<BoardStream>();
    st->f = LittleFS.open(BOARD_FILE, "r");
    req->send(req->beginChunkedResponse("application/json",
      [st](uint8_t *buf, size_t maxLen, size_t index) -> size_t {
        if (st->phase == 0) {
          static const char prefix[] = "{\"drawings\":[";
          memcpy(buf, prefix, sizeof(prefix) - 1);
          st->phase = 1;
          return sizeof(prefix) - 1;
        }
        if (st->phase == 1) {
          if (st->f) {
            size_t n = st->f.read(buf, maxLen);
            if (n > 0) return n;
            st->f.close();
          }
          st->phase = 2;
        }
        if (st->phase == 2) {
          buf[0] = ']';
          buf[1] = '}';
          st->phase = 3;
          return 2;
        }
        return 0; // end of response
      }));
  });

  server.on("/api/board", HTTP_POST,
    [](AsyncWebServerRequest *req) {
      req->send(200, "application/json", "{\"ok\":true}");
    },
    nullptr,
    [](AsyncWebServerRequest *req, uint8_t *data, size_t len, size_t index,
       size_t total) {
      File f = LittleFS.open(BOARD_FILE, "a");
      if (!f) return;
      if (index == 0 && f.size() > 0) f.print(',');
      f.write(data, len);
      f.close();
    });

  server.on("/api/board", HTTP_DELETE, [](AsyncWebServerRequest *req) {
    LittleFS.remove(BOARD_FILE);
    req->send(200, "application/json", "{\"ok\":true}");
  });

  server.on("/api/print", HTTP_POST, gcodeRequest, nullptr, gcodeBody);
  server.on("/api/command", HTTP_POST, gcodeRequest, nullptr, gcodeBody);

  server.on("/api/status", HTTP_GET, [](AsyncWebServerRequest *req) {
    char buf[256];
    snprintf(buf, sizeof(buf),
             "{\"state\":\"%s\",\"line\":%u,\"error\":\"%s\","
             "\"ip\":\"%s\",\"rssi\":%d}",
             jobState == JOB_IDLE ? "idle" : "printing", jobLineNum, jobError,
             WiFi.localIP().toString().c_str(), WiFi.RSSI());
    req->send(200, "application/json", buf);
  });

  server.serveStatic("/", LittleFS, "/")
      .setDefaultFile("index.html")
      .setCacheControl("no-cache");

  server.onNotFound([](AsyncWebServerRequest *req) {
    req->send(404, "text/plain", "not found");
  });
}

// ---------------- setup ----------------

static void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);

  // Log visible networks: catches wrong-band hotspots and SSID mismatches
  // (iPhone hotspot names contain a curly apostrophe, not ASCII ').
  int n = WiFi.scanNetworks();
  for (int i = 0; i < n; i++) {
    Serial.printf("[wifi] seen: \"%s\" (ch %d, rssi %d)\n",
                  WiFi.SSID(i).c_str(), WiFi.channel(i), WiFi.RSSI(i));
  }

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  uint32_t deadline = millis() + WIFI_TIMEOUT_MS;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, IP: %s\n",
                  WiFi.localIP().toString().c_str());
  } else {
    Serial.printf("[wifi] FAILED to join %s -- starting fallback AP %s "
                  "(http://192.168.4.1)\n", WIFI_SSID, AP_SSID);
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
  }
  if (MDNS.begin(HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.printf("[wifi] mDNS: http://%s.local\n", HOSTNAME);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1500); // let USB CDC come up so early logs are visible

  if (!LittleFS.begin(true)) {
    Serial.println("[fs] LittleFS mount failed");
  }
  printer.begin(PRINTER_BAUD, SERIAL_8N1, PRINTER_RX_PIN, PRINTER_TX_PIN);

  connectWifi();
  setupRoutes();
  server.begin();
  Serial.println("[http] server started");
}

void loop() {
  pumpJob();
}
