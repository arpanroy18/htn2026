import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TRANSLATION_SCENARIOS,
  chooseTranslationStrategy,
} from './translationPlan.ts';

describe('chooseTranslationStrategy', () => {
  for (const scenario of TRANSLATION_SCENARIOS) {
    it(scenario.name, () => {
      assert.equal(
        chooseTranslationStrategy({
          transcript: scenario.transcript,
          viewerLocale: scenario.viewerLocale,
          sourceLocale: scenario.sourceLocale,
          whisperTranslation: scenario.whisperTranslation,
          hasAudioFile: scenario.hasAudioFile,
        }),
        scenario.expected,
      );
    });
  }
});
