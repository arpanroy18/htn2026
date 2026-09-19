#pragma once

#include <stdbool.h>

typedef enum {
    NORED_ALERT_INFO,
    NORED_ALERT_HELP,
    NORED_ALERT_DANGER,
} nored_alert_severity_t;

bool nored_display_init(void);
void nored_display_idle(void);
void nored_display_alert(nored_alert_severity_t severity, const char *sender, const char *body);
