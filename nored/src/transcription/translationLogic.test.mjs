import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeTranslatedText } from './translationLogic.ts';

describe('translationLogic', () => {
  it('returns string translations unchanged', () => {
    assert.equal(normalizeTranslatedText('Bonjour'), 'Bonjour');
  });

  it('reads the first array translation', () => {
    assert.equal(normalizeTranslatedText(['Hello', 'Hi']), 'Hello');
  });

  it('reads the first record translation', () => {
    assert.equal(
      normalizeTranslatedText({ line1: 'Hello', line2: ['Ignored'] }),
      'Hello',
    );
  });

  it('returns null for empty shapes', () => {
    assert.equal(normalizeTranslatedText([]), null);
    assert.equal(normalizeTranslatedText({}), null);
  });
});
