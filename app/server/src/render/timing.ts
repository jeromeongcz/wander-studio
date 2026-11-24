// Scene timing derived from MEASURED narration: the narration's actual word times are authoritative.

export interface SceneIn {
  scene_id: string;
  script_segment_id: string;
  segment_text?: string;
  target_duration: number;
}
export interface TimedWord {
  section_id: string;
  start: number;
  end: number;
}
export interface SceneTime {
  scene_id: string;
  start: number;
  duration: number;
  source: 'audio' | 'estimate';
}

const wc = (s?: string) => (s ?? '').split(/\s+/).filter(Boolean).length;

/**
 * Give each scene the stretch of narration it visualises. Scenes of a section split that section's
 * words in order (by their segment_text word counts, or by target duration when unknown); a scene
 * starts at its first word. The first scene starts at 0 and the last runs to `total`. Scenes whose
 * section has no narration fall back to their target duration.
 */
export function computeSceneTimes(scenes: SceneIn[], words: TimedWord[], total: number): SceneTime[] {
  const bySection = new Map<string, TimedWord[]>();
  for (const w of words) bySection.set(w.section_id, [...(bySection.get(w.section_id) ?? []), w]);
  const scenesBySection = new Map<string, number[]>();
  scenes.forEach((s, i) => scenesBySection.set(s.script_segment_id, [...(scenesBySection.get(s.script_segment_id) ?? []), i]));

  const anchor: (number | null)[] = scenes.map(() => null);
  for (const [section, idxs] of scenesBySection) {
    const w = bySection.get(section);
    if (!w || !w.length) continue;
    const counts = idxs.map((i) => wc(scenes[i].segment_text));
    const known = counts.every((c) => c > 0);
    const weights = known ? counts : idxs.map((i) => scenes[i].target_duration);
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let used = 0;
    idxs.forEach((i, k) => {
      const first = Math.min(w.length - 1, Math.round((used / sum) * w.length));
      anchor[i] = w[first].start;
      used += weights[k];
    });
  }

  const starts: number[] = [];
  const estimated: boolean[] = [];
  scenes.forEach((s, i) => {
    if (i === 0) return (starts.push(0), estimated.push(anchor[0] === null));
    const prevEnd = starts[i - 1] + scenes[i - 1].target_duration;
    const a = anchor[i];
    const start = a === null ? prevEnd : Math.max(a, starts[i - 1] + 0.3);
    starts.push(start);
    estimated.push(a === null);
  });
  return scenes.map((s, i) => {
    const end = i < scenes.length - 1 ? starts[i + 1] : Math.max(total, starts[i] + 0.5);
    return { scene_id: s.scene_id, start: round(starts[i]), duration: round(Math.max(0.3, end - starts[i])), source: estimated[i] ? 'estimate' : 'audio' };
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;
