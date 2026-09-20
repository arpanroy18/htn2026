import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  languageCodeAbbrev,
  localeDisplayName,
  needsTranslation,
  normalizeLanguageCode,
  getViewerLocale,
  resolveViewerLocale,
  sameLanguage,
} from './viewerLocale.ts';

describe('viewerLocale', () => {
  it('normalizes common language codes', () => {
    assert.equal(normalizeLanguageCode('en'), 'en');
    assert.equal(normalizeLanguageCode('EN-US'), 'en');
    assert.equal(normalizeLanguageCode('english'), 'en');
    assert.equal(normalizeLanguageCode('fr'), 'fr');
    assert.equal(normalizeLanguageCode('fr-CA'), 'fr');
    assert.equal(normalizeLanguageCode('french'), 'fr');
    assert.equal(normalizeLanguageCode('hi'), 'hi');
    assert.equal(normalizeLanguageCode('hi-IN'), 'hi');
    assert.equal(normalizeLanguageCode('hindi'), 'hi');
    assert.equal(normalizeLanguageCode('es'), 'es');
    assert.equal(normalizeLanguageCode('de'), 'de');
    assert.equal(normalizeLanguageCode('ko'), 'ko');
    assert.equal(normalizeLanguageCode('ko-KR'), 'ko');
    assert.equal(normalizeLanguageCode('auto'), null);
  });

  it('resolves viewer locale with English fallback', () => {
    assert.equal(resolveViewerLocale('fr-FR'), 'fr');
    assert.equal(resolveViewerLocale('hi-IN'), 'hi');
    assert.equal(resolveViewerLocale('de'), 'de');
    assert.equal(resolveViewerLocale(undefined), 'en');
  });

  it('returns a normalized locale from getViewerLocale', () => {
    assert.match(getViewerLocale(), /^[a-z]{2}$/);
  });

  it('detects when translation is needed', () => {
    assert.equal(needsTranslation('fr', 'en'), true);
    assert.equal(needsTranslation('en', 'en'), false);
    assert.equal(needsTranslation('auto', 'en'), true);
    assert.equal(needsTranslation(undefined, 'fr'), true);
  });

  it('compares languages case-insensitively', () => {
    assert.equal(sameLanguage('EN-US', 'en'), true);
    assert.equal(sameLanguage('fr', 'en'), false);
  });

  it('labels locales', () => {
    assert.equal(localeDisplayName('en'), 'English');
    assert.equal(localeDisplayName('fr'), 'French');
    assert.equal(localeDisplayName('hi'), 'Hindi');
  });

  it('abbreviates language codes to three letters', () => {
    assert.equal(languageCodeAbbrev('en'), 'eng');
    assert.equal(languageCodeAbbrev('hi-IN'), 'hin');
    assert.equal(languageCodeAbbrev('fr'), 'fra');
    assert.equal(languageCodeAbbrev('ko'), 'kor');
    assert.equal(languageCodeAbbrev(undefined), '???');
  });
});
