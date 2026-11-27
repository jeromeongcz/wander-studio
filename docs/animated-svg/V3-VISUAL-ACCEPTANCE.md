# Wander Animated SVG v3: live visual acceptance

This is a manual acceptance protocol, not a pass or an artwork claim. Test a clean run from the current `animated-svg` branch and an authenticated Codex or Claude provider whose Settings status is ready.

Use a disposable project, 9:16, two synthetic scenes. Do not reuse the rejected Balete draft or change the approved Tondo still.

1. **Archival Sepia.** A bookbinder at a late-afternoon workshop window, three-quarter view, raises a small brass ruler from a workbench. The visible hand bends naturally around the ruler. Workbench and tool rack are separate from the foreground figure; the silhouette remains clear against the window. Use old-paper tones, warm reflections, varied ink density, and subdued headline-free lower space. Request a single shallow breath and steady hand movement, not a full redraw.
2. **Dark Folklore.** A traveler pauses beside a mangrove inlet at moonrise and turns their head toward a reflected light. Use strong moonlit contours, organic branch shapes, shallow water reflection, distinct mist planes, a foreground reed silhouette and restrained highlights. Keep feet planted and let mist and reflected glow drift independently.

## Verification sequence

- Before running animation, generate a static comparison from each brief. Review the original at normal size as well as a narrow 360 px-wide preview. Preserve the still and its prompt; do not regenerate it from an animated asset.
- In Storyboard, request detailed layered artwork via Animated SVG. Record provider/model, branch SHA, project settings, and the exact copyable artwork and motion prompts **after** the generation that used them. Inspect the SVG group names and note which layers can move without exposing holes.
- Check the central silhouette, perspective, natural proportions/pose, light, surface treatment, focal hierarchy and readability in each 360×640 preview. Compare the Archival Sepia result to the approved Tondo still for visual richness, not matching composition. If artwork looks primitive, tangled, flat, or substantially degraded against its static comparison, reject it before approving motion; repeat targeted refinements rather than lowering the quality bar.
- Preview start, middle and end. Check for planted-foot or anchored-prop drift, contour seams, layer discontinuities, unintended camera movement, moving foreground/background correlation and changes to controlled silhouette. Record discrepancies for correction.
- Render a short MP4 only after the artwork/motion gates. Confirm playback and correct duration, read dimensions/FPS/codec with FFprobe, then build a mixed timeline against existing audio/transition settings if available. Record the clips and previews separately from implementation tests.
