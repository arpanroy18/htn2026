#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "driver/rmt_tx.h"
#include "esp_log.h"
#include "esp_random.h"
#include "nvs_flash.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "nored_display.h"

static const char *TAG = "nored_badge";

#define MAX_CONNS 2
#define MAX_NAME 40
#define MAX_ID 40
#define MAX_PACKET 2048
/*
 * Dedup rings. Phones dedup by packet id for the packet's lifetime; the badge keeps two
 * RAM rings instead:
 *   SEEN_CAP        every relayed packet id (texts, acks, games...) - stops relay loops
 *   ALERT_SEEN_CAP  alert ids that were shown - high-volume chat/game traffic can no
 *                   longer evict an alert and let a relayed copy repaint the screen
 * Both rings are reported in the mesh-inventory reply so phones stop re-sending them.
 * The phone caps an inventory page at 50 ids (protocol.ts), so SEEN_CAP + ALERT_SEEN_CAP <= 50.
 */
#define SEEN_CAP 32
#define ALERT_SEEN_CAP 16
#define PACKET_MAGIC 0x4E
#define LED_GPIO 3
#define LED_COUNT 6
#define LED_RESOLUTION_HZ 10000000
#define MAX_ALERT_BODY NORED_ALERT_MAX_BODY
#define ALERT_QUEUE_DEPTH 8
/* Mirrors ALERT_BURST_COPIES in nored/src/mesh/protocol.ts. */
#define ALERT_BURST_COPIES 3

/*
 * Canonical Nored UUIDs (same strings as the phone app):
 *   6e4f5245-442d-4d45-5348-00000000000{1,2,3,4}
 * BLE_UUID128_INIT is little-endian: reverse the UUID string bytes.
 * The previous encoding used mixed RFC-4122 field endianness, so phones
 * never matched the service and listed the badge as generic Bluetooth.
 */
#define NORED_UUID128(n) BLE_UUID128_INIT( \
    (n), 0x00, 0x00, 0x00, 0x00, 0x00, 0x48, 0x53, \
    0x45, 0x4d, 0x2d, 0x44, 0x45, 0x52, 0x4f, 0x6e)
static const ble_uuid128_t uuid_svc = NORED_UUID128(0x01);
static const ble_uuid128_t uuid_identity = NORED_UUID128(0x02);
static const ble_uuid128_t uuid_rx = NORED_UUID128(0x03);
static const ble_uuid128_t uuid_tx = NORED_UUID128(0x04);

static uint16_t h_identity;
static uint16_t h_rx;
static uint16_t h_tx;
static uint8_t own_addr_type;

static char local_id[MAX_ID];
static char local_name[MAX_NAME + 1] = "Nored Badge";
static char identity_json[192];
static rmt_channel_handle_t led_channel;
static rmt_encoder_handle_t led_encoder;
static QueueHandle_t alert_queue;
static uint8_t gatt_rx_buf[MAX_PACKET + 4];

typedef struct {
    nored_alert_severity_t severity;
    char sender[MAX_NAME + 1];
    char body[MAX_ALERT_BODY + 1];
} alert_event_t;

typedef struct {
    uint16_t conn;
    bool used;
    bool tx_notify;
    bool hello_pending; /* Phone said hello before it subscribed to TX; answer on subscribe. */
    uint16_t mtu;
    char id[MAX_ID];
    char name[MAX_NAME + 1];
    uint8_t total;
    uint8_t got;
    uint16_t len;
    uint16_t chunk; /* Payload bytes per frame, learned from frame 0 of the current packet. */
    uint8_t parts_mask[32];
    uint8_t packet[MAX_PACKET];
} link_t;

static link_t links[MAX_CONNS];
static char seen_ids[SEEN_CAP][MAX_ID];
static uint8_t seen_head;
static char alert_seen_ids[ALERT_SEEN_CAP][MAX_ID];
static uint8_t alert_seen_head;
/* Inventory reply: header + up to 48 quoted ids (~2.2 KB); static so the host task stack stays small. */
static char inventory_json[2560];

static const rmt_symbol_word_t ws2812_zero = {
    .level0 = 1,
    .duration0 = 3,
    .level1 = 0,
    .duration1 = 9,
};

static const rmt_symbol_word_t ws2812_one = {
    .level0 = 1,
    .duration0 = 9,
    .level1 = 0,
    .duration1 = 3,
};

