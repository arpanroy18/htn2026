#include "nored_portal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_coexist.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

static const char *TAG = "nored_portal";

static bool (*g_broadcast)(const char *severity, const char *body, int64_t client_ms,
                           char *err, size_t err_len);
static httpd_handle_t g_server;

static const char PAGE_HEAD[] =
    "<!doctype html><html><head>"
    "<meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">"
    "<title>Nored</title></head>"
    "<body style=\"font-family:system-ui,sans-serif;margin:20px;max-width:28rem\">"
    "<h1 style=\"margin:0 0 8px\">Share to Nored</h1>";
static const char PAGE_TAIL[] =
    "<p style=\"color:#555\">You're on this badge. Type a message and it goes out over Bluetooth to nearby Nored phones.</p>"
    "<form method=post action=/broadcast onsubmit=\"this.ts.value=Date.now()\">"
    "<input type=hidden name=ts>"
    "<textarea name=body maxlength=280 required rows=5 "
    "style=\"width:100%;font-size:16px;box-sizing:border-box\" "
    "placeholder=\"What should everyone nearby know?\"></textarea>"
    "<p style=\"margin:12px 0\">"
    "<label><input type=radio name=severity value=INFO> INFO</label> "
    "<label><input type=radio name=severity value=HELP checked> HELP</label> "
    "<label><input type=radio name=severity value=DANGER> DANGER</label>"
    "</p>"
    "<button type=submit style=\"font-size:17px;padding:10px 18px\">Share</button>"
    "</form></body></html>";

static int hex_nibble(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static void url_decode(char *dst, size_t dst_len, const char *src, size_t src_len)
{
    size_t n = 0;
    for (size_t i = 0; i < src_len && n + 1 < dst_len; i++) {
        char c = src[i];
        if (c == '+') {
            dst[n++] = ' ';
        } else if (c == '%' && i + 2 < src_len) {
            int hi = hex_nibble(src[i + 1]);
            int lo = hex_nibble(src[i + 2]);
            if (hi >= 0 && lo >= 0) {
                dst[n++] = (char)((hi << 4) | lo);
                i += 2;
            }
        } else {
            dst[n++] = c;
        }
    }
    dst[n] = 0;
}

static bool form_field(const char *body, const char *key, char *out, size_t out_len)
{
    char pattern[24];
    snprintf(pattern, sizeof(pattern), "%s=", key);
    const char *p = strstr(body, pattern);
    if (!p) return false;
    p += strlen(pattern);
    const char *end = strchr(p, '&');
    size_t len = end ? (size_t)(end - p) : strlen(p);
    url_decode(out, out_len, p, len);
    return out[0] != 0;
}

static esp_err_t send_page(httpd_req_t *req, const char *note)
{
    char html[1400];
    size_t n = 0;
    n += (size_t)snprintf(html + n, sizeof(html) - n, "%s", PAGE_HEAD);
    if (note && note[0]) {
        n += (size_t)snprintf(html + n, sizeof(html) - n,
                              "<p style=\"background:#e8f4ff;padding:10px;border-radius:8px\"><b>%s</b></p>",
                              note);
    }
    n += (size_t)snprintf(html + n, sizeof(html) - n, "%s", PAGE_TAIL);
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Connection", "close");
    return httpd_resp_send(req, html, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t get_handler(httpd_req_t *req)
{
    return send_page(req, NULL);
}

static esp_err_t post_handler(httpd_req_t *req)
{
    char buf[640];
    int received = 0;
    while (received < req->content_len && received + 1 < (int)sizeof(buf)) {
        int n = httpd_req_recv(req, buf + received, sizeof(buf) - 1 - received);
        if (n <= 0) break;
        received += n;
    }
    buf[received] = 0;

    char body[281] = {0};
    char severity[12] = {0};
    form_field(buf, "body", body, sizeof(body));
    form_field(buf, "severity", severity, sizeof(severity));
    if (strcmp(severity, "INFO") && strcmp(severity, "HELP") && strcmp(severity, "DANGER")) {
        strncpy(severity, "HELP", sizeof(severity) - 1);
    }

    char ts_buf[24] = {0};
    int64_t client_ms = 0;
    form_field(buf, "ts", ts_buf, sizeof(ts_buf));
    if (ts_buf[0]) client_ms = strtoll(ts_buf, NULL, 10);

    char err[96] = {0};
    if (!g_broadcast) {
        return send_page(req, "Sharing is not ready yet.");
    }
    if (!g_broadcast(severity, body, client_ms, err, sizeof(err))) {
        return send_page(req, err[0] ? err : "Could not share.");
    }
    return send_page(req, err[0] ? err : "Shared. Nearby Nored phones will see it.");
}

static esp_err_t redirect_home(httpd_req_t *req)
{
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, NULL, 0);
}

static int dns_skip_name(const uint8_t *pkt, int len, int off)
{
    while (off < len) {
        uint8_t lab = pkt[off];
        if (lab == 0) return off + 1;
        if ((lab & 0xc0) == 0xc0) return off + 2;
        off += 1 + lab;
    }
    return -1;
}

static void dns_reply(int sock, const uint8_t *q, int qlen, const struct sockaddr_in *from, socklen_t fromlen,
                      bool with_a)
{
    uint8_t r[512];
    if (qlen > 400) qlen = 400;
    memcpy(r, q, (size_t)qlen);

    r[2] = 0x81;
    r[3] = 0x80;
    if (with_a) {
        r[6] = 0;
        r[7] = 1;
        int pos = qlen;
        r[pos++] = 0xc0;
        r[pos++] = 0x0c;
        r[pos++] = 0;
        r[pos++] = 1;
        r[pos++] = 0;
        r[pos++] = 1;
        r[pos++] = 0;
        r[pos++] = 0;
        r[pos++] = 0;
        r[pos++] = 30;
        r[pos++] = 0;
        r[pos++] = 4;
        r[pos++] = 192;
        r[pos++] = 168;
        r[pos++] = 4;
        r[pos++] = 1;
        sendto(sock, r, (size_t)pos, 0, (struct sockaddr *)from, fromlen);
    } else {
        r[6] = 0;
        r[7] = 0;
        sendto(sock, r, (size_t)qlen, 0, (struct sockaddr *)from, fromlen);
    }
}

static void dns_task(void *arg)
{
    (void)arg;
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) {
        ESP_LOGE(TAG, "dns socket failed");
        vTaskDelete(NULL);
        return;
    }

    int reuse = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

    struct timeval tv = {.tv_sec = 0, .tv_usec = 200000};
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(53),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(sock, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        ESP_LOGE(TAG, "dns bind failed");
        close(sock);
        vTaskDelete(NULL);
        return;
    }

    uint8_t q[512];
    while (true) {
        struct sockaddr_in from;
        socklen_t fromlen = sizeof(from);
        int n = recvfrom(sock, q, sizeof(q), 0, (struct sockaddr *)&from, &fromlen);
        if (n < 12) continue;
        if ((q[2] & 0x80) != 0) continue;

        int qend = dns_skip_name(q, n, 12);
        if (qend < 0 || qend + 4 > n) continue;
        uint16_t qtype = (uint16_t)((q[qend] << 8) | q[qend + 1]);
        dns_reply(sock, q, n, &from, fromlen, qtype == 1);
    }
}

static void portal_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (base != WIFI_EVENT) return;
    if (id == WIFI_EVENT_AP_STACONNECTED) {
        ESP_LOGI(TAG, "phone joined Wi-Fi");
    } else if (id == WIFI_EVENT_AP_STADISCONNECTED) {
        ESP_LOGI(TAG, "phone left Wi-Fi");
    }
}

