#include "nored_display.h"

#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "font8x8_basic.h"

#define TAG "nored_disp"

#define LCD_HOST        SPI2_HOST
#define LCD_W           320
#define LCD_H           240
#define LCD_PIN_MOSI    10
#define LCD_PIN_CLK     1
#define LCD_PIN_CS      2
#define LCD_PIN_DC      0
#define LCD_PIN_RST     4
#define LCD_CLK_HZ      (40 * 1000 * 1000)
#define STRIPE_ROWS     30
#define BODY_SCALE      2
#define LABEL_SCALE     2

#define RGB565(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))

static const uint16_t COLOR_WHITE = RGB565(255, 255, 255);
static const uint16_t COLOR_BLACK = RGB565(0, 0, 0);
static const uint16_t COLOR_INK = RGB565(27, 27, 27);
static const uint16_t COLOR_PANEL = RGB565(18, 22, 32);
static const uint16_t COLOR_INFO = RGB565(255, 220, 64);
static const uint16_t COLOR_HELP = RGB565(255, 140, 32);
static const uint16_t COLOR_DANGER = RGB565(220, 40, 40);
static const uint16_t COLOR_BODY_BG = RGB565(245, 247, 252);
static const uint16_t COLOR_MUTED = RGB565(170, 180, 200);

static esp_lcd_panel_handle_t panel;
static SemaphoreHandle_t transfer_done;
static uint16_t stripe[LCD_W * STRIPE_ROWS];

static bool on_color_transfer_done(esp_lcd_panel_io_handle_t panel_io,
                                   esp_lcd_panel_io_event_data_t *event_data,
                                   void *user_ctx)
{
    (void)panel_io;
    (void)event_data;
    (void)user_ctx;
    BaseType_t task_woken = pdFALSE;
    xSemaphoreGiveFromISR(transfer_done, &task_woken);
    return task_woken == pdTRUE;
}

static void draw_bitmap_sync(int x1, int y1, int x2, int y2, const uint16_t *pixels)
{
    ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(panel, x1, y1, x2, y2, pixels));
    ESP_ERROR_CHECK(xSemaphoreTake(transfer_done, pdMS_TO_TICKS(250)) == pdTRUE
                        ? ESP_OK
                        : ESP_ERR_TIMEOUT);
}

static const unsigned char *glyph(char c)
{
    if ((unsigned char)c >= 128) {
        return font8x8_basic['?'];
    }
    return font8x8_basic[(unsigned char)c];
}

static void fill_stripe(uint16_t color, int rows)
{
    for (int i = 0; i < LCD_W * rows; i++) {
        stripe[i] = color;
    }
}

static void blit_region(int x, int y, int w, int h, const uint16_t *pixels)
{
    if (x < 0) {
        pixels -= x;
        w += x;
        x = 0;
    }
    if (y < 0) {
        pixels -= y * w;
        h += y;
        y = 0;
    }
    if (x + w > LCD_W) {
        w = LCD_W - x;
    }
    if (y + h > LCD_H) {
        h = LCD_H - y;
    }
    if (w <= 0 || h <= 0) {
        return;
    }

    for (int row = 0; row < h; row++) {
        memcpy(stripe + row * w, pixels + row * w, (size_t)w * sizeof(uint16_t));
    }
    draw_bitmap_sync(x, y, x + w, y + h, stripe);
}

static void fill_rect(int x, int y, int w, int h, uint16_t color)
{
    if (w <= 0 || h <= 0) {
        return;
    }
    int chunk = STRIPE_ROWS;
    while (h > 0) {
        int rows = h < chunk ? h : chunk;
        fill_stripe(color, rows);
        draw_bitmap_sync(x, y, x + w, y + rows, stripe);
        y += rows;
        h -= rows;
    }
}

static int text_width(const char *text, int scale)
{
    return (int)strlen(text) * 8 * scale;
}

