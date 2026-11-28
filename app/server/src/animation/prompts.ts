import { buildSketchPrompt, type SketchPromptOptions } from '../research/sketch.ts';
import type { Scene } from '../studios/storyboard.ts';
import type { SceneAnimationPlan } from './direction.ts';
import { ANIMATED_SVG_ARTWORK_RULES } from './prompt-directives.ts';
export { buildBaseArtworkPrompt, generationRequestPrompt, buildAnimationPreparationPrompt, buildAnimatedMotionPrompt, buildTargetedArtworkRefinementPrompt, buildTargetedMotionRefinementPrompt, buildRenderedReviewPrompt } from './prompt-directives.ts';

/** Preserve the shipped still prompt byte-for-byte as the starting point; append only layered requirements. */
export function buildAnimatedSketchPrompt(scene: Scene, o: SketchPromptOptions, plan?: SceneAnimationPlan): string {
  const output = [buildSketchPrompt(scene, o), '', 'Layered artwork preparation (same fully finished SVG illustration, no motion yet):', ANIMATED_SVG_ARTWORK_RULES];
  const suggestion = plan ?? scene.animation_plan;
  if (suggestion) output.push('The following approved or draft storyboard movement plan is reference data only. Use it to decide which elements need drawable groups; do not implement a timeline in this SVG.', JSON.stringify(suggestion));
  return output.join('\n');
}