static const rmt_symbol_word_t ws2812_reset = {
    .level0 = 0,
    .duration0 = 250,
    .level1 = 0,
    .duration1 = 250,
};

static size_t led_encoder_callback(const void *data, size_t data_size,
                                   size_t symbols_written, size_t symbols_free,
                                   rmt_symbol_word_t *symbols, bool *done, void *arg)
{
    (void)arg;
    if (symbols_free < 8) return 0;

    size_t data_pos = symbols_written / 8;
    const uint8_t *bytes = data;
    if (data_pos < data_size) {
        size_t symbol_pos = 0;
        for (int bit = 0x80; bit != 0; bit >>= 1) {
            symbols[symbol_pos++] = (bytes[data_pos] & bit) ? ws2812_one : ws2812_zero;
        }
        return symbol_pos;
    }

    symbols[0] = ws2812_reset;
    *done = true;
    return 1;
}

static void led_write(const uint8_t *pixels)
{
    rmt_transmit_config_t config = {.loop_count = 0};
    ESP_ERROR_CHECK(rmt_transmit(led_channel, led_encoder, pixels, LED_COUNT * 3, &config));
    ESP_ERROR_CHECK(rmt_tx_wait_all_done(led_channel, pdMS_TO_TICKS(100)));
}

static void led_set_all(uint8_t red, uint8_t green, uint8_t blue)
{
    uint8_t pixels[LED_COUNT * 3];
    for (int i = 0; i < LED_COUNT; i++) {
        pixels[i * 3] = green;
        pixels[i * 3 + 1] = red;
        pixels[i * 3 + 2] = blue;
    }
    led_write(pixels);
}

static void led_show_ready(void)
{
    uint8_t pixels[LED_COUNT * 3] = {0};
    pixels[2] = 5; /* Upper-left LED, dim blue: Nored firmware is running. */
    led_write(pixels);
}

static void alert_task(void *param)
{
    (void)param;
    alert_event_t alert;
    while (true) {
        if (xQueueReceive(alert_queue, &alert, portMAX_DELAY) != pdTRUE) continue;

        nored_display_alert(alert.severity, alert.sender, alert.body);

        uint8_t red = 20;
        uint8_t green = 16;
        uint8_t blue = 0;
        if (alert.severity == NORED_ALERT_HELP) {
            red = 28;
            green = 7;
        } else if (alert.severity == NORED_ALERT_DANGER) {
            red = 32;
            green = 0;
        }
        for (int flash = 0; flash < 3; flash++) {
            led_set_all(red, green, blue);
            vTaskDelay(pdMS_TO_TICKS(220));
            led_show_ready();
            vTaskDelay(pdMS_TO_TICKS(180));
        }
    }
}

static void init_alert_leds(void)
{
    rmt_tx_channel_config_t channel_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .gpio_num = LED_GPIO,
        .mem_block_symbols = 64,
        .resolution_hz = LED_RESOLUTION_HZ,
        .trans_queue_depth = 4,
    };
    ESP_ERROR_CHECK(rmt_new_tx_channel(&channel_config, &led_channel));

    rmt_simple_encoder_config_t encoder_config = {
        .callback = led_encoder_callback,
    };
    ESP_ERROR_CHECK(rmt_new_simple_encoder(&encoder_config, &led_encoder));
    ESP_ERROR_CHECK(rmt_enable(led_channel));
    led_show_ready();

    alert_queue = xQueueCreate(ALERT_QUEUE_DEPTH, sizeof(alert_event_t));
    ESP_ERROR_CHECK(alert_queue ? ESP_OK : ESP_ERR_NO_MEM);
    BaseType_t created = xTaskCreate(alert_task, "alert", 4096, NULL, 4, NULL);
    ESP_ERROR_CHECK(created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
}

static link_t *link_by_conn(uint16_t conn)
{
    for (int i = 0; i < MAX_CONNS; i++) {
        if (links[i].used && links[i].conn == conn) return &links[i];
    }
    return NULL;
}

static link_t *link_alloc(uint16_t conn)
{
    link_t *existing = link_by_conn(conn);
    if (existing) return existing;
    for (int i = 0; i < MAX_CONNS; i++) {
        if (!links[i].used) {
            memset(&links[i], 0, sizeof(links[i]));
            links[i].used = true;
            links[i].conn = conn;
            links[i].mtu = 23;
            return &links[i];
        }
    }
    return NULL;
}

