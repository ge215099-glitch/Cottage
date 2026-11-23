import type { Character, CharacterLanguageMode } from './types.js';

export const TRANSLATABLE_FIELDS = {
  description: '简介',
  personality: '性格',
  scenario: '场景',
  firstMes: '开场白',
  mesExample: '对话示例',
  systemPrompt: '系统提示',
  postHistoryInstructions: '历史后指令',
} as const;

export type TranslationFields = Pick<Character, keyof typeof TRANSLATABLE_FIELDS | 'alternateGreetings'>;
export type SourceLanguage = 'zh' | 'en' | 'uncertain' | 'empty' | 'bilingual';

export interface TranslationInput {
  requestId: string;
  characterId: string;
  mode: CharacterLanguageMode;
  providerId: string;
  model: string;
  protectedTerms: string[];
  confirmUncertain: boolean;
}

export type TranslationResult =
  | { status: 'already-zh' | 'already-bilingual' | 'confirm-language' | 'empty' | 'cancelled' }
  | { status: 'preview'; fields: TranslationFields };

export const CHARACTER_LANGUAGE_LABEL = { zh: '中文', bilingual: '双语' } as const;
