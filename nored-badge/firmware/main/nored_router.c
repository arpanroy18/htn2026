#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
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

static const char *TAG = "nored_badge";

#define MAX_CONNS 2
#define MAX_NAME 40
#define MAX_ID 40
#define MAX_PACKET 2048
#define SEEN_CAP 24
#define PACKET_MAGIC 0x4E

/* 6e4f5245-442d-4d45-5348-00000000000{1,2,3,4}  (nored-mesh) */
static const ble_uuid128_t uuid_svc = BLE_UUID128_INIT(
    0x45, 0x52, 0x4f, 0x6e, 0x2d, 0x44, 0x45, 0x4d,
    0x53, 0x48, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01);
static const ble_uuid128_t uuid_identity = BLE_UUID128_INIT(
    0x45, 0x52, 0x4f, 0x6e, 0x2d, 0x44, 0x45, 0x4d,
    0x53, 0x48, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02);
static const ble_uuid128_t uuid_rx = BLE_UUID128_INIT(
    0x45, 0x52, 0x4f, 0x6e, 0x2d, 0x44, 0x45, 0x4d,
    0x53, 0x48, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03);
static const ble_uuid128_t uuid_tx = BLE_UUID128_INIT(
    0x45, 0x52, 0x4f, 0x6e, 0x2d, 0x44, 0x45, 0x4d,
    0x53, 0x48, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04);

static uint16_t h_identity;
static uint16_t h_rx;
static uint16_t h_tx;
static uint8_t own_addr_type;

static char local_id[MAX_ID];
static char local_name[MAX_NAME + 1] = "Nored Badge";
static char identity_json[128];

typedef struct {
    uint16_t conn;
    bool used;
    bool tx_notify;
    uint16_t mtu;
    char id[MAX_ID];
    char name[MAX_NAME + 1];
    uint8_t total;
    uint8_t got;
    uint16_t len;
    uint8_t parts_mask[32];
    uint8_t packet[MAX_PACKET];
} link_t;

static link_t links[MAX_CONNS];
static char seen_ids[SEEN_CAP][MAX_ID];
static uint8_t seen_head;

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
             "{\"v\":1,\"id\":\"%s\",\"name\":\"%s\"}", local_id, local_name);
}

static bool json_string_field(const char *json, const char *key, char *out, size_t out_len)
{
    char pattern[24];
    snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
    const char *start = strstr(json, pattern);
    if (!start) return false;
    start += strlen(pattern);
    size_t n = 0;
    while (start[n] && start[n] != '"' && n + 1 < out_len) {
        out[n] = start[n];
        n++;
    }
    out[n] = 0;
    return n > 0;
}

static bool seen_packet(const char *id)
{
    if (!id[0]) return false;
    for (int i = 0; i < SEEN_CAP; i++) {
        if (strcmp(seen_ids[i], id) == 0) return true;
    }
    strncpy(seen_ids[seen_head], id, MAX_ID - 1);
    seen_head = (seen_head + 1) % SEEN_CAP;
    return false;
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

    /* 128-bit UUID fills the adv PDU; put the name in the scan response. */
    struct ble_hs_adv_fields rsp = {0};
    rsp.name = (const uint8_t *)"nored-badge";
    rsp.name_len = 11;
    rsp.name_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGW(TAG, "scan rsp name rc=%d", rc);
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

static void notify_identity_value(link_t *dest, const char *json)
{
    notify_bytes(dest->conn, h_identity, (const uint8_t *)json, strlen(json));
}

static void publish_peer_identities(void)
{
    link_t *a = NULL;
    link_t *b = NULL;
    for (int i = 0; i < MAX_CONNS; i++) {
        if (links[i].used && links[i].id[0]) {
            if (!a) a = &links[i];
            else if (!b) b = &links[i];
        }
    }
    if (!a || !b) return;

    char json_a[128];
    char json_b[128];
    snprintf(json_a, sizeof(json_a), "{\"v\":1,\"id\":\"%s\",\"name\":\"%s\"}", a->id, a->name[0] ? a->name : "Nored");
    snprintf(json_b, sizeof(json_b), "{\"v\":1,\"id\":\"%s\",\"name\":\"%s\"}", b->id, b->name[0] ? b->name : "Nored");
    /* Each phone should see the other phone's identity on this GATT link. */
    notify_identity_value(a, json_b);
    notify_identity_value(b, json_a);
    ESP_LOGI(TAG, "bridged identities %s <-> %s", a->id, b->id);
}

static void forward_packet(link_t *from, const uint8_t *payload, uint16_t len)
{
    char pkt_id[MAX_ID] = {0};
    json_string_field((const char *)payload, "id", pkt_id, sizeof(pkt_id));
    if (seen_packet(pkt_id)) {
        ESP_LOGI(TAG, "drop duplicate %s", pkt_id);
        return;
    }

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
        ESP_LOGI(TAG, "forwarded %u bytes to conn %u", len, dest->conn);
    }
}

static void ingest_frame(link_t *link, const uint8_t *data, uint16_t len)
{
    if (len < 3 || data[0] != PACKET_MAGIC) return;
    uint8_t seq = data[1];
    uint8_t total = data[2];
    if (total == 0 || seq >= total) return;

    if (link->total != total) {
        memset(link->parts_mask, 0, sizeof(link->parts_mask));
        link->total = total;
        link->got = 0;
        link->len = 0;
    }

    uint16_t offset = 0;
    uint16_t chunk = payload_mtu(link);
    offset = (uint16_t)seq * chunk;
    uint16_t part = (uint16_t)(len - 3);
    if (offset + part > MAX_PACKET) return;
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
        uint8_t buf[220];
        if (len > sizeof(buf)) len = sizeof(buf);
        int rc = ble_hs_mbuf_to_flat(ctxt->om, buf, len, &len);
        if (rc != 0) return BLE_ATT_ERR_UNLIKELY;

        if (len >= 3 && buf[0] == PACKET_MAGIC) {
            if (link) ingest_frame(link, buf, len);
            return 0;
        }

        buf[len < sizeof(buf) ? len : sizeof(buf) - 1] = 0;
        char id[MAX_ID] = {0};
        char name[MAX_NAME + 1] = {0};
        if (link && json_string_field((char *)buf, "id", id, sizeof(id))) {
            json_string_field((char *)buf, "name", name, sizeof(name));
            strncpy(link->id, id, MAX_ID - 1);
            strncpy(link->name, name[0] ? name : "Nored", MAX_NAME);
            ESP_LOGI(TAG, "peer %s (%s) on conn %u", link->name, link->id, conn_handle);
            publish_peer_identities();
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
        }
        if (event->subscribe.attr_handle == h_identity && event->subscribe.cur_notify) {
            notify_bytes(event->subscribe.conn_handle, h_identity,
                         (const uint8_t *)identity_json, strlen(identity_json));
            publish_peer_identities();
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
