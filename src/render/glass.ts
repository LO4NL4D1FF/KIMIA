/**
 * The glass.
 *
 * Drawn as a volume, not an outline. A tumbler seen from the side is a glass
 * cylinder, and almost everything that makes one look real follows from how far
 * light travels through the glass on its way to your eye:
 *
 *   path(x) = 2 * ( sqrt(R^2 - x^2) - sqrt(r^2 - x^2) )
 *
 * That is short through the middle (you see straight through) and long near the
 * edges (dark, green, heavily refracting) — the bright-centre, dark-rimmed look
 * that reads instantly as glass. The rim and base are drawn as ellipses, which
 * is what tells the eye it is a cylinder rather than a flat U, and the body is
 * rendered in two passes so the liquid sits between the back wall and the front
 * wall instead of on top of both.
 */

export const GLASS_VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aTransform;  // xy = origin, zw = (cos, sin)
layout(location = 2) in vec4 aShape;      // halfBase, halfTop, height, wallThickness
layout(location = 3) in vec4 aExtra;      // surfaceY (local), kind, squash, waist

uniform vec2 uViewOrigin;
uniform vec2 uViewSize;
uniform float uPass;   // 0 = behind the liquid, 1 = in front of it

out vec2 vLocal;
out vec4 vShape;
out vec4 vExtra;

