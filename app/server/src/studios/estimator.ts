// Duration estimation from calibrated words-per-minute, per language.
// Defaults are uncalibrated starting points; measured narration samples replace them.

export const DEFAULT_WPM: Record<string, number> = { en: 150, tl: 135, taglish: 145 };
export const FALLBACK_WPM = 145;
export const MIN_CALIBRATION_SAMPLES = 3;

export const PRESETS = {
  short_lt30: { label: 'Shorts under 30s', min: 10, max: 30, hardMax: 60 },
  short_30_45: { label: 'Shorts 30-45s', min: 30, max: 45, hardMax: 60 },
  short_45_60: { label: 'Shorts 45-60s', min: 45, max: 60, hardMax: 60 },
  long: { label: 'Long-form', min: 0, max: Infinity, hardMax: Infinity },
  custom: { label: 'Custom target', min: 0, max: Infinity, hardMax: Infinity },
} as const;
export type PresetId = keyof typeof PRESETS;
export const isPreset = (x: unknown): x is PresetId => typeof x === 'string' && x in PRESETS;

export interface CalibrationSample {
  words: number;
  seconds: number;
}

export function countWords(text: string): number {
  // Letters/digits with internal apostrophes and hyphens count as one word (e.g. "mag-aral", "don't").
  return text
    .replace(/[^\p{L}\p{N}'’\-\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function resolveWpm(lang: string, samples: CalibrationSample[] = [], defaultWpm?: number): { wpm: number; source: 'calibrated' | 'default'; samples: number } {
  const valid = samples.filter((s) => s.words >= 5 && s.seconds > 0);
  if (valid.length >= MIN_CALIBRATION_SAMPLES) {
    return { wpm: Math.round(median(valid.map((s) => (s.words / s.seconds) * 60))), source: 'calibrated', samples: valid.length };
  }
  return { wpm: defaultWpm ?? DEFAULT_WPM[lang] ?? FALLBACK_WPM, source: 'default', samples: valid.length };
}

export interface EstimateInput {
  sections: { text: string }[];
  lang: string;
  preset?: PresetId;
  targetSeconds?: number;
  samples?: CalibrationSample[];
  defaultWpm?: number;
}

export interface Estimate {
  words: number;
  wpm: number;
  wpmSource: 'calibrated' | 'default';
  calibrationSamples: number;
  seconds: number;
  fit: 'under' | 'ok' | 'over' | 'unknown';
  overHardLimit: boolean;
  note: string;
}

export function estimate(input: EstimateInput): Estimate {
  const { wpm, source, samples } = resolveWpm(input.lang, input.samples, input.defaultWpm);
  const text = input.sections.map((s) => s.text).join('\n');
  const words = input.sections.reduce((n, s) => n + countWords(s.text), 0);
  const sentencePauses = (text.match(/[.!?…]+/g) ?? []).length * 0.35;
  const commaPauses = (text.match(/[,;:—]/g) ?? []).length * 0.15;
  const sectionGaps = Math.max(0, input.sections.filter((s) => countWords(s.text) > 0).length - 1) * 0.3;
  const seconds = Math.round(((words / wpm) * 60 + sentencePauses + commaPauses + sectionGaps) * 10) / 10;

  let fit: Estimate['fit'] = 'unknown';
  let overHardLimit = false;
  const preset = input.preset ? PRESETS[input.preset] : undefined;
  if (preset && Number.isFinite(preset.max)) {
    fit = seconds < preset.min ? 'under' : seconds > preset.max ? 'over' : 'ok';
    overHardLimit = seconds > preset.hardMax;
  } else if (input.targetSeconds && input.targetSeconds > 0) {
    fit = seconds < input.targetSeconds * 0.9 ? 'under' : seconds > input.targetSeconds * 1.1 ? 'over' : 'ok';
  }
  const note = source === 'default' ? `Uncalibrated ${wpm} WPM default for "${input.lang}"; add narration samples to calibrate.` : `Calibrated ${wpm} WPM from ${samples} samples.`;
  return { words, wpm, wpmSource: source, calibrationSamples: samples, seconds, fit, overHardLimit, note };
}
