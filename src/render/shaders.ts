/**
 * Shaders for the liquid and the glass.
 *
 * The look the concept asks for is photoreal liquid over illustrated art, and
 * the thing that sells it is refraction: the background has to bend and shift
 * behind the liquid, and the liquid has to have a surface with weight. So:
 *
 *  1. Splat particles into a density field (additive).
 *  2. Threshold that field for the surface, and take its gradient for a normal.
 *  3. Refract the painted background through that normal, absorb light through
 *     the depth (Beer-Lambert), then add specular and a Fresnel rim.
 *
 * Working from a density field rather than drawing discs is what makes the
 * result read as one connected body of liquid rather than as particles.
 */

export const DENSITY_VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;      // unit quad, -1..1
layout(location = 1) in vec2 aCentre;      // particle position, world space
layout(location = 2) in vec2 aVelocity;    // particle velocity, world space

uniform vec2 uViewOrigin;   // world coords of the bottom-left of the viewport
uniform vec2 uViewSize;     // viewport size in world units
uniform float uRadius;      // splat radius in world units
uniform float uStretch;     // how much speed elongates a splat

out vec2 vLocal;
out float vSpeed;

void main() {
  vLocal = aCorner;
  float speed = length(aVelocity);
  vSpeed = speed;

  // Stretch the splat along its velocity. A falling stream emits particles
  // further apart than they are wide, so round splats read as a string of
  // beads; elongating them makes the stream a continuous rope while a settled
  // pool, moving slowly, stays round.
  vec2 dir = speed > 1e-4 ? aVelocity / speed : vec2(0.0, 1.0);
  vec2 side = vec2(-dir.y, dir.x);
  float along = 1.0 + min(speed * uStretch, 2.6);
  vec2 offset = dir * (aCorner.y * uRadius * along) + side * (aCorner.x * uRadius);

  vec2 world = aCentre + offset;
  vec2 ndc = (world - uViewOrigin) / uViewSize * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

export const DENSITY_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
in float vSpeed;

layout(location = 0) out vec4 oDensity;

void main() {
  float r2 = dot(vLocal, vLocal);
  if (r2 > 1.0) discard;
  // Smooth, compactly supported falloff. Squaring keeps the field smooth enough
  // that its gradient is usable as a surface normal.
  float falloff = 1.0 - r2;
  float density = falloff * falloff * falloff;
  // R: density. G: speed-weighted density, which becomes foam. B: raw coverage.
  oDensity = vec4(density, density * vSpeed, density, 1.0);
}
`;

/** Fullscreen pass shared by the composite steps. */
export const FULLSCREEN_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
out vec2 vUv;
void main() {
  vUv = aCorner * 0.5 + 0.5;
  gl_Position = vec4(aCorner, 0.0, 1.0);
}
`;

export const LIQUID_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 oColour;

uniform sampler2D uDensity;
uniform sampler2D uBackground;
uniform vec2 uTexel;           // 1 / density target size
uniform float uThreshold;      // density at the liquid surface
uniform vec3 uLiquidColour;    // absorption tint
uniform vec3 uLightColour;
uniform vec2 uLightDir;
uniform float uRefraction;
uniform float uTime;

float densityAt(vec2 uv) {
  return texture(uDensity, uv).r;
}

void main() {
  vec4 field = texture(uDensity, vUv);
  float density = field.r;

  // Surface coverage, antialiased across roughly one texel of the field.
  float edge = uThreshold * 0.45;
  float coverage = smoothstep(uThreshold - edge, uThreshold + edge, density);
  if (coverage <= 0.001) {
    oColour = vec4(texture(uBackground, vUv).rgb, 0.0);
    return;
  }

  // Gradient of the density field is the surface normal. Sampling a couple of
  // texels out gives a smoother normal than immediate neighbours, which matters
  // because the field is built from discrete splats.
  // A wider stencil than the immediate neighbours: the field is built from
  // discrete splats, and a tight stencil turns their packing into visible dots.
  vec2 step = uTexel * 2.6;
  float dx = densityAt(vUv + vec2(step.x, 0.0)) - densityAt(vUv - vec2(step.x, 0.0));
  float dy = densityAt(vUv + vec2(0.0, step.y)) - densityAt(vUv - vec2(0.0, step.y));
  vec3 normal = normalize(vec3(-dx, -dy, 0.35));

  // Thickness: how far past the surface this fragment is. Drives both how much
  // the background bends and how much light is absorbed.
  float thickness = clamp((density - uThreshold) / max(uThreshold, 0.0001), 0.0, 3.0);
  float bend = uRefraction * (0.35 + 0.65 * min(thickness, 1.0));
  vec2 refracted = vUv + normal.xy * bend;

  vec3 behind = texture(uBackground, clamp(refracted, vec2(0.001), vec2(0.999))).rgb;

  // Beer-Lambert absorption through the body of the liquid.
  vec3 absorb = exp(-(1.0 - uLiquidColour) * thickness * 1.5);
  vec3 body = behind * absorb;

  // Specular: a tight highlight on the crest of the surface.
  vec3 light = normalize(vec3(uLightDir, 0.72));
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 halfway = normalize(light + view);
  float specular = pow(max(dot(normal, halfway), 0.0), 42.0);

  // Fresnel: edges of the body go bright and glassy.
  float fresnel = pow(1.0 - clamp(normal.z, 0.0, 1.0), 3.0);

  // Foam: fast-moving, thin liquid goes white — the leading edge of a pour and
  // the churn where the stream lands.
  float speed = field.g / max(field.b, 0.0001);
  float foam = smoothstep(1.4, 3.4, speed) * (1.0 - smoothstep(0.35, 1.1, thickness));

  vec3 colour = body;
  colour += uLightColour * specular * 0.85;
  colour += uLightColour * fresnel * 0.28;
  colour = mix(colour, mix(colour, vec3(1.0), 0.72), clamp(foam, 0.0, 1.0));

  // A touch of internal brightening low in the body, so a filled glass glows
  // rather than reading as a flat dark mass.
  colour += uLiquidColour * uLightColour * 0.05 * min(thickness, 1.5);

  oColour = vec4(colour, coverage);
}
`;

/**
 * Glass and obstacles, drawn as capsules evaluated in the fragment shader.
 * One quad per wall, with a real distance field inside it: rounded ends,
 * antialiased edges, and a refractive body, all without tessellation.
 */
export const SOLID_VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSegment;   // xy = A, zw = B, world space
layout(location = 2) in vec4 aStyle;     // x = radius, y = kind, z = tintA, w = gloss

uniform vec2 uViewOrigin;
uniform vec2 uViewSize;

out vec2 vWorld;
out vec4 vSegment;
out vec4 vStyle;

void main() {
  vec2 a = aSegment.xy;
  vec2 b = aSegment.zw;
  vec2 axis = b - a;
  float len = max(length(axis), 1e-5);
  vec2 dir = axis / len;
  vec2 side = vec2(-dir.y, dir.x);

  // Expand the quad to cover the capsule plus a margin for the soft edge.
  float pad = aStyle.x * 2.2;
  vec2 centre = (a + b) * 0.5;
  vec2 world = centre + dir * aCorner.x * (len * 0.5 + pad) + side * aCorner.y * pad;

  vWorld = world;
  vSegment = aSegment;
  vStyle = aStyle;
  vec2 ndc = (world - uViewOrigin) / uViewSize * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

export const SOLID_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vWorld;
in vec4 vSegment;
in vec4 vStyle;

layout(location = 0) out vec4 oColour;

uniform sampler2D uBackground;
uniform vec2 uViewOrigin;
uniform vec2 uViewSize;
uniform vec2 uLightDir;
uniform vec3 uLightColour;
uniform float uPixelWorld;   // world units per pixel, for edge antialiasing

void main() {
  vec2 a = vSegment.xy;
  vec2 b = vSegment.zw;
  vec2 axis = b - a;
  float t = clamp(dot(vWorld - a, axis) / max(dot(axis, axis), 1e-9), 0.0, 1.0);
  vec2 nearest = a + axis * t;
  vec2 offset = vWorld - nearest;
  float dist = length(offset);
  float radius = vStyle.x;

  // Signed distance to the capsule surface.
  float sd = dist - radius;
  float aa = max(uPixelWorld * 1.2, 1e-5);
  float inside = 1.0 - smoothstep(-aa, aa, sd);
  if (inside <= 0.002) discard;

  vec2 normal2 = dist > 1e-6 ? offset / dist : vec2(0.0, 1.0);
  // Curve the normal towards the viewer in the middle of the body, so the wall
  // reads as a rounded solid rather than a flat stripe.
  float across = clamp(dist / max(radius, 1e-5), 0.0, 1.0);
  vec3 normal = normalize(vec3(normal2 * across, sqrt(max(1.0 - across * across, 0.02))));

  vec2 uv = (vWorld - uViewOrigin) / uViewSize;
  // Glass bends what is behind it, strongest where it curves away.
  vec2 refracted = uv + normal.xy * 0.028 * (1.0 - normal.z);
  vec3 behind = texture(uBackground, clamp(refracted, vec2(0.001), vec2(0.999))).rgb;

  vec3 light = normalize(vec3(uLightDir, 0.7));
  vec3 halfway = normalize(light + vec3(0.0, 0.0, 1.0));
  float specular = pow(max(dot(normal, halfway), 0.0), vStyle.w);
  float fresnel = pow(1.0 - clamp(normal.z, 0.0, 1.0), 2.2);

  // Obstacles (kind = 1) are opaque props; glass (kind = 0) is transparent.
  float solidness = vStyle.y > 0.5 ? 1.0 : vStyle.z;
  vec3 material = vStyle.y > 0.5 ? vec3(0.30, 0.27, 0.25) : vec3(0.86, 0.92, 0.95);

  vec3 colour = mix(behind, material, solidness * (0.35 + 0.5 * fresnel));
  colour += uLightColour * specular * (vStyle.y > 0.5 ? 0.35 : 0.9);
  colour += uLightColour * fresnel * (vStyle.y > 0.5 ? 0.05 : 0.22);

  oColour = vec4(colour, inside);
}
`;

/** Background blit, and the place the vignette/level tint is applied. */
export const BACKGROUND_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 oColour;
uniform sampler2D uBackground;
void main() {
  oColour = vec4(texture(uBackground, vUv).rgb, 1.0);
}
`;