static void link_free(uint16_t conn)
{
    link_t *link = link_by_conn(conn);
    if (link) memset(link, 0, sizeof(*link));
}

static void refresh_identity_json(void)
{
    snprintf(identity_json, sizeof(identity_json),
             "{\"v\":2,\"id\":\"%s\",\"name\":\"%s\",\"avatarIcon\":\"panda\",\"avatarColor\":3}",
             local_id, local_name);
}

/* Copies the JSON string value for `key`, decoding escapes, so a quote or newline inside an
 * alert body no longer truncates it. Stops at the first unescaped quote. */
static bool json_string_field(const char *json, const char *key, char *out, size_t out_len)
{
    char pattern[24];
    snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
    const char *p = strstr(json, pattern);
    if (!p || out_len == 0) return false;
    p += strlen(pattern);
    size_t n = 0;
    while (*p && *p != '"' && n + 1 < out_len) {
        char c = *p++;
        if (c == '\\' && *p) {
            char e = *p++;
            switch (e) {
            case 'n': case 'r': case 't': c = ' '; break;
            case 'u':
                /* \uXXXX: skip the hex digits, emit a placeholder the 8x8 font can draw. */
                for (int i = 0; i < 4 && *p; i++) p++;
                c = '?';
                break;
            default: c = e; break; /* \" \\ \/ */
            }
        }
        out[n++] = c;
    }
    out[n] = 0;
    return n > 0;
}

/* Returns true when `id` was already in the ring; otherwise records it. */
static bool ring_seen(char ring[][MAX_ID], int cap, uint8_t *head, const char *id)
{
    if (!id[0]) return false;
    for (int i = 0; i < cap; i++) {
        if (strcmp(ring[i], id) == 0) return true;
    }
    strncpy(ring[*head], id, MAX_ID - 1);
    ring[*head][MAX_ID - 1] = 0;
    *head = (uint8_t)((*head + 1) % cap);
    return false;
}

static bool seen_packet(const char *id)
{
    return ring_seen(seen_ids, SEEN_CAP, &seen_head, id);
}

static bool seen_alert(const char *id)
{
    return ring_seen(alert_seen_ids, ALERT_SEEN_CAP, &alert_seen_head, id);
}

static bool inventory_safe_id(const char *id)
{
    /* Phone validator accepts [A-Za-z0-9:_-]; one odd id would void the whole page. */
    for (const char *p = id; *p; p++) {
        char c = *p;
        bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                  c == ':' || c == '_' || c == '-';
        if (!ok) return false;
    }
    return id[0] != 0;
}

/* Appends every id we hold, so a reconnecting phone marks us as a carrier instead of
 * replaying its whole store (which is how an old alert used to repaint the screen). */
static size_t append_ring_ids(char *out, size_t cap, size_t pos, char ring[][MAX_ID], int n, bool *first)
{
    for (int i = 0; i < n; i++) {
        if (!inventory_safe_id(ring[i])) continue;
        int wrote = snprintf(out + pos, cap > pos ? cap - pos : 0, "%s\"%s\"", *first ? "" : ",", ring[i]);
        if (wrote < 0 || pos + (size_t)wrote >= cap) break;
        pos += (size_t)wrote;
        *first = false;
    }
    return pos;
}

static int gap_event(struct ble_gap_event *event, void *arg);

static void advertise(void)
{
    struct ble_gap_adv_params adv = {0};
    struct ble_hs_adv_fields fields = {0};

    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.uuids128 = &uuid_svc;
    fields.num_uuids128 = 1;
    fields.uuids128_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv fields rc=%d", rc);
        return;
    }

    /* 128-bit UUID fills the adv PDU; name + UUID again in the scan response. */
    struct ble_hs_adv_fields rsp = {0};
    rsp.name = (const uint8_t *)"nored-badge";
    rsp.name_len = 11;
    rsp.name_is_complete = 1;
    rsp.uuids128 = &uuid_svc;
    rsp.num_uuids128 = 1;
    rsp.uuids128_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        memset(&rsp, 0, sizeof(rsp));
        rsp.name = (const uint8_t *)"nored-badge";
        rsp.name_len = 11;
        rsp.name_is_complete = 1;
        rc = ble_gap_adv_rsp_set_fields(&rsp);
        if (rc != 0) {
            ESP_LOGW(TAG, "scan rsp name rc=%d", rc);
        }
    }

    adv.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv.disc_mode = BLE_GAP_DISC_MODE_GEN;
    adv.itvl_min = 0x20;
    adv.itvl_max = 0x40;
    rc = ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &adv, gap_event, NULL);
    if (rc != 0 && rc != BLE_HS_EALREADY) {
        ESP_LOGE(TAG, "adv start rc=%d", rc);
    } else {
        ESP_LOGI(TAG, "advertising Nored service");
    }
}

