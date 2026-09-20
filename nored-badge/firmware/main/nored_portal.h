#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define NORED_AP_SSID "Nored"
#define NORED_AP_QR "WIFI:T:nopass;S:Nored;P:;;"

bool nored_portal_start(bool (*broadcast)(const char *severity, const char *body,
                                          int64_t client_ms, char *err, size_t err_len));
