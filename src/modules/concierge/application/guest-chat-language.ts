const names = new Intl.DisplayNames(['en'], { type: 'language' });

const aliases: Record<string, string> = {
  albanian: 'sq', shqip: 'sq', french: 'fr', français: 'fr',
  german: 'de', deutsch: 'de', spanish: 'es', español: 'es',
  italian: 'it', italiano: 'it', portuguese: 'pt', português: 'pt',
  serbian: 'sr', srpski: 'sr', croatian: 'hr', hrvatski: 'hr',
  bosnian: 'bs', bosanski: 'bs', english: 'en',
  arabic: 'ar', العربية: 'ar', chinese: 'zh', 中文: 'zh',
  japanese: 'ja', 日本語: 'ja', korean: 'ko', 한국어: 'ko',
  turkish: 'tr', türkçe: 'tr', russian: 'ru', русский: 'ru',
  hindi: 'hi', हिन्दी: 'hi', dutch: 'nl', nederlands: 'nl',
};

for (let first = 97; first <= 122; first += 1) {
  for (let second = 97; second <= 122; second += 1) {
    const code = String.fromCharCode(first, second);
    const name = names.of(code);
    if (name && name !== code) aliases[name.toLocaleLowerCase()] ??= code;
  }
}

export function languageName(code: string | null | undefined): string | null {
  if (!code || !/^[a-z]{2,3}(?:-[a-zA-Z]{2,8})?$/.test(code)) return null;
  const name = names.of(code);
  return name && name !== code ? name : null;
}

export function requestedLanguage(question: string): string | null {
  // Require an explicit language instruction so ordinary event questions mentioning
  // a country or language do not silently change the guest's preference.
  if (!/(?:\b(?:switch|change|continue|respond|reply|answer|write|chat|talk)\s+(?:to|in|with|using)\b|^\s*(?:please\s+)?(?:speak|use)\s+(?:in\s+)?|\b(?:can you|can we|could you|please|let's|from now on|i prefer|i want|i would like|i'd like)\b.{0,35}\b(?:speak|use|prefer)\b|\b(?:fol|flas|përgjigju|vazhdo|parle|parlez|réponds|habla|hablar|responde|sprich|sprechen|antworte|govori|pričaj|odgovori|nastavi)\b)/iu.test(question))
    return null;
  const normalized = question.toLocaleLowerCase();
  const matching = Object.entries(aliases)
    .filter(([name]) => new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'iu').test(normalized))
    .sort((left, right) => right[0].length - left[0].length);
  return matching[0]?.[1] ?? null;
}