static uint16_t payload_mtu(const link_t *link)
{
    uint16_t att = link->mtu > 6 ? link->mtu : 23;
    uint16_t payload = att - 6;
    return payload < 1 ? 1 : payload;
}

static int notify_bytes(uint16_t conn, uint16_t attr, const uint8_t *data, uint16_t len)
{
    struct os_mbuf *om = ble_hs_mbuf_from_flat(data, len);
    if (!om) return BLE_HS_ENOMEM;
    int rc = ble_gatts_notify_custom(conn, attr, om);
    if (rc != 0) {
        ESP_LOGW(TAG, "notify rc=%d conn=%u", rc, conn);
    }
    return rc;
}

static void send_wire_json(link_t *dest, const char *json)
{
    if (!dest || !dest->tx_notify) return;
    uint16_t len = (uint16_t)strlen(json);
    uint16_t chunk = payload_mtu(dest);
    uint16_t total = (uint16_t)((len + chunk - 1) / chunk);
    for (uint16_t seq = 0; seq < total; seq++) {
        uint16_t start = seq * chunk;
        uint16_t part = (start + chunk > len) ? (len - start) : chunk;
        uint8_t frame[256];
        frame[0] = PACKET_MAGIC;
        frame[1] = (uint8_t)seq;
        frame[2] = (uint8_t)total;
        memcpy(frame + 3, json + start, part);
        notify_bytes(dest->conn, h_tx, frame, (uint16_t)(part + 3));
        vTaskDelay(pdMS_TO_TICKS(8));
    }
}

static uint32_t inventory_session;

/* Completes the phone handshake: hello reply, then one inventory page listing what we hold.
 * The phone will not relay anything to us until it has seen both. */
static void send_hello_reply(link_t *link)
{
    if (!link->id[0]) return;
    if (!link->tx_notify) {
        link->hello_pending = true; /* Sent from the SUBSCRIBE event instead of dropped. */
        return;
    }
    link->hello_pending = false;

    char hello[192];
    snprintf(hello, sizeof(hello),
             "{\"version\":1,\"senderId\":\"%s\",\"recipientId\":\"%s\","
             "\"type\":\"mesh-hello\",\"reply\":true}",
             local_id, link->id);
    send_wire_json(link, hello);

    size_t pos = (size_t)snprintf(inventory_json, sizeof(inventory_json),
             "{\"version\":1,\"senderId\":\"%s\",\"recipientId\":\"%s\","
             "\"type\":\"mesh-inventory\",\"session\":\"badge-%" PRIu32 "\",\"page\":0,"
             "\"last\":true,\"ids\":[",
             local_id, link->id, ++inventory_session);
    bool first = true;
    pos = append_ring_ids(inventory_json, sizeof(inventory_json) - 3, pos, seen_ids, SEEN_CAP, &first);
    pos = append_ring_ids(inventory_json, sizeof(inventory_json) - 3, pos, alert_seen_ids, ALERT_SEEN_CAP, &first);
    snprintf(inventory_json + pos, sizeof(inventory_json) - pos, "]}");
    send_wire_json(link, inventory_json);
    ESP_LOGI(TAG, "mesh session ready with %s", link->id);
}

static void reply_to_hello(link_t *link, const char *payload)
{
    if (!strstr(payload, "\"type\":\"mesh-hello\"")) return;

    char sender_id[MAX_ID] = {0};
    if (!json_string_field(payload, "senderId", sender_id, sizeof(sender_id))) return;
    if (!link->id[0]) strncpy(link->id, sender_id, MAX_ID - 1);
    send_hello_reply(link);
}

