idf_component_register(SRCS "nored_router.c" "nored_display.c" "nored_buttons.c"
                             "nored_portal.c" "qrcodegen.c"
                    INCLUDE_DIRS "."
                    REQUIRES bt esp_driver_rmt nvs_flash esp_lcd driver json esp_wifi
                             esp_http_server esp_netif esp_event lwip esp_timer esp_coex)
