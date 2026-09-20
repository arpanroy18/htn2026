#pragma once

#include <stdbool.h>
#include <stddef.h>

#define NORED_AP_SSID "Nored"
#define NORED_AP_QR "WIFI:T:nopass;S:Nored;P:;;"

bool nored_portal_start(bool (*broadcast)(const char *severity, const char *body,
                                          char *err, size_t err_len));
