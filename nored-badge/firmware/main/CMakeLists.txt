idf_component_register(SRCS "nored_router.c" "nored_display.c"
                    INCLUDE_DIRS "."
                    REQUIRES bt esp_driver_rmt nvs_flash esp_lcd driver)
