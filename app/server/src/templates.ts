import { Engine, EngineError } from './engine.ts';
import { ulid } from '../../shared/src/index.ts';
import { DEFAULT_STYLE, validateStyle } from './captions/track.ts';
import { SECTION_KINDS } from './studios/script.ts';

export interface Template {
  id: string;
  kind: 'caption_style' | 'script_outline';
  name: string;
  content: any;
  builtin: boolean;
}

const BUILTINS: { kind: Template['kind']; name: string; content: unknown }[] = [
  { kind: 'caption_style', name: 'Bold Pop', content: DEFAULT_STYLE },
  { kind: 'caption_style', name: 'Clean Pill', content: { ...DEFAULT_STYLE, font_family: 'Arial Bold', pill: { enabled: true, color: '#000000', opacity: 0.6 }, stroke_width: 0, shadow: 0, active_word: { enabled: true, color: '#FFD400', pop: 0 }, animation: 'fade' } },
  { kind: 'caption_style', name: 'Minimal', content: { ...DEFAULT_STYLE, font_family: 'Arial Bold', stroke_width: 0.05, shadow: 0.2, active_word: { enabled: false, color: '#FFD400', pop: 0 }, animation: 'none' } },
  { kind: 'script_outline', name: 'Shorts: Hook-Intro-Main-Payoff-CTA', content: { description: 'Default Shorts structure', sections: [{ kind: 'hook', guidance: 'One striking line in the first 2 seconds' }, { kind: 'intro', guidance: 'Set up why this matters' }, { kind: 'main', guidance: 'The core story or explanation' }, { kind: 'payoff', guidance: 'The surprising answer or takeaway' }, { kind: 'cta', guidance: 'A short call to action' }] } },
  { kind: 'script_outline', name: 'Three surprising facts', content: { description: 'Listicle', sections: [{ kind: 'hook', guidance: 'Tease that three facts are coming' }, { kind: 'main', guidance: 'Fact one' }, { kind: 'main', guidance: 'Fact two' }, { kind: 'main', guidance: 'Fact three (the strongest)' }, { kind: 'cta', guidance: 'Ask which one surprised them' }] } },
  { kind: 'script_outline', name: 'Mini story', content: { description: 'Setup, conflict, twist, lesson', sections: [{ kind: 'hook', guidance: 'Drop into the moment' }, { kind: 'intro', guidance: 'Setup: who and where' }, { kind: 'main', guidance: 'Conflict: what went wrong' }, { kind: 'payoff', guidance: 'Twist or resolution' }, { kind: 'cta', guidance: 'Lesson or invitation to follow' }] } },
];

const bad = (m: string) => new EngineError('VALIDATION', m);

export function validateOutline(c: unknown) {
  const o = c as { sections?: { kind?: string; guidance?: string }[] };
  if (!o || !Array.isArray(o.sections) || !o.sections.length) throw bad('outline needs sections');
  for (const s of o.sections) if (!s || !SECTION_KINDS.includes(s.kind as never) || (s.guidance !== undefined && typeof s.guidance !== 'string')) throw bad(`outline sections need a valid kind (${SECTION_KINDS.join(', ')})`);
  return o;
}

export class TemplateService {
  engine: Engine;
  constructor(engine: Engine) {
    this.engine = engine;
    for (const b of BUILTINS) {
      this.engine.db.prepare('INSERT OR IGNORE INTO templates (id, kind, name, content_json, builtin, created_at) VALUES (?,?,?,?,1,?)').run(ulid(), b.kind, b.name, JSON.stringify(b.content), new Date().toISOString());
    }
  }
  private row(r: any): Template {
    return { id: r.id, kind: r.kind, name: r.name, content: JSON.parse(r.content_json), builtin: !!r.builtin };
  }
  list(kind?: string): Template[] {
    return (this.engine.db.prepare(`SELECT * FROM templates ${kind ? 'WHERE kind = ?' : ''} ORDER BY builtin DESC, name`).all(...(kind ? [kind] : [])) as any[]).map((r) => this.row(r));
  }
  get(id: string): Template {
    const r = this.engine.db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    if (!r) throw new EngineError('NOT_FOUND', `Template ${id} not found`);
    return this.row(r);
  }
  create(kind: string, name: string, content: unknown): Template {
    if (kind !== 'caption_style' && kind !== 'script_outline') throw bad('kind must be caption_style or script_outline');
    if (!name?.trim()) throw bad('name is required');
    if (kind === 'caption_style') validateStyle(content);
    else validateOutline(content);
    const id = ulid();
    try {
      this.engine.db.prepare('INSERT INTO templates (id, kind, name, content_json, builtin, created_at) VALUES (?,?,?,?,0,?)').run(id, kind, name.trim(), JSON.stringify(content), new Date().toISOString());
    } catch {
      throw new EngineError('VALIDATION', `A ${kind} template named "${name.trim()}" already exists`);
    }
    return this.get(id);
  }
  remove(id: string) {
    const t = this.get(id);
    if (t.builtin) throw new EngineError('PROTECTED', 'Built-in templates cannot be deleted');
    this.engine.db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  }
}
