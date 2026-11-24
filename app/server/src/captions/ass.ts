import type { CaptionStyle, CaptionWord } from './track.ts';
import { segmentWords } from './track.ts';
import type { FormatSpec, SafeZone } from '../render/formats.ts';

export interface PlacementOverride {
  from: number; // seconds on the timeline
  to: number;
  y_pct: number; // caption bottom edge as a fraction of frame height (0..1)
}

const assColor = (hex: string, alpha = 0) => `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
const t = (s: number) => {
  const cs = Math.round(Math.max(0, s) * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const esc = (s: string) => s.replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\n/g, ' ');

export interface AssOptions {
  words: CaptionWord[];
  style: CaptionStyle;
  format: FormatSpec;
  zone: SafeZone;
  /** Shift all times (used to render a single scene or preview frame). */
  offset?: number;
  placement?: PlacementOverride[];
}

/**
 * Build an ASS script. Each segment is shown as one line; with active-word highlighting every word
 * gets its own event so only the spoken word is coloured (and optionally popped). Font size is fitted
 * per segment so a line can never run outside the safe zone.
 */
export function buildAss(o: AssOptions): string {
  const { format: f, zone: z, style: s } = o;
  const off = o.offset ?? 0;
  const baseSize = f.height * z.font_scale * s.font_scale;
  const safeW = f.width * z.max_width_frac;
  const marginL = Math.round(f.width * z.left);
  const marginR = Math.round(f.width * z.right);
  const marginV = Math.round(f.height * z.bottom);
  const cx = Math.round(marginL + (f.width - marginL - marginR) / 2);
  const outline = Math.max(0, Math.round(baseSize * s.stroke_width));
  const shadow = Math.round(baseSize * 0.06 * s.shadow * 4);
  const borderStyle = s.pill.enabled ? 3 : 1;
  const back = s.pill.enabled ? assColor(s.pill.color, Math.round((1 - s.pill.opacity) * 255)) : assColor('#000000', 255);
  const outlineCol = s.pill.enabled ? back : assColor(s.stroke_color);

  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${f.width}`,
    `PlayResY: ${f.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${s.font_family},${Math.round(baseSize)},${assColor(s.color)},${assColor(s.color)},${outlineCol},${back},${s.bold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${s.pill.enabled ? Math.round(baseSize * 0.22) : outline},${s.pill.enabled ? 0 : shadow},2,${marginL},${marginR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const segs = segmentWords(o.words, { maxWords: z.max_words, maxChars: z.max_chars });
  const lines: string[] = [];
  for (const seg of segs) {
    const label = (i: number) => (s.uppercase ? o.words[i].text.toUpperCase() : o.words[i].text);
    const fullChars = seg.words.reduce((n, i) => n + label(i).length + 1, -1);
    // fit: average glyph width is roughly 0.56em for bold caption faces
    const fitSize = Math.min(baseSize, safeW / (Math.max(1, fullChars) * 0.56 * (s.bold ? 1.05 : 1)));
    const sizeTag = fitSize < baseSize ? `\\fs${Math.round(fitSize)}` : '';
    const place = o.placement?.find((p) => seg.start < p.to && seg.end > p.from);
    const posTag = place ? `\\an2\\pos(${cx},${Math.round(f.height * place.y_pct)})` : '';
    const anim = s.animation === 'fade' ? '\\fad(90,0)' : '';

    if (s.active_word.enabled) {
      seg.words.forEach((wi, k) => {
        const start = o.words[wi].start;
        const end = k < seg.words.length - 1 ? o.words[seg.words[k + 1]].start : Math.max(o.words[wi].end, seg.end);
        const text = seg.words
          .map((wj) => {
            const active = wj === wi;
            const pop = active && s.active_word.pop > 0 ? `\\fscx${Math.round(100 + s.active_word.pop * 100)}\\fscy${Math.round(100 + s.active_word.pop * 100)}` : '';
            return active ? `{\\c${assColor(s.active_word.color)}${pop}}${esc(label(wj))}{\\c${assColor(s.color)}\\fscx100\\fscy100}` : esc(label(wj));
          })
          .join(' ');
        lines.push(`Dialogue: 0,${t(start - off)},${t(end - off)},Cap,,0,0,0,,{${sizeTag}${posTag}${k === 0 ? anim : ''}}${text}`);
      });
    } else {
      const text = seg.words.map((wj) => esc(label(wj))).join(' ');
      lines.push(`Dialogue: 0,${t(seg.start - off)},${t(seg.end - off)},Cap,,0,0,0,,{${sizeTag}${posTag}${anim}}${text}`);
    }
  }
  return [...head, ...lines, ''].join('\n');
}
