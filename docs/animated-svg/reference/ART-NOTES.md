# Balete Watcher scene fixture

The exact earlier reference (158,774 bytes, 1,540 paths; SHA-256
`ced84e44ec13e0e666cb69bce0cbe8c8bbd4ebf753405379dc7ba3484a975aac`)
was recovered and viewed. It is the 720×1080 in-chat version with fog,
lantern flicker, a subtle character movement, fireflies and an apparition
reveal. The exact original is intentionally kept separately from the
pipeline-ready, script-free scene.

- `balete_layered_baseline.svg`: separates the original 1,540 artwork paths
  into named environment, character, foreground, effects, and grading
  layers without SMIL. The prior animation instructions were extracted,
  not executed by the generation engine.
- `balete_refined.svg`: 720×1080 refined vector. The revised scene has 1,943
  paths, but its improvements are the visible forms, not the path count:
  uneven lantern-lit facial planes, independently riggable eyelid and mouth,
  folds that wrap the coat, brighter seams and satchel stitch marks, detailed
  suspended lantern and bent arm, rim-lit folds in the apparition, hanging
  roots, subtle lichen and two-shade shaped fronds with leaf vein detail.
- `balete_9x16.svg`: 720×1280 output viewport, composition reframed by
  horizontal viewport cropping rather than stretching artwork. It uses the
  same coordinates as the source SVG and works with the same rig and tracks.
- `animation.json`: a ten-second performance: breathing and independent
  blinks; faint glint; anticipation and recoil; rising light with follow-through
  at the wrist and satchel; eye contact and reveal; settle. The feet remain
  planted rather than drifting with a translation. Fog planes, vegetation,
  glow and firefly tracks move on separate time offsets.
- `rig.json`: fourteen named joints with explicit pivot/parent data and
  bounded rotation where applicable. This particular performance is an
  anticipation/hold/recoil benchmark, not a demonstration of every locomotion
  or dialogue capability. There is no spoken line in the original scene.
- `balete_motion_contact_sheet.png`: evaluated SVG snapshots at 0, 2.8, 3.5,
  4.2, 5.6 and 9.5 seconds, rasterized with Inkscape and inspected. The
  5.6-second frame is also exported as `balete_refined_preview.png`.

Both processed artwork files remain pure local vectors, with no script,
foreignObject, embedded image, or embedded animation element. The animation
file has 68 distinct track targets/properties; every track covers 0–10 seconds
and resolves to a real SVG identifier. The included derivation script is for
provenance, not a runtime dependency.
