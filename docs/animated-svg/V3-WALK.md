# Planted-foot walk for Animated SVG

For a side-profile walk, approve articulated artwork, enable **Advanced** complexity and **Character animation**, then ask for a short walk in the Storyboard Animation tab. The provider is given the real group IDs and any approved rig. Start with a moderate stride. This works locally on imports too: a compatible animation JSON can supply `walk`, and Wander saves the resulting validated keyframe tracks.

The body is one named SVG group. Each leg needs its own thigh group under the body, shin nested in the thigh, and foot nested in the shin. Draw both legs straight down in the unposed SVG, using the artwork’s coordinate units for hip, thigh, shin and ground measurements. The two arms are optional. Static placement on the body or a surrounding scene group is fine. Do not add separate animated transforms on any controlled joint or its ancestors.

Example for one specific rig. Replace all IDs and measurements with those from your artwork:

```json
{
  "duration": 2.6,
  "walk": {
    "root": "walker",
    "left": {"upper": "leftThigh", "lower": "leftShin", "foot": "leftFoot", "hip": [0, 150], "thigh": 45, "shin": 42},
    "right": {"upper": "rightThigh", "lower": "rightShin", "foot": "rightFoot", "hip": [4, 150], "thigh": 45, "shin": 42},
    "groundY": 230,
    "start": 0.2,
    "steps": 4,
    "stepSeconds": 0.55,
    "stepLength": 24,
    "lift": 11,
    "bob": 2,
    "armSwing": 13,
    "leftArm": {"group": "leftArm", "pivot": [-13, 68]},
    "rightArm": {"group": "rightArm", "pivot": [10, 70]},
    "direction": "right"
  }
}
```

The engine allows one to four steps per shot and rejects unreachable foot targets, conflicting transforms, or changes to approved joint pivots and rotation limits. If it rejects the walk, shorten the step or reduce the body rise. For a longer action, use multiple shots rather than exceeding the shot's step budget. The current solver does not generate turning, running, automatic limb segmentation, or camera tracking. Always preview on your own art before approving.