static void draw_char(int x, int y, char c, int scale, uint16_t fg, uint16_t bg)
{
    const unsigned char *g = glyph(c);
    uint16_t buf[8 * 8];

    for (int row = 0; row < 8; row++) {
        for (int col = 0; col < 8; col++) {
            bool on = (g[row] >> col) & 1;
            buf[row * 8 + col] = on ? fg : bg;
        }
    }

    if (scale == 1) {
        blit_region(x, y, 8, 8, buf);
        return;
    }

    int size = 8 * scale;
    uint16_t scaled[16 * 16];
    for (int row = 0; row < 8; row++) {
        for (int col = 0; col < 8; col++) {
            uint16_t px = buf[row * 8 + col];
            for (int dy = 0; dy < scale; dy++) {
                for (int dx = 0; dx < scale; dx++) {
                    scaled[(row * scale + dy) * size + (col * scale + dx)] = px;
                }
            }
        }
    }
    blit_region(x, y, size, size, scaled);
}

static void draw_text(int x, int y, const char *text, int scale, uint16_t fg, uint16_t bg)
{
    int cursor = x;
    for (const char *p = text; *p; p++) {
        if (*p == '\n') {
            return;
        }
        draw_char(cursor, y, *p, scale, fg, bg);
        cursor += 8 * scale;
        if (cursor >= LCD_W) {
            return;
        }
    }
}

static void draw_text_centered(int y, const char *text, int scale, uint16_t fg, uint16_t bg)
{
    int w = text_width(text, scale);
    int x = (LCD_W - w) / 2;
    if (x < 0) {
        x = 0;
    }
    draw_text(x, y, text, scale, fg, bg);
}

static void sanitize_ascii(char *text)
{
    for (char *p = text; *p; p++) {
        if ((unsigned char)*p < 32 || (unsigned char)*p > 126) {
            *p = ' ';
        }
    }
}

static void severity_label(nored_alert_severity_t severity, char *out, size_t out_len)
{
    const char *label = "INFO";
    if (severity == NORED_ALERT_HELP) {
        label = "HELP";
    } else if (severity == NORED_ALERT_DANGER) {
        label = "DANGER";
    }
    snprintf(out, out_len, "%s ALERT", label);
}

static void severity_colors(nored_alert_severity_t severity, uint16_t *bg, uint16_t *fg)
{
    if (severity == NORED_ALERT_DANGER) {
        *bg = COLOR_DANGER;
        *fg = COLOR_WHITE;
    } else if (severity == NORED_ALERT_HELP) {
        *bg = COLOR_HELP;
        *fg = COLOR_BLACK;
    } else {
        *bg = COLOR_INFO;
        *fg = COLOR_BLACK;
    }
}

static int chars_per_line(int x, int scale)
{
    int width = LCD_W - x - 12;
    if (width < 8 * scale) {
        return 1;
    }
    return width / (8 * scale);
}

static void draw_wrapped_body(int x, int y, int max_h, const char *body, int scale,
                              uint16_t fg, uint16_t bg)
{
    char line[40];
    char copy[161];
    int line_len = 0;
    int line_h = 8 * scale + 4;
    int bottom = y + max_h;
    int max_chars = chars_per_line(x, scale);

    strncpy(copy, body, sizeof(copy) - 1);
    copy[sizeof(copy) - 1] = 0;
    sanitize_ascii(copy);

    for (const char *p = copy; *p && y + 8 * scale < bottom; ) {
        while (*p == ' ') {
            p++;
        }
        if (!*p) {
            break;
        }

        const char *word_start = p;
        while (*p && *p != ' ' && *p != '\n') {
            p++;
        }
        int word_len = (int)(p - word_start);
        if (word_len > (int)sizeof(line) - 2) {
            word_len = (int)sizeof(line) - 2;
        }

        if (line_len > 0 && line_len + 1 + word_len > max_chars) {
            draw_text(x, y, line, scale, fg, bg);
            y += line_h;
            line_len = 0;
            if (y + 8 * scale >= bottom) {
                return;
            }
        }

        if (line_len == 0) {
            memcpy(line, word_start, (size_t)word_len);
            line_len = word_len;
        } else {
            line[line_len++] = ' ';
            memcpy(line + line_len, word_start, (size_t)word_len);
            line_len += word_len;
        }
        line[line_len] = 0;

        if (*p == '\n') {
            p++;
            draw_text(x, y, line, scale, fg, bg);
            y += line_h;
            line_len = 0;
        }
    }

    if (line_len > 0 && y + 8 * scale < bottom) {
        draw_text(x, y, line, scale, fg, bg);
    }
}