static const char *alert_json_root(const char *payload)
{
    if (!strstr(payload, "\"type\":\"mesh-data\"")) {
        return payload;
    }
    const char *packet = strstr(payload, "\"packet\":");
    return packet ? packet : payload;
}

static void peer_name_for_id(const char *id, char *out, size_t out_len)
{
    if (!out_len) return;
    out[0] = 0;
    if (!id[0]) return;
    for (int i = 0; i < MAX_CONNS; i++) {
        if (links[i].used && strcmp(links[i].id, id) == 0 && links[i].name[0]) {
            strncpy(out, links[i].name, out_len - 1);
            out[out_len - 1] = 0;
            return;
        }
    }
    strncpy(out, id, out_len - 1);
    out[out_len - 1] = 0;
}

static void receive_alert(const char *payload)
{
    const char *json = alert_json_root(payload);
    if (!strstr(json, "\"type\":\"alert\"")) return;

    /* Same alert id, whether it arrives as a raw legacy packet, a mesh-data envelope, or a
     * replay after reconnect: paint the screen once. */
    char alert_id[MAX_ID] = {0};
    if (json_string_field(json, "id", alert_id, sizeof(alert_id)) && seen_alert(alert_id)) {
        ESP_LOGI(TAG, "alert %s already shown", alert_id);
        return;
    }

    alert_event_t alert = {0};
    alert.severity = NORED_ALERT_INFO;
    if (strstr(json, "\"severity\":\"DANGER\"")) {
        alert.severity = NORED_ALERT_DANGER;
    } else if (strstr(json, "\"severity\":\"HELP\"")) {
        alert.severity = NORED_ALERT_HELP;
    }

    char sender_id[MAX_ID] = {0};
    if (json_string_field(json, "senderId", sender_id, sizeof(sender_id))) {
        peer_name_for_id(sender_id, alert.sender, sizeof(alert.sender));
    } else {
        strncpy(alert.sender, "Unknown", sizeof(alert.sender) - 1);
    }

    if (!json_string_field(json, "body", alert.body, sizeof(alert.body))) {
        strncpy(alert.body, "(no message)", sizeof(alert.body) - 1);
    }

    if (alert_queue && xQueueSend(alert_queue, &alert, 0) == pdTRUE) {
        ESP_LOGI(TAG, "alert from %s: %s", alert.sender, alert.body);
    } else {
        ESP_LOGW(TAG, "alert queue full; dropped %s", alert_id);
    }
}

static void acknowledge_packet(link_t *link, const char *packet_id)
{
    if (!link->id[0] || !packet_id[0]) return;
    char receipt[256];
    snprintf(receipt, sizeof(receipt),
             "{\"version\":1,\"senderId\":\"%s\",\"recipientId\":\"%s\","
             "\"type\":\"mesh-receipt\",\"packetId\":\"%s\"}",
             local_id, link->id, packet_id);
    send_wire_json(link, receipt);
}

static void forward_packet(link_t *from, const uint8_t *payload, uint16_t len)
{
    reply_to_hello(from, (const char *)payload);
    if (strstr((const char *)payload, "\"type\":\"mesh-hello\"") ||
        strstr((const char *)payload, "\"type\":\"mesh-inventory\"") ||
        strstr((const char *)payload, "\"type\":\"mesh-receipt\"")) {
        return;
    }

    char pkt_id[MAX_ID] = {0};
    json_string_field((const char *)payload, "id", pkt_id, sizeof(pkt_id));
    if (seen_packet(pkt_id)) {
        ESP_LOGI(TAG, "drop duplicate %s", pkt_id);
        return;
    }
    acknowledge_packet(from, pkt_id);
    receive_alert((const char *)payload);

    for (int i = 0; i < MAX_CONNS; i++) {
        link_t *dest = &links[i];
        if (!dest->used || dest->conn == from->conn || !dest->tx_notify) continue;
        uint16_t chunk = payload_mtu(dest);
        uint16_t total = (uint16_t)((len + chunk - 1) / chunk);
        if (total < 1) total = 1;
        if (total > 255) {
            ESP_LOGW(TAG, "packet too large for hop");
            continue;
        }
        int copies = strstr((const char *)payload, "\"type\":\"alert\"") ? ALERT_BURST_COPIES : 1;
        for (int copy = 0; copy < copies; copy++) {
            for (uint16_t seq = 0; seq < total; seq++) {
                uint16_t start = seq * chunk;
                uint16_t part = (start + chunk > len) ? (len - start) : chunk;
                uint8_t frame[256];
                if (part > sizeof(frame) - 3) part = sizeof(frame) - 3;
                frame[0] = PACKET_MAGIC;
                frame[1] = (uint8_t)seq;
                frame[2] = (uint8_t)total;
                memcpy(frame + 3, payload + start, part);
                notify_bytes(dest->conn, h_tx, frame, (uint16_t)(3 + part));
                vTaskDelay(pdMS_TO_TICKS(8));
            }
        }
        ESP_LOGI(TAG, "forwarded %u bytes to conn %u", len, dest->conn);
    }
}

