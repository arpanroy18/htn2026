import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolveLanguageFromSignals,
  transcriptsDifferMeaningfully,
} from './resolveSpokenLanguage.ts';

describe('transcriptsDifferMeaningfully', () => {
  it('detects when two transcripts share few words', () => {
    assert.equal(
      transcriptsDifferMeaningfully(
        'namaste aap kaise hain',
        'Hello, how are you?',
      ),
      true,
    );
  });

  it('treats near-identical text as the same', () => {
    assert.equal(
      transcriptsDifferMeaningfully(
        'Hello, how are you?',
        'hello how are you',
      ),
      false,
    );
  });
});

describe('resolveLanguageFromSignals', () => {
  it('prefers text hint when Whisper auto-detect says English', () => {
    assert.equal(
      resolveLanguageFromSignals({
        whisperDetected: 'en',
        textHint: 'hi',
      }),
      'hi',
    );
  });

  it('uses translate probe source language when available', () => {
    assert.equal(
      resolveLanguageFromSignals({
        whisperDetected: 'en',
        translateSource: 'hi',
      }),
      'hi',
    );
  });

  it('falls back to platform detection for suspicious English labels', () => {
    assert.equal(
      resolveLanguageFromSignals({
        whisperDetected: 'en',
        platformSource: 'hi',
        transcriptsDiffer: true,
      }),
      'hi',
    );
  });

  it('detects Korean from Whisper auto-detect', () => {
    assert.equal(
      resolveLanguageFromSignals({
        whisperDetected: 'ko',
        textHint: null,
      }),
      'ko',
    );
  });

  it('overrides English auto-detect when text is clearly Hindi', () => {
    assert.equal(
      resolveLanguageFromSignals({
        whisperDetected: 'en',
        textHint: 'hi',
      }),
      'hi',
    );
  });
});
