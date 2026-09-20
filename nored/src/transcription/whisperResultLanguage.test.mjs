import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveWhisperResultLanguage } from './whisperResultLanguage.ts';

describe('resolveWhisperResultLanguage', () => {
  it('keeps detected source language on translate passes', () => {
    assert.equal(
      resolveWhisperResultLanguage('ko', { language: 'auto', translate: true }),
      'ko',
    );
  });

  it('uses forced language when payload language is missing', () => {
    assert.equal(
      resolveWhisperResultLanguage('auto', { language: 'hi', translate: false }),
      'hi',
    );
  });

  it('normalizes locale tags from Whisper payloads', () => {
    assert.equal(
      resolveWhisperResultLanguage('en-US', { language: 'auto', translate: false }),
      'en',
    );
  });
});
