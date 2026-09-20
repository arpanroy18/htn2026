#pragma once

#include <stdbool.h>

/* 74HC165 shift order: A, B, Home, Down, Left, Right, Up, Aux1 (active-low). */
typedef struct {
    bool a;
    bool b;
    bool home;
    bool down;
    bool left;
    bool right;
    bool up;
    bool aux1;
    bool start;
} nored_buttons_t;

bool nored_buttons_init(void);
void nored_buttons_sample(nored_buttons_t *out);
bool nored_buttons_poll(nored_buttons_t *press);