void main() {
  float halfMax = max(aShape.x, aShape.y) + aShape.w;
  float squash = aExtra.z;
  // Room for the rim ellipse above, and for the contact shadow below.
  float top = aShape.z + halfMax * squash + aShape.w * 2.0;
  float bottom = -(aShape.w * 2.0 + halfMax * (uPass < 0.5 ? squash * 2.4 : squash));

  vec2 local = vec2(
    aCorner.x * halfMax * 1.35,
    mix(bottom, top, aCorner.y * 0.5 + 0.5)
  );
  vLocal = local;
  vShape = aShape;
  vExtra = aExtra;

  vec2 rotated = vec2(
    local.x * aTransform.z - local.y * aTransform.w,
    local.x * aTransform.w + local.y * aTransform.z
  );
  vec2 world = aTransform.xy + rotated;
  vec2 ndc = (world - uViewOrigin) / uViewSize * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

export const GLASS_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
in vec4 vShape;
in vec4 vExtra;

layout(location = 0) out vec4 oColour;

uniform sampler2D uBackground;
uniform vec2 uViewOrigin;
uniform vec2 uViewSize;
uniform vec4 uTransform;
uniform vec2 uLightDir;
uniform vec3 uLightColour;
uniform float uPixelWorld;
uniform float uPass;
uniform vec3 uGlassTint;

/** Screen UV of a point given in glass-local space. */
vec2 localToUv(vec2 local) {
  vec2 rotated = vec2(
    local.x * uTransform.z - local.y * uTransform.w,
    local.x * uTransform.w + local.y * uTransform.z
  );
  return (uTransform.xy + rotated - uViewOrigin) / uViewSize;
}

void main() {
  float height = vShape.z;
  float wall = vShape.w;
  float squash = vExtra.z;
  float waist = vExtra.w;

  float y = vLocal.y;
  float x = vLocal.x;

  // Radius of the cavity at this height, including any pinched waist.
  float t = clamp(y / max(height, 1e-5), 0.0, 1.0);
  float inner = mix(vShape.x, vShape.y, t);
  if (waist > 0.0) {
    // Narrow the middle smoothly; the pinch is centred at half height.
    inner *= mix(1.0, waist, sin(t * 3.14159265) * 0.85);
  }
  float outer = inner + wall;

  float ax = abs(x);
  float aa = max(uPixelWorld * 1.1, 1e-5);

  // ------------------------------------------------------------ contact shadow
  // Drawn with the back pass so the glass sits on the table rather than
  // floating above the painting.
  bool standsOnTable = vExtra.y < 0.5;
  if (uPass < 0.5 && y < 0.0 && standsOnTable) {
    float shadowSpan = outer * 1.25;
    float sy = -y / max(outer * squash * 2.2, 1e-5);
    float sx = x / max(shadowSpan, 1e-5);
    float d = length(vec2(sx, sy));
    float shade = (1.0 - smoothstep(0.25, 1.0, d)) * 0.5;
    // A bright caustic just under the glass, where light focuses through it.
    float caustic = (1.0 - smoothstep(0.0, 0.55, d)) * 0.16;
    if (shade <= 0.002 && caustic <= 0.002) discard;
    vec2 uv = localToUv(vLocal);
    vec3 behind = texture(uBackground, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
    vec3 colour = behind * (1.0 - shade) + uLightColour * caustic;
    oColour = vec4(colour, clamp(shade + caustic, 0.0, 1.0));
    return;
  }

  if (y < -aa || y > height + outer * squash + aa) discard;
  if (!standsOnTable && y < 0.0) discard;
  if (ax > outer + aa) discard;

  float u = clamp(x / max(outer, 1e-5), -1.0, 1.0);
  // Depth of the cylinder at this horizontal offset: the 3D cue.
  float bulge = sqrt(max(1.0 - u * u, 0.0));

  // ---------------------------------------------------- glass path length
  // How much glass the view ray passes through. Short in the middle, long at
  // the edges; this one quantity drives tint, refraction and opacity.
  float dOuter = sqrt(max(outer * outer - x * x, 0.0));
  float dInner = ax < inner ? sqrt(max(inner * inner - x * x, 0.0)) : 0.0;
  float path = 2.0 * (dOuter - dInner);

  // The base is a solid slab of glass, so it is much thicker than the walls.
  float baseTop = wall * 1.7;
  bool inBase = y < baseTop;
  if (inBase) path += (baseTop - y) * 1.6 + wall;

  // The rim: an elliptical annulus at the top. The single strongest signal that
  // this is a cylinder and not a flat cut-out.
  float rimSemi = outer * squash;
  float ry = (y - height) / max(rimSemi, 1e-5);
  float rimDist = length(vec2(u, ry));
  float rimBand = (1.0 - smoothstep(0.86, 1.02, rimDist)) *
                  smoothstep(inner / outer - 0.12, inner / outer + 0.02, rimDist);
  // The far side of the rim is seen through the glass, so it is dimmer than the
  // near side. Getting this asymmetry right is most of what sells the ellipse.
  float farRim = smoothstep(0.0, 0.5, ry);
  rimBand *= mix(1.0, 0.45, farRim);
  float aboveRim = smoothstep(0.0, 0.4, ry);
  if (y > height && rimDist > 1.0 + aa) discard;

  // The inside of the base, seen as an ellipse through the front of the glass.
  float baseSemi = inner * squash;
  float by = (y - wall * 1.7) / max(baseSemi, 1e-5);
  float baseRing = 0.0;
  if (ax < inner) {
    float bd = length(vec2(x / max(inner, 1e-5), by));
    baseRing = (1.0 - smoothstep(0.72, 1.04, bd)) * (1.0 - smoothstep(0.0, 0.8, abs(by)));
  }

  // The liquid surface inside the glass, as an ellipse rather than a flat line.
  float surfaceY = vExtra.x;
  float sy = (y - surfaceY) / max(inner * squash, 1e-5);
  float surfaceRing = 0.0;
  if (surfaceY > 0.0 && ax < inner) {
    float sd = length(vec2(x / max(inner, 1e-5), sy));
    surfaceRing = (1.0 - smoothstep(0.7, 1.02, sd)) * (1.0 - smoothstep(0.0, 0.55, abs(sy)));
  }

  // ------------------------------------------------------------------ shading
  vec3 normal = normalize(vec3(u * 1.15, ry * 0.25, max(bulge, 0.12)));
  vec2 uv = localToUv(vLocal);

  // Refraction scales with the glass actually crossed, so edges bend hard and
  // the middle stays honest.
  float bend = clamp(path * 0.55, 0.0, 0.05);
  vec2 refracted = uv + normal.xy * bend;
  vec3 behind = texture(uBackground, clamp(refracted, vec2(0.001), vec2(0.999))).rgb;

  // Beer-Lambert through the glass: thick edges go green and dark, exactly as
  // real glass does.
  vec3 absorb = exp(-(1.0 - uGlassTint) * path * 26.0);
  vec3 colour = behind * absorb;

  // A dim reflection of what is above, sampled by mirroring upward.
  vec3 reflected = texture(uBackground, clamp(vec2(uv.x, uv.y + 0.16), vec2(0.001), vec2(0.999))).rgb;
  float fresnel = pow(1.0 - clamp(normal.z, 0.0, 1.0), 2.4);
  colour = mix(colour, reflected, fresnel * 0.34);

  vec3 light = normalize(vec3(uLightDir, 0.62));
  vec3 halfway = normalize(light + vec3(0.0, 0.0, 1.0));
  float specular = pow(max(dot(normal, halfway), 0.0), 46.0);

  // The two highlights every glass photograph has: a hard narrow one on the lit
  // side, and a soft wide one wrapping the far side.
  float keyStreak = exp(-pow((u + 0.55) / 0.1, 2.0)) * smoothstep(0.0, 0.25, t) * (1.0 - aboveRim);
  float fillStreak = exp(-pow((u - 0.72) / 0.2, 2.0)) * 0.42 * (1.0 - aboveRim);

  colour += uLightColour * (specular * 0.5 + keyStreak * 0.42 + fillStreak * 0.18);
  colour += uLightColour * fresnel * 0.18;
  // A highlight, not a neon ring: the rim is polished glass catching the light.
  colour += uLightColour * rimBand * 0.34;
  colour += uLightColour * surfaceRing * 0.3;
  colour += uLightColour * baseRing * 0.12;
  // The walls seen edge-on: more glass in the way, so greener and darker. This
  // is what separates a glass from a plastic tub.
  float wallDepth = smoothstep(inner / outer - 0.02, 1.0, ax / outer);
  colour *= mix(1.0, 0.74, wallDepth);
  colour = mix(colour, colour * uGlassTint, wallDepth * 0.55);

  // ---------------------------------------------------------------- coverage
  // Clear glass transmits almost everything, so opacity is not proportional to
  // thickness in any simple way: what you actually *see* of a glass is its
  // edges, its rim, its base and the highlights on it. Everything else is the
  // scene behind, slightly bent and slightly tinted.
  float edge = smoothstep(inner / outer - 0.03, 1.0, ax / outer);
  float body = clamp(path * 3.2, 0.0, 0.5);
  float alpha = clamp(
    body * 0.4 + edge * 0.86 + rimBand * 0.8 + fresnel * 0.3 + specular * 0.7 + baseRing * 0.4,
    0.0,
    1.0
  );
  if (inBase) alpha = max(alpha, 0.7);
  alpha *= 1.0 - smoothstep(outer - aa, outer + aa, ax);

  if (uPass < 0.5) {
    // Behind the liquid: only the far wall's edges and the base. The middle is
    // left clear, because the liquid is about to be drawn over it.
    alpha *= 0.5;
    alpha = max(alpha, inBase ? 0.68 : baseRing * 0.5);
    colour *= 0.9;
  } else {
    // In front of the liquid: the near wall, the rim, the highlights and the
    // meniscus. The middle must stay clear or it fogs the liquid behind it.
    alpha *= max(
      edge * 0.9,
      rimBand * 0.8 + specular * 0.55 + surfaceRing * 0.5 + keyStreak * 0.5
    );
  }

  if (alpha <= 0.004) discard;
  oColour = vec4(colour, alpha);
}
`;