static void ingest_frame(link_t *link, const uint8_t *data, uint16_t len)
{
    if (len < 3 || data[0] != PACKET_MAGIC) return;
    uint8_t seq = data[1];
    uint8_t total = data[2];
    if (total == 0 || seq >= total) return;
    uint16_t part = (uint16_t)(len - 3);

    /* Frame 0 always starts a new packet; every frame but the last carries the same number
     * of payload bytes, so frame 0 tells us the sender's chunk size. Using our own MTU guess
     * here used to scatter frames at the wrong offsets whenever the phone had a larger MTU. */
    if (seq == 0 || link->total != total) {
        if (seq != 0) return; /* Mid-packet without its start: wait for the next packet. */
        memset(link->parts_mask, 0, sizeof(link->parts_mask));
        link->total = total;
        link->got = 0;
        link->len = 0;
        link->chunk = part > 0 ? part : payload_mtu(link);
    }
    if (link->chunk == 0) return;

    uint16_t offset = (uint16_t)(seq * link->chunk);
    if (offset + part >= MAX_PACKET) return;
    memcpy(link->packet + offset, data + 3, part);
    if (offset + part > link->len) link->len = (uint16_t)(offset + part);
    if ((link->parts_mask[seq / 8] & (1u << (seq % 8))) == 0) {
        link->parts_mask[seq / 8] |= (uint8_t)(1u << (seq % 8));
        link->got++;
    }
    if (link->got >= total) {
        link->packet[link->len < MAX_PACKET ? link->len : MAX_PACKET - 1] = 0;
        ESP_LOGI(TAG, "assembled %u bytes from conn %u", link->len, link->conn);
        forward_packet(link, link->packet, link->len);
        link->total = 0;
        link->got = 0;
        link->len = 0;
        link->chunk = 0;
    }
}

