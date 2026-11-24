import { EngineError } from '../engine.ts';

export interface FormatSpec {
  id: string;
  width: number;
  height: number;
  fps: number;
  bitrate?: string;
  orientation: 'portrait' | 'landscape' | 'square';
}

const PRESETS: Record<string, { width: number; height: number }> = {
  vertical_9x16: { width: 1080, height: 1920 },
  horizontal_16x9: { width: 1920, height: 1080 },
  square_1x1: { width: 1080, height: 1080 },
};

const orient = (w: number, h: number): FormatSpec['orientation'] => (h / w > 1.2 ? 'portrait' : w / h > 1.2 ? 'landscape' : 'square');

/** Preset ids, or custom ids shaped custom_<W>x<H>[_<fps>] (even dimensions, 240..7680). */
export function parseFormat(id: string, opts: { fps?: number; bitrate?: string } = {}): FormatSpec {
  const preset = PRESETS[id];
  let width: number;
  let height: number;
  let fps = opts.fps ?? 30;
  if (preset) ({ width, height } = preset);
  else {
    const m = id.match(/^custom_(\d{3,4})x(\d{3,4})(?:_(\d{2,3}))?$/);
    if (!m) throw new EngineError('VALIDATION', `Unknown format "${id}". Use ${Object.keys(PRESETS).join(', ')} or custom_<W>x<H>[_<fps>]`);
    width = Number(m[1]);
    height = Number(m[2]);
    if (m[3]) fps = Number(m[3]);
  }
  if (width % 2 || height % 2 || width < 240 || height < 240 || width > 7680 || height > 7680) throw new EngineError('VALIDATION', 'Format dimensions must be even numbers between 240 and 7680');
  if (!(fps >= 10 && fps <= 120)) throw new EngineError('VALIDATION', 'fps must be between 10 and 120');
  return { id, width, height, fps, bitrate: opts.bitrate, orientation: orient(width, height) };
}

/**
 * Caption safe zones as fractions of the frame. Vertical keeps captions in the lower-centre band,
 * above the Shorts title/description area and clear of the right-hand action buttons; horizontal
 * uses the lower third; square sits in the lower quarter.
 */
export interface SafeZone {
  id: string;
  left: number;
  right: number; // fraction of width reserved on the right
  bottom: number; // fraction of height reserved below the caption block
  max_width_frac: number;
  font_scale: number; // font size as a fraction of frame height
  max_words: number;
  max_chars: number;
}

export const SAFE_ZONES: Record<FormatSpec['orientation'], SafeZone> = {
  portrait: { id: 'shorts-9x16', left: 0.07, right: 0.15, bottom: 0.22, max_width_frac: 0.78, font_scale: 0.044, max_words: 4, max_chars: 24 },
  landscape: { id: 'wide-16x9', left: 0.08, right: 0.08, bottom: 0.1, max_width_frac: 0.84, font_scale: 0.058, max_words: 10, max_chars: 56 },
  square: { id: 'square-1x1', left: 0.07, right: 0.07, bottom: 0.14, max_width_frac: 0.86, font_scale: 0.052, max_words: 5, max_chars: 30 },
};

export const safeZoneFor = (f: FormatSpec): SafeZone => SAFE_ZONES[f.orientation];