static void register_uri(httpd_handle_t server, const char *uri, httpd_method_t method,
                         esp_err_t (*handler)(httpd_req_t *))
{
    httpd_uri_t route = {
        .uri = uri,
        .method = method,
        .handler = handler,
    };
    httpd_register_uri_handler(server, &route);
}

bool nored_portal_start(bool (*broadcast)(const char *severity, const char *body,
                                          int64_t client_ms, char *err, size_t err_len))
{
    g_broadcast = broadcast;

    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "netif init failed");
        return false;
    }
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "event loop failed");
        return false;
    }

    if (!esp_netif_create_default_wifi_ap()) {
        ESP_LOGE(TAG, "AP netif failed");
        return false;
    }

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    if (esp_wifi_init(&cfg) != ESP_OK) {
        ESP_LOGE(TAG, "wifi init failed");
        return false;
    }

    if (esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, portal_wifi_event, NULL) != ESP_OK) {
        ESP_LOGE(TAG, "wifi event register failed");
        return false;
    }
    esp_wifi_set_storage(WIFI_STORAGE_RAM);
    esp_coex_preference_set(ESP_COEX_PREFER_WIFI);

    wifi_config_t wifi_config = {0};
    strncpy((char *)wifi_config.ap.ssid, NORED_AP_SSID, sizeof(wifi_config.ap.ssid) - 1);
    wifi_config.ap.ssid_len = (uint8_t)strlen(NORED_AP_SSID);
    wifi_config.ap.channel = 1;
    wifi_config.ap.max_connection = 4;
    wifi_config.ap.authmode = WIFI_AUTH_OPEN;
    wifi_config.ap.pmf_cfg.required = false;
    wifi_config.ap.beacon_interval = 100;

    if (esp_wifi_set_mode(WIFI_MODE_AP) != ESP_OK ||
        esp_wifi_set_config(WIFI_IF_AP, &wifi_config) != ESP_OK ||
        esp_wifi_set_ps(WIFI_PS_NONE) != ESP_OK ||
        esp_wifi_start() != ESP_OK) {
        ESP_LOGE(TAG, "wifi AP start failed");
        return false;
    }

    httpd_config_t http = HTTPD_DEFAULT_CONFIG();
    http.max_open_sockets = 7;
    http.lru_purge_enable = true;
    http.stack_size = 6144;
    http.uri_match_fn = httpd_uri_match_wildcard;
    http.recv_wait_timeout = 3;
    http.send_wait_timeout = 3;
    http.backlog_conn = 5;

    if (httpd_start(&g_server, &http) != ESP_OK) {
        ESP_LOGE(TAG, "httpd failed");
        return false;
    }

    register_uri(g_server, "/", HTTP_GET, get_handler);
    register_uri(g_server, "/broadcast", HTTP_POST, post_handler);
    register_uri(g_server, "/hotspot-detect.html", HTTP_GET, get_handler);
    register_uri(g_server, "/library/test/success.html", HTTP_GET, get_handler);
    register_uri(g_server, "/generate_204", HTTP_GET, get_handler);
    register_uri(g_server, "/gen_204", HTTP_GET, get_handler);
    register_uri(g_server, "/*", HTTP_GET, redirect_home);

    if (xTaskCreate(dns_task, "dns", 3072, NULL, 6, NULL) != pdPASS) {
        ESP_LOGW(TAG, "dns task failed; open http://192.168.4.1/ manually");
    }

    ESP_LOGI(TAG, "portal ready on SSID %s", NORED_AP_SSID);
    return true;
}