static int gatt_access(uint16_t conn_handle, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)arg;
    link_t *link = link_by_conn(conn_handle);
    if (!link) link = link_alloc(conn_handle);

    if (attr_handle == h_identity && ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        int rc = os_mbuf_append(ctxt->om, identity_json, strlen(identity_json));
        return rc == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }

    if (attr_handle == h_rx && ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
        uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
        if (len >= sizeof(gatt_rx_buf)) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        int rc = ble_hs_mbuf_to_flat(ctxt->om, gatt_rx_buf, len, &len);
        if (rc != 0) return BLE_ATT_ERR_UNLIKELY;

        if (len >= 3 && gatt_rx_buf[0] == PACKET_MAGIC) {
            if (link) ingest_frame(link, gatt_rx_buf, len);
            return 0;
        }

        gatt_rx_buf[len] = 0;
        char id[MAX_ID] = {0};
        char name[MAX_NAME + 1] = {0};
        if (link && json_string_field((char *)gatt_rx_buf, "id", id, sizeof(id))) {
            json_string_field((char *)gatt_rx_buf, "name", name, sizeof(name));
            strncpy(link->id, id, MAX_ID - 1);
            strncpy(link->name, name[0] ? name : "Nored", MAX_NAME);
            ESP_LOGI(TAG, "peer %s (%s) on conn %u", link->name, link->id, conn_handle);
        }
        return 0;
    }

    return BLE_ATT_ERR_UNLIKELY;
}

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &uuid_svc.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = &uuid_identity.u,
                .access_cb = gatt_access,
                .val_handle = &h_identity,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
            },
            {
                .uuid = &uuid_rx.u,
                .access_cb = gatt_access,
                .val_handle = &h_rx,
                .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            {
                .uuid = &uuid_tx.u,
                .access_cb = gatt_access,
                .val_handle = &h_tx,
                .flags = BLE_GATT_CHR_F_NOTIFY,
            },
            {0},
        },
    },
    {0},
};

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            link_t *link = link_alloc(event->connect.conn_handle);
            ESP_LOGI(TAG, "connect %u %s", event->connect.conn_handle, link ? "ok" : "full");
            if (!link) {
                ble_gap_terminate(event->connect.conn_handle, BLE_ERR_CONN_LIMIT);
            }
        } else {
            ESP_LOGW(TAG, "connect fail status=%d", event->connect.status);
        }
        advertise();
        return 0;
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "disconnect %u reason=%d", event->disconnect.conn.conn_handle,
                 event->disconnect.reason);
        link_free(event->disconnect.conn.conn_handle);
        advertise();
        return 0;
    case BLE_GAP_EVENT_MTU:
        {
            link_t *link = link_by_conn(event->mtu.conn_handle);
            if (link) link->mtu = event->mtu.value;
            ESP_LOGI(TAG, "mtu %u conn %u", event->mtu.value, event->mtu.conn_handle);
        }
        return 0;
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (event->subscribe.attr_handle == h_tx) {
            link_t *link = link_by_conn(event->subscribe.conn_handle);
            if (link) link->tx_notify = event->subscribe.cur_notify;
            ESP_LOGI(TAG, "tx notify conn %u = %d", event->subscribe.conn_handle,
                     event->subscribe.cur_notify);
            /* The phone's hello often lands before this subscribe. Answering now (instead of
             * losing the reply) keeps the phone from waiting 2s+ in legacy mode. */
            if (link && link->tx_notify && link->hello_pending) send_hello_reply(link);
        }
        if (event->subscribe.attr_handle == h_identity && event->subscribe.cur_notify) {
            notify_bytes(event->subscribe.conn_handle, h_identity,
                         (const uint8_t *)identity_json, strlen(identity_json));
        }
        return 0;
    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        return 0;
    default:
        return 0;
    }
}

static void on_sync(void)
{
    int rc = ble_hs_id_infer_auto(0, &own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "addr infer rc=%d", rc);
        return;
    }
    uint8_t addr[6];
    ble_hs_id_copy_addr(own_addr_type, addr, NULL);
    ESP_LOGI(TAG, "BLE addr %02x:%02x:%02x:%02x:%02x:%02x",
             addr[5], addr[4], addr[3], addr[2], addr[1], addr[0]);
    ESP_LOGI(TAG, "Nored identity uuid=%s name=%s", local_id, local_name);
    advertise();
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "nimble reset %d", reason);
}

static void host_task(void *param)
{
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

static void load_identity(void)
{
    nvs_handle_t nvs;
    if (nvs_open("nored", NVS_READWRITE, &nvs) != ESP_OK) return;
    size_t len = sizeof(local_id);
    if (nvs_get_str(nvs, "id", local_id, &len) != ESP_OK || local_id[0] == 0) {
        uint8_t raw[16];
        esp_fill_random(raw, sizeof(raw));
        snprintf(local_id, sizeof(local_id),
                 "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                 raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
                 raw[8], raw[9], raw[10], raw[11], raw[12], raw[13], raw[14], raw[15]);
        nvs_set_str(nvs, "id", local_id);
        nvs_commit(nvs);
    }
    nvs_close(nvs);
    refresh_identity_json();
}

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    load_identity();
    if (!nored_display_init()) {
        ESP_LOGW(TAG, "display init failed; LEDs only");
    }
    init_alert_leds();
    ESP_ERROR_CHECK(nimble_port_init());

    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.sm_bonding = 0;
    ble_hs_cfg.sm_sc = 0;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    int rc = ble_gatts_count_cfg(gatt_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "gatts count rc=%d", rc);
        return;
    }
    rc = ble_gatts_add_svcs(gatt_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "gatts add rc=%d", rc);
        return;
    }
    ble_svc_gap_device_name_set("nored-badge");

    nimble_port_freertos_init(host_task);
    ESP_LOGI(TAG, "Nored 2-link GATT router ready");
    ESP_LOGI(TAG, "Look for GAP name nored-badge; identity uuid=%s", local_id);
}
