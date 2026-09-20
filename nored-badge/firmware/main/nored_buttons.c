#include "nored_buttons.h"

#include <string.h>

#include "driver/gpio.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define PIN_DATA 7
#define PIN_LOAD 20
#define PIN_CLK 21
#define PIN_START 9

static bool ready;
static nored_buttons_t stable;
static nored_buttons_t last_emit;

static void pulse_clk(void)
{
    gpio_set_level(PIN_CLK, 1);
    esp_rom_delay_us(2);
    gpio_set_level(PIN_CLK, 0);
    esp_rom_delay_us(2);
}

static uint8_t read_shift(void)
{
    gpio_set_level(PIN_LOAD, 0);
    esp_rom_delay_us(2);
    gpio_set_level(PIN_LOAD, 1);
    esp_rom_delay_us(2);

    uint8_t raw = 0;
    for (int i = 0; i < 8; i++) {
        if (gpio_get_level(PIN_DATA) == 0) {
            raw |= (uint8_t)(1u << i);
        }
        pulse_clk();
    }
    return raw;
}

static void map_raw(uint8_t raw, bool start, nored_buttons_t *out)
{
    out->a = (raw & (1u << 0)) != 0;
    out->b = (raw & (1u << 1)) != 0;
    out->home = (raw & (1u << 2)) != 0;
    out->down = (raw & (1u << 3)) != 0;
    out->left = (raw & (1u << 4)) != 0;
    out->right = (raw & (1u << 5)) != 0;
    out->up = (raw & (1u << 6)) != 0;
    out->aux1 = (raw & (1u << 7)) != 0;
    out->start = start;
}

bool nored_buttons_init(void)
{
    gpio_config_t in = {
        .pin_bit_mask = (1ULL << PIN_DATA) | (1ULL << PIN_START),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config_t out = {
        .pin_bit_mask = (1ULL << PIN_LOAD) | (1ULL << PIN_CLK),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&in) != ESP_OK || gpio_config(&out) != ESP_OK) {
        return false;
    }
    gpio_set_level(PIN_LOAD, 1);
    gpio_set_level(PIN_CLK, 0);
    ready = true;
    return true;
}

void nored_buttons_sample(nored_buttons_t *out)
{
    if (!out) return;
    if (!ready) {
        memset(out, 0, sizeof(*out));
        return;
    }
    map_raw(read_shift(), gpio_get_level(PIN_START) == 0, out);
}

bool nored_buttons_poll(nored_buttons_t *press)
{
    if (!press || !ready) return false;

    nored_buttons_t sample;
    nored_buttons_sample(&sample);

    if (memcmp(&sample, &stable, sizeof(sample)) != 0) {
        stable = sample;
        vTaskDelay(pdMS_TO_TICKS(15));
        nored_buttons_sample(&sample);
        stable = sample;
    }

    press->a = sample.a && !last_emit.a;
    press->b = sample.b && !last_emit.b;
    press->home = sample.home && !last_emit.home;
    press->down = sample.down && !last_emit.down;
    press->left = sample.left && !last_emit.left;
    press->right = sample.right && !last_emit.right;
    press->up = sample.up && !last_emit.up;
    press->aux1 = false;
    press->start = sample.start && !last_emit.start;

    last_emit = sample;
    last_emit.aux1 = sample.aux1;
    return press->a || press->b || press->home || press->down || press->left ||
           press->right || press->up || press->start;
}