bool nored_display_init(void)
{
    transfer_done = xSemaphoreCreateBinary();
    if (!transfer_done) {
        ESP_LOGE(TAG, "transfer semaphore allocation failed");
        return false;
    }

    spi_bus_config_t bus = {
        .mosi_io_num = LCD_PIN_MOSI,
        .miso_io_num = GPIO_NUM_NC,
        .sclk_io_num = LCD_PIN_CLK,
        .quadwp_io_num = GPIO_NUM_NC,
        .quadhd_io_num = GPIO_NUM_NC,
        .max_transfer_sz = LCD_W * STRIPE_ROWS * sizeof(uint16_t),
    };
    if (spi_bus_initialize(LCD_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK) {
        ESP_LOGE(TAG, "spi init failed");
        return false;
    }

    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_spi_config_t io_cfg = {
        .dc_gpio_num = LCD_PIN_DC,
        .cs_gpio_num = LCD_PIN_CS,
        .pclk_hz = LCD_CLK_HZ,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 0,
        .trans_queue_depth = 1,
        .on_color_trans_done = on_color_transfer_done,
    };
    if (esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_HOST, &io_cfg, &io) != ESP_OK) {
        ESP_LOGE(TAG, "panel io failed");
        return false;
    }

    esp_lcd_panel_dev_config_t panel_cfg = {
        .reset_gpio_num = LCD_PIN_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .data_endian = LCD_RGB_DATA_ENDIAN_LITTLE,
        .bits_per_pixel = 16,
    };
    if (esp_lcd_new_panel_st7789(io, &panel_cfg, &panel) != ESP_OK) {
        ESP_LOGE(TAG, "panel create failed");
        return false;
    }

    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_swap_xy(panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(panel, true, false));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));

    ESP_LOGI(TAG, "ST7789 ready");
    nored_display_idle();
    return true;
}

void nored_display_idle(void)
{
    if (!panel) {
        return;
    }
    fill_rect(0, 0, LCD_W, LCD_H, COLOR_PANEL);
    draw_text_centered(84, "Nored Badge", LABEL_SCALE, COLOR_WHITE, COLOR_PANEL);
    draw_text_centered(120, "Mesh relay ready", BODY_SCALE, COLOR_MUTED, COLOR_PANEL);
}

void nored_display_alert(nored_alert_severity_t severity, const char *sender, const char *body)
{
    if (!panel) {
        return;
    }

    char banner[16];
    char from_line[48];
    char safe_body[161];
    uint16_t banner_bg = 0;
    uint16_t banner_fg = 0;

    severity_label(severity, banner, sizeof(banner));
    severity_colors(severity, &banner_bg, &banner_fg);

    snprintf(from_line, sizeof(from_line), "From: %s", sender && sender[0] ? sender : "Unknown");
    strncpy(safe_body, body && body[0] ? body : "(no message)", sizeof(safe_body) - 1);
    safe_body[sizeof(safe_body) - 1] = 0;
    sanitize_ascii(from_line);

    fill_rect(0, 0, LCD_W, LCD_H, COLOR_BODY_BG);
    fill_rect(0, 0, LCD_W, 40, banner_bg);
    draw_text_centered(10, banner, LABEL_SCALE, banner_fg, banner_bg);
    draw_text(12, 48, from_line, BODY_SCALE, COLOR_INK, COLOR_BODY_BG);
    draw_wrapped_body(12, 80, LCD_H - 88, safe_body, BODY_SCALE, COLOR_INK, COLOR_BODY_BG);
}
