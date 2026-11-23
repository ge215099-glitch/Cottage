import { TRANSLATABLE_FIELDS, type SourceLanguage, type TranslationFields } from '@shared/character-translation.js';
import type { Character, CharacterLanguageMode } from '@shared/types.js';
import { CharacterCardError } from './character-card.js';

const STRUCTURE = /(\{\{[^{}\r\n]+\}\}|<\/?[a-zA-Z][^<>\r\n]*>|https?:\/\/[^\s<>]+|`[^`\r\n]+`)/g;
const SPEAKER = /^(\s*\{\{\s*(?:user|char)\s*\}\}\s*[:：]\s*)/i;
const START = /(<START>)/gi;
const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });
const MAX_UNIT_LENGTH = 3_200;

type TranslationField = keyof typeof TRANSLATABLE_FIELDS;
type Target = 'zh' | 'en';

export interface TranslationUnit {
  id: number;
  field: string;
  text: string;
  targets: Target[];
}

export interface TranslatedUnit {
  id: number;
  zh?: string | undefined;
  en?: string | undefined;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termPattern(terms: string[]): RegExp {
  const patterns = [...new Set(terms.map((term) => term.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((term) => {
      const before = /^[a-z\d]/i.test(term) ? '(?<![a-z\\d])' : '';
      const after = /[a-z\d]$/i.test(term) ? '(?![a-z\\d])' : '';
      return `${before}${escapeRegex(term)}${after}`;
    });
  return new RegExp([STRUCTURE.source, ...patterns].join('|'), 'gi');
}

function countLanguages(text: string) {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const other = text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}]/gu)?.length ?? 0;
  const prose = han ? text.replace(/\b[A-Z][a-zA-Z\d]*(?:[ -][A-Z][a-zA-Z\d]*)*\b/g, '') : text;
  const english = prose.match(/\p{Script=Latin}+(?:['’]\p{Script=Latin}+)?/gu)?.length ?? 0;
  return { han, english, other };
}

function fieldKeys(): TranslationField[] {
  return Object.keys(TRANSLATABLE_FIELDS) as TranslationField[];
}

export function detectCharacterLanguage(character: Character, terms: string[]): SourceLanguage {
  if (character.languageMode) return character.languageMode;
  const protectedPattern = termPattern([character.name, ...terms]);
  const texts = [...fieldKeys().map((key) => character[key]), ...character.alternateGreetings];
  let han = 0;
  let english = 0;
  let other = 0;
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      const counts = countLanguages(line.replace(protectedPattern, ' '));
      han += counts.han;
      english += counts.english;
      other += counts.other;
    }
  }
  if (!han && !english && !other && !texts.some((text) => /\p{L}/u.test(text.replace(protectedPattern, '')))) return 'empty';
  if (!other && han >= 2 && english === 0) return 'zh';
  if (!other && !han && english >= 4) return 'en';
  return 'uncertain';
}

export function prepareTranslation(character: Character, mode: CharacterLanguageMode, terms: string[]) {
  const units: TranslationUnit[] = [];
  const greetings = [character.firstMes, ...character.alternateGreetings];
  const allText = [...fieldKeys().map((key) => character[key]), ...character.alternateGreetings].join('\n');
  const proseNames = new Set(Array.from(
    allText.matchAll(/\b(?:in|of|from|to|near|beyond|for|at|outside|inside|around|across)[ \t]+(\p{Lu}\p{Ll}{2,})(?!\p{L})/gu),
    (match) => match[1],
  ));
  const placeHeadings = greetings.flatMap((greeting) => {
    const firstLine = greeting.trimStart().split(/\r?\n/, 1)[0];
    const name = firstLine?.trim().match(/^(\p{Lu}\p{Ll}{2,})\.$/u)?.[1];
    return name && proseNames.has(name) && !new RegExp(`\\b${escapeRegex(name.toLowerCase())}\\b`, 'u').test(allText) ? [name] : [];
  });
  const protectedPattern = termPattern([character.name, ...terms, ...placeHeadings]);
  let tokenPrefix = '__COTTAGE_';
  while (allText.includes(tokenPrefix)) tokenPrefix += 'X';
  const tokenPattern = new RegExp(`${escapeRegex(tokenPrefix)}\\d+__`, 'g');
  const protectedText = new Map<string, string>();

  function makeUnit(source: string, field: string, bilingual: boolean) {
    const plain = source.replace(tokenPattern, ' ');
    if (!/\p{L}/u.test(plain)) return () => restore(source);
    if (source.length > MAX_UNIT_LENGTH) throw invalidField(field, '单段文字过长，请先拆成较短的段落');
    const { han, english, other } = countLanguages(plain);
    const chinese = han > 0 && english === 0 && other === 0;
    const targets: Target[] = [];
    if (!chinese) targets.push('zh');
    if (bilingual && (han > 0 || other > 0)) targets.push('en');
    if (!targets.length) return () => restore(source);
    const unit = { id: units.length, field, text: source, targets };
    units.push(unit);
    return (translations: ReadonlyMap<number, TranslatedUnit>) => {
      const translated = translations.get(unit.id)!;
      const chineseText = restore(translated.zh ?? source);
      return bilingual ? `${restore(translated.en ?? source)}\n${chineseText}` : chineseText;
    };
  }

  function restore(text: string) {
    return text.replace(tokenPattern, (token) => protectedText.get(token)!);
  }

  function prepareText(text: string, field: string, bilingual: boolean, example = false) {
    const renderers = text.split(/(\r?\n)/).map((line) => {
      if (!line.trim()) return () => line;
      return (example ? line.split(START) : [line]).map((part) => {
        if (/^<START>$/i.test(part)) return () => part;
        const speaker = example ? part.match(SPEAKER)?.[0] ?? '' : '';
        const content = part.slice(speaker.length);
        const leading = content.match(/^\s*/)?.[0] ?? '';
        const body = content.trim().replace(protectedPattern, (matched) => {
          const key = `${tokenPrefix}${protectedText.size}__`;
          protectedText.set(key, matched);
          return key;
        });
        const sentences = bilingual ? Array.from(SENTENCES.segment(body), ({ segment }) => segment.trim()).filter(Boolean) : [body];
        const renderUnits = sentences.map((sentence) => makeUnit(sentence, field, bilingual));
        return (translations: ReadonlyMap<number, TranslatedUnit>) =>
          speaker + leading + renderUnits.map((render) => render(translations)).join('\n');
      });
    }).flat();
    return (translations: ReadonlyMap<number, TranslatedUnit>) => renderers.map((render) => render(translations)).join('');
  }

  const renderFields = fieldKeys().map((key) => {
    const bilingual = mode === 'bilingual' && key !== 'systemPrompt' && key !== 'postHistoryInstructions';
    return [key, prepareText(character[key], TRANSLATABLE_FIELDS[key], bilingual, key === 'mesExample')] as const;
  });
  const renderGreetings = character.alternateGreetings.map((text, index) =>
    prepareText(text, `备用开场白 ${index + 1}`, mode === 'bilingual'));

  return {
    units,
    validateUnit(unit: TranslationUnit, reply: TranslatedUnit | undefined): TranslatedUnit {
      if (!reply) throw invalidField(unit.field, '模型遗漏了这段内容');
      const result: TranslatedUnit = { id: unit.id };
      const expectedTokens = unit.text.match(tokenPattern)?.sort() ?? [];
      for (const target of ['en', 'zh'] as const) {
        const value = reply[target];
        if (!unit.targets.includes(target)) {
          if (value !== undefined) throw invalidField(unit.field, '模型改写了需要保留的原文');
          continue;
        }
        const actualTokens = value?.match(tokenPattern)?.sort() ?? [];
        if (!value?.trim() || /[\r\n\u2028\u2029]/.test(value) || SPEAKER.test(value) || /<START>/i.test(value)) {
          throw invalidField(unit.field, '模型没有按要求返回单行译文');
        }
        if (actualTokens.join() !== expectedTokens.join()) throw invalidField(unit.field, '译文改动了锁定词或模板标记');
        const plain = value.replace(tokenPattern, '');
        if (plain.match(STRUCTURE)) throw invalidField(unit.field, '译文引入了新的模板标记');
        if (target === 'zh' ? !/\p{Script=Han}/u.test(plain) : !/\p{Script=Latin}/u.test(plain)) {
          throw invalidField(unit.field, '模型返回的译文语言不正确');
        }
        result[target] = value.trim();
      }
      return result;
    },
    render(translations: ReadonlyMap<number, TranslatedUnit>): TranslationFields {
      const missing = units.find((unit) => !translations.has(unit.id));
      if (missing) throw invalidField(missing.field, '模型遗漏了这段内容');
      return {
        ...Object.fromEntries(renderFields.map(([key, render]) => [key, render(translations)])) as Omit<TranslationFields, 'alternateGreetings'>,
        alternateGreetings: renderGreetings.map((render) => render(translations)),
      };
    },
  };
}

function invalidField(field: string, message: string) {
  return new CharacterCardError('translation-invalid', `${field}：${message}`);
}
