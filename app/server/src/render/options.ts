// Everything the screens need to offer the cinematic choices, taken from the same lists the renderer validates against.
import { CINEMATIC_MOVEMENTS, DIRECTIONS, EASINGS, INTENSITIES, MOVEMENTS } from './camera.ts';
import { COLORED, DEFAULT_SECONDS, EASABLE, TRANSITIONS, TRANSITION_DIRECTIONS, TRANSITION_INTENSITIES, TRANSITION_OVERLAYS, TRANSITION_SOUNDS } from './transitions.ts';
import { AMBIENCES, CAPTION_LOOKS, GRADINGS, PARAMS, STYLES, STYLE_IDS } from './styles.ts';

const label = (id: string) => id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Moves that suggest depth or rotation a flat picture does not have. */
const SIMULATED = ['parallax', 'dolly_in', 'dolly_out', 'tilt_up', 'tilt_down', 'crane_up', 'crane_down', 'orbit', 'handheld', 'impact_shake', 'whip_pan'];

export function cinematicOptions() {
  return {
    cameras: MOVEMENTS.map((id) => ({ id, label: label(id), cinematic: (CINEMATIC_MOVEMENTS as readonly string[]).includes(id), directions: DIRECTIONS[id], simulated: SIMULATED.includes(id) })),
    intensities: INTENSITIES,
    easings: EASINGS,
    transitions: TRANSITIONS.map((id) => ({ id, label: id === 'match_cut' ? 'Match cut (approximation)' : label(id), directions: TRANSITION_DIRECTIONS[id] ?? [], easable: EASABLE.includes(id), colored: COLORED.includes(id), seconds: DEFAULT_SECONDS[id] })),
    transitionIntensities: TRANSITION_INTENSITIES,
    sounds: TRANSITION_SOUNDS,
    overlays: TRANSITION_OVERLAYS,
    styles: STYLE_IDS.map((id) => ({ id, label: STYLES[id].label, summary: STYLES[id].summary, params: STYLES[id].params })),
    params: Object.entries(PARAMS).map(([id, p]) => ({ id, ...p })),
    gradings: GRADINGS,
    captionLooks: CAPTION_LOOKS,
    ambiences: AMBIENCES,
  };
}
