// Opt-in: prepare two disposable projects on the local Wander instance. No model calls or artwork approvals.
import { requireSupportedNode } from './runtime.mjs';

if (!requireSupportedNode()) process.exit(1);
const port = Number(process.argv[2] ?? 4317);
if (process.argv.length > 3 || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Usage: node scripts/seed-svg-acceptance.mjs [local Wander port]');
  process.exit(1);
}
const base = 'http://127.0.0.1:' + port;
const protocol = 'https://github.com/jeromeongcz/wander-studio/blob/animated-svg/docs/animated-svg/V3-VISUAL-ACCEPTANCE.md';
const fixtures = [
  {
    title: 'Bookbinder at the window', style: 'archival-sepia', look: 'Archival Sepia',
    text: 'The bookbinder lifts a small brass ruler into the light.',
    brief: 'Archival Sepia, vertical 9:16. Three-quarter view of a bookbinder at a late-afternoon workshop window reaching to lift a small brass ruler. Show a natural grip, believable proportions and readable silhouette. Use warm reflected light, varied ink lines, muted sepia paper tones and subtle wood and cloth texture. Keep the figure, workbench, tool rack and window visually distinct. Leave the lower fifth quiet for captions. No visible lettering.',
    action: 'Raise the ruler slightly with a steady grip. Add one shallow breath. Keep the workbench and camera still.',
  },
  {
    title: 'Moonlit mangrove inlet', style: 'dark-folklore', look: 'Dark Folklore',
    text: 'A traveler stops at the inlet as a reflection passes over the water.',
    brief: 'Dark Folklore, vertical 9:16. A traveler pauses at a moonlit mangrove inlet and notices a reflected light. Show strong moonlit contours, organic branches, shallow water reflection, distinct mist planes and a foreground reed silhouette. Keep highlights restrained and leave the lower fifth quiet for captions. No lettering or disconnected geometric figures.',
    action: 'With feet planted, turn the head toward the light. Let mist and reflected glow drift independently. Keep the camera still.',
  },
];

async function request(method, path, body) {
  const response = await fetch(base + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${result.error?.message ?? response.status}`);
  return result;
}
const read = path => request('GET', path);
const save = (id, content) => request('PUT', `/artifacts/${id}/content`, { content });
const approveFixtureMetadata = async id => {
  await request('POST', `/artifacts/${id}/submit`);
  await request('POST', `/artifacts/${id}/approve`, {});
};

try {
  if ((await read('/health')).ok !== true) throw new Error('A ready Wander Studio server was not found.');
  const existing = await read('/projects');
  for (const fixture of fixtures) {
    const name = 'SVG acceptance fixture: ' + fixture.look;
    const duplicate = existing.find(project => project.name === name);
    if (duplicate) {
      console.log(`Already exists; not modified: ${name} (${base}/#/p/${duplicate.id}/storyboard)`);
      continue;
    }
    const project = await request('POST', '/projects', { name, category: 'Story', languages: ['en'], formats: ['vertical_9x16'] });
    const { artifacts } = await read('/projects/' + project.id);
    const id = kind => {
      const artifact = artifacts.find(item => item.kind === kind);
      if (!artifact) throw new Error('Missing project artifact: ' + kind);
      return artifact.id;
    };
    const research = id('research');
    await save(research, { ...project.researchTemplate,
      sources: [{ id: 'fixture', title: 'Synthetic QA brief; no factual claims', url: protocol }],
      checklist: project.researchTemplate.checklist.map(item => ({ ...item, done: true })),
    });
    await approveFixtureMetadata(research);
    const script = id('script_base');
    await save(script, { title: fixture.title, lang: 'en', preset: 'short_lt30', sections: [{ id: 'hook', kind: 'hook', text: fixture.text }] });
    await approveFixtureMetadata(script);
    const storyboard = id('storyboard');
    await request('POST', `/artifacts/${storyboard}/seed-storyboard`, { scene_seconds: 4 });
    const { content } = await read('/artifacts/' + storyboard);
    const scene = { ...content.scenes[0], title: fixture.title, draft: false, target_duration: 4, visual_description: fixture.brief,
      visual_style: fixture.look, camera: { movement: 'static', intensity: 'subtle' },
      animation_plan: { mode: 'animated', duration: 4, beats: [{ start: 0, end: 4, actor: 'main subject', action: fixture.action }] },
    };
    await save(storyboard, { ...content, scenes: [scene] });
    await request('PUT', `/projects/${project.id}/animated-svg-settings`, { mode: 'mixed', style: fixture.style, reuseApproved: false });
    console.log(`Prepared ${name}: ${base}/#/p/${project.id}/storyboard`);
  }
  console.log('No art was generated or approved. Generate each regular still and layered artwork before reviewing motion.');
} catch (error) {
  console.error(`Could not prepare live fixtures on ${base}: ${error?.message ?? error}. Start Wander and confirm the port. Any existing fixture projects were left untouched.`);
  process.exitCode = 1;
}
