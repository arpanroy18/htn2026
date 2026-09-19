import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTranscriptionResult } from './normalizeTranscriptionResult.ts';

test('normalizeTranscriptionResult returns trimmed text and language', () => {
  assert.deepEqual(
    normalizeTranscriptionResult({
      result: '  Hello there  ',
      language: ' en ',
      isAborted: false,
    }),
    { text: 'Hello there', language: 'en' },
  );
});

test('normalizeTranscriptionResult rejects aborted or empty results', () => {
  assert.equal(
    normalizeTranscriptionResult({
      result: 'Hello',
      language: 'en',
      isAborted: true,
    }),
    null,
  );
  assert.equal(
    normalizeTranscriptionResult({
      result: '   ',
      language: 'en',
      isAborted: false,
    }),
    null,
  );
  assert.equal(normalizeTranscriptionResult(null), null);
});
