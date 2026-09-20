#pragma once

#include <stdbool.h>
#include <stddef.h>

/* Mirrors ALERT_MAX_BODY in nored/src/mesh/protocol.ts (SPECS §3.2: 280-char payload). */
#define NORED_ALERT_MAX_BODY 280

typedef enum {
    NORED_ALERT_INFO,
    NORED_ALERT_HELP,
    NORED_ALERT_DANGER,
} nored_alert_severity_t;

typedef struct {
    nored_alert_severity_t severity;
    char sender[41];
    char body[NORED_ALERT_MAX_BODY + 1];
} nored_alert_history_item_t;

bool nored_display_init(void);
void nored_display_idle(void);
void nored_display_alert(nored_alert_severity_t severity, const char *sender, const char *body);
void nored_display_alert_history(const nored_alert_history_item_t *items, size_t item_count,
                                 size_t page, size_t page_count);
