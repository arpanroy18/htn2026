import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { preferTextTranslation } from './preferTextTranslation.ts';

describe('preferTextTranslation', () => {
  it('prefers text translation for Korean script', () => {
    assert.equal(
      preferTextTranslation('안녕하세요, 만나서 반갑습니다. 저는 존입니다.'),
      true,
    );
  });

  it('prefers text translation for Devanagari', () => {
    assert.equal(preferTextTranslation('नमस्ते, आप कैसे हैं'), true);
  });

  it('allows Whisper audio translate for Latin transcripts', () => {
    assert.equal(preferTextTranslation('Bonjour, comment allez-vous'), false);
    assert.equal(preferTextTranslation('hello how are you'), false);
  });
});
