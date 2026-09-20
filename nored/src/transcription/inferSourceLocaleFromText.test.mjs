import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inferSourceLocaleFromText } from './inferSourceLocaleFromText.ts';

describe('inferSourceLocaleFromText', () => {
  it('detects common French words', () => {
    assert.equal(inferSourceLocaleFromText('Bonjour'), 'fr');
    assert.equal(inferSourceLocaleFromText('comment allez vous'), 'fr');
  });

  it('detects French diacritics', () => {
    assert.equal(inferSourceLocaleFromText('être ici'), 'fr');
  });

  it('detects Devanagari script as Hindi', () => {
    assert.equal(inferSourceLocaleFromText('नमस्ते, आप कैसे हैं'), 'hi');
  });

  it('detects romanized Hindi words', () => {
    assert.equal(inferSourceLocaleFromText('namaste aap kaise hain'), 'hi');
  });

  it('detects common English words', () => {
    assert.equal(inferSourceLocaleFromText('hello how are you today'), 'en');
  });

  it('returns null for ambiguous short text', () => {
    assert.equal(inferSourceLocaleFromText('hmm'), null);
  });
});
