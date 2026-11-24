export const MASCOT_VERT_SRC = /* glsl */ `#version 300 es
precision highp float;

void main() {
  vec2 pos[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2(3.0, -1.0),
    vec2(-1.0, 3.0)
  );
  gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);
}
`;

export const MASCOT_FRAG_SRC = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uPixelSize;
uniform int uShape;
uniform vec3 uBaseColor;
uniform vec3 uDeepColor;
uniform vec3 uRimColor;
uniform vec2 uEyeLayout;
uniform vec2 uLook;
uniform float uBlink;
uniform float uBreath;
uniform float uHover;
uniform float uWorking;
uniform float uError;
// Step counts of the three raymarch loops (eyes, fur shell, fur strands). Uniform on purpose: see above.
uniform ivec3 uSteps;

out vec4 fragColor;

vec2 rot(vec2 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// 3D value noise for continuous volumetric fur strands
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);

  return mix(
    mix(
      mix(hash31(i + vec3(0.0, 0.0, 0.0)), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a;
  vec3 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float sdRoundedCylinder(vec3 p, float ra, float rb, float h) {
  vec2 d = vec2(length(p.xz) - 2.0 * ra + rb, abs(p.y) - h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - rb;
}

float sdEquilateralTriangle2D(vec2 p, float r) {
  const float k = sqrt(3.0);
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) {
    p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  }
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

float sdHexagon2D(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

float sdPentagon2D(vec2 p, float r) {
  const vec3 k = vec3(0.809016994, 0.587785252, 0.726542528);
  // Flip Y so the peak points upward (+Y)
  p.y = -p.y;
  p.x = abs(p.x);
  p -= 2.0 * min(dot(vec2(-k.x, k.y), p), 0.0) * vec2(-k.x, k.y);
  p -= 2.0 * min(dot(vec2(k.x, k.y), p), 0.0) * vec2(k.x, k.y);
  p -= vec2(clamp(p.x, -r * k.z, r * k.z), r);
  return length(p) * sign(p.y);
}

// Extrude a 2D shape into a plump, domed 3D plush pillow
float sdPlushExtrude(float d2, float z, float halfDepth, float roundR) {
  float bulge = clamp(-d2, 0.0, 0.55) * 0.34;
  vec2 w = vec2(d2, abs(z) - (halfDepth + bulge));
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - roundR;
}

float sdBody(vec3 p, int shape) {
  // 0: orb (chubby plush sphere)
  if (shape == 0) {
    return length(p) - 0.62;
  }
  // 1: squircle (rounded boxy pillow)
  if (shape == 1) {
    return sdRoundBox(p, vec3(0.40, 0.38, 0.32), 0.22);
  }
  // 2: triangle (iconic fuzzy blue triangle creature)
  if (shape == 2) {
    float d2 = sdEquilateralTriangle2D(p.xy + vec2(0.0, 0.14), 0.44) - 0.12;
    return sdPlushExtrude(d2, p.z, 0.23, 0.11);
  }
  // 3: hex (rounded hexagon)
  if (shape == 3) {
    vec2 q = vec2(p.y, p.x); // rotate 90deg for flat-top/side hex poise matching ref #4
    float d2 = sdHexagon2D(q, 0.48) - 0.08;
    return sdPlushExtrude(d2, p.z, 0.24, 0.10);
  }
  // 4: cube (chunky rounded cube)
  if (shape == 4) {
    return sdRoundBox(p, vec3(0.39, 0.39, 0.37), 0.18);
  }
  // 5: pebble (slightly tilted organic boulder)
  if (shape == 5) {
    vec3 q = p;
    q.xy = rot(q.xy, 0.18);
    q /= vec3(0.64, 0.56, 0.54);
    float d = (length(q) - 1.0) * 0.54;
    return d + 0.015 * sin(q.x * 2.4) * cos(q.y * 2.1);
  }
  // 6: pentagon (apex up)
  if (shape == 6) {
    float d2 = sdPentagon2D(p.xy + vec2(0.0, 0.02), 0.46) - 0.09;
    return sdPlushExtrude(d2, p.z, 0.24, 0.10);
  }
  // 7: pill / loaf (wide horizontal bean)
  if (shape == 7) {
    return sdCapsule(p, vec3(-0.22, 0.0, 0.0), vec3(0.22, 0.0, 0.0), 0.43);
  }
  // 8: diamond (rotated plush square)
  if (shape == 8) {
    vec3 q = p;
    q.xy = rot(q.xy, 0.78539816);
    return sdRoundBox(q, vec3(0.34, 0.34, 0.25), 0.15);
  }
  // 9: cloud (fluffy 4-lobe cluster)
  if (shape == 9) {
    float d = length(p - vec3(0.0, 0.16, 0.0)) - 0.34;
    d = smin(d, length(p - vec3(-0.29, -0.02, 0.0)) - 0.30, 0.16);
    d = smin(d, length(p - vec3(0.29, -0.02, 0.0)) - 0.30, 0.16);
    d = smin(d, length(p - vec3(0.0, -0.18, 0.02)) - 0.32, 0.16);
    return d;
  }
  // 10: barrel (tall rounded cylinder)
  if (shape == 10) {
    return sdRoundedCylinder(p, 0.27, 0.19, 0.38);
  }
  // 11: blob (organic pear drop)
  float bot = length(p - vec3(0.0, -0.12, 0.0)) - 0.50;
  float top = length(p - vec3(-0.04, 0.22, 0.0)) - 0.36;
  return smin(bot, top, 0.22);
}

vec3 calcBodyNormal(vec3 p, int shape) {
  const float e = 0.004;
  return normalize(vec3(
    sdBody(p + vec3(e, 0.0, 0.0), shape) - sdBody(p - vec3(e, 0.0, 0.0), shape),
    sdBody(p + vec3(0.0, e, 0.0), shape) - sdBody(p - vec3(0.0, e, 0.0), shape),
    sdBody(p + vec3(0.0, 0.0, e), shape) - sdBody(p - vec3(0.0, 0.0, e), shape)
  ));
}

float findFrontZ(vec2 xy, int shape) {
  float z = 0.85;
  for (int i = 0; i < 6; i++) {
    z -= sdBody(vec3(xy, z), shape);
  }
  return z;
}

float sdOneEye(vec3 p, vec2 centerXY, float zFront, float halfH) {
  vec3 q = p - vec3(centerXY, zFront + 0.042);
  q.z *= 1.35;
  return sdCapsule(q, vec3(0.0, -halfH, 0.0), vec3(0.0, halfH, 0.0), 0.048);
}

float sdEyes(vec3 p, vec2 leftXY, vec2 rightXY, vec2 eyeZ, float halfH) {
  return min(sdOneEye(p, leftXY, eyeZ.x, halfH), sdOneEye(p, rightXY, eyeZ.y, halfH));
}

vec3 calcEyeNormal(vec3 p, vec2 leftXY, vec2 rightXY, vec2 eyeZ, float halfH) {
  const float e = 0.002;
  return normalize(vec3(
    sdEyes(p + vec3(e, 0.0, 0.0), leftXY, rightXY, eyeZ, halfH) - sdEyes(p - vec3(e, 0.0, 0.0), leftXY, rightXY, eyeZ, halfH),
    sdEyes(p + vec3(0.0, e, 0.0), leftXY, rightXY, eyeZ, halfH) - sdEyes(p - vec3(0.0, e, 0.0), leftXY, rightXY, eyeZ, halfH),
    sdEyes(p + vec3(0.0, 0.0, e), leftXY, rightXY, eyeZ, halfH) - sdEyes(p - vec3(0.0, 0.0, e), leftXY, rightXY, eyeZ, halfH)
  ));
}

void main() {
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;

  // Ray setup
  vec3 ro = vec3(0.0, 0.0, 2.75);
  vec3 rd = normalize(vec3(uv, -2.1));

  // Squash-and-stretch breathing + working bounce
  float sy = 1.0 + uBreath * 0.032 + uHover * 0.028;
  float sxz = 1.0 / sqrt(sy);
  vec3 bounce = vec3(0.0, uWorking * 0.045 * abs(uBreath) + uHover * 0.025, 0.0);

  // Rotate camera and lights into object space so head turns toward cursor
  float yaw = uLook.x * 0.44;
  float pitch = uLook.y * 0.30;

  ro -= bounce;
  ro.xz = rot(ro.xz, yaw);
  ro.yz = rot(ro.yz, pitch);
  rd.xz = rot(rd.xz, yaw);
  rd.yz = rot(rd.yz, pitch);

  ro /= vec3(sxz, sy, sxz);
  rd = normalize(rd / vec3(sxz, sy, sxz));

  vec3 keyLight = normalize(vec3(-0.45, 0.72, 0.75));
  keyLight.xz = rot(keyLight.xz, yaw);
  keyLight.yz = rot(keyLight.yz, pitch);

  vec3 fillLight = normalize(vec3(0.75, -0.35, 0.45));
  fillLight.xz = rot(fillLight.xz, yaw);
  fillLight.yz = rot(fillLight.yz, pitch);

  // Eye coordinates glide gently over the front face
  vec2 gaze = vec2(uLook.x * 0.082, uLook.y * 0.062);
  vec2 leftXY = vec2(-uEyeLayout.x, uEyeLayout.y) + gaze;
  vec2 rightXY = vec2(uEyeLayout.x, uEyeLayout.y) + gaze;
  float halfH = 0.068 * (1.0 - 0.88 * uBlink) * (1.0 - 0.28 * uError);
  // Where the eyes sit on the front of the body: the same for every step of the trace.
  vec2 eyeZ = vec2(findFrontZ(leftXY, uShape), findFrontZ(rightXY, uShape));

  // 1) Quick trace for 3D capsule eyes
  float tEye = -1.0;
  float te = 1.25;
  for (int i = 0; i < uSteps.x; i++) {
    float de = sdEyes(ro + rd * te, leftXY, rightXY, eyeZ, halfH);
    if (de < 0.0015) {
      tEye = te;
      break;
    }
    te += de;
    if (te > 3.6) break;
  }

  // 2) Raymarch to outer fuzzy fur shell
  const float furLen = 0.115;
  float furFreq = mix(11.0, 23.5, clamp((uPixelSize - 24.0) / 84.0, 0.0, 1.0));

  float t = 1.15;
  bool enteredShell = false;
  for (int i = 0; i < uSteps.y; i++) {
    float dOuter = sdBody(ro + rd * t, uShape) - furLen;
    if (dOuter < 0.002) {
      enteredShell = true;
      break;
    }
    t += max(dOuter, 0.015);
    if (t > 3.8) break;
  }

  vec3 accumRgb = vec3(0.0);
  float accumAlpha = 0.0;
  bool hitEyeFront = false;

  if (enteredShell) {
    for (int stepIdx = 0; stepIdx < uSteps.z; stepIdx++) {
      if (tEye > 0.0 && t >= tEye) {
        hitEyeFront = true;
        break;
      }

      vec3 p = ro + rd * t;
      float dBody = sdBody(p, uShape);

      if (dBody > furLen + 0.025) {
        break;
      }

      vec3 N = calcBodyNormal(p, uShape);
      vec3 V = -rd;
      float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.25);

      float wrapDiff = clamp((dot(N, keyLight) + 0.52) / 1.52, 0.0, 1.0);
      float fillDiff = clamp(dot(N, fillLight) * 0.5 + 0.5, 0.0, 1.0);

      // Soft cast AO directly around the eyes so they nestle naturally in fur
      float dE = sdEyes(p, leftXY, rightXY, eyeZ, halfH);
      float eyeAo = mix(0.42, 1.0, smoothstep(0.0, 0.095, dE));

      if (dBody <= 0.002) {
        // Solid plush core beneath fur roots
        vec3 coreCol = mix(uDeepColor, uBaseColor, 0.25 + 0.58 * wrapDiff);
        coreCol += uRimColor * fresnel * 0.22;
        coreCol += uBaseColor * fillDiff * 0.14;
        coreCol *= eyeAo;

        float rem = 1.0 - accumAlpha;
        accumRgb += coreCol * rem;
        accumAlpha = 1.0;
        break;
      }

      float h = clamp(dBody / furLen, 0.0, 1.0);
      // Project back to body surface + subtle gravity droop to form continuous fuzzy strands
      vec3 pRoot = p - N * dBody + vec3(0.0, 0.052 * h * h, 0.0);
      float n1 = noise3(pRoot * furFreq);
      float n2 = noise3(pRoot * (furFreq * 2.15) + 7.31);
      float hairTip = 0.26 + 0.54 * n1 + 0.28 * n2;
      float density = smoothstep(hairTip, hairTip - 0.32, h);

      if (density > 0.01) {
        vec3 strandTint = mix(uDeepColor, uBaseColor, 0.34 + 0.66 * h);
        float fiberSheen = 0.86 + 0.24 * n2;
        vec3 furCol = strandTint * (0.48 + 0.68 * wrapDiff) * fiberSheen;
        furCol += uBaseColor * fillDiff * 0.14;
        // Backlit fluffy rim halo
        furCol += uRimColor * fresnel * (0.42 + 0.65 * h);
        furCol *= eyeAo;

        float stepAlpha = clamp(density * (0.44 + 0.28 * (1.0 - h)), 0.0, 0.92);
        float contrib = stepAlpha * (1.0 - accumAlpha);
        accumRgb += furCol * contrib;
        accumAlpha += contrib;
        if (accumAlpha > 0.985) {
          accumAlpha = 1.0;
          break;
        }
      }

      t += 0.019;
    }
  } else if (tEye > 0.0) {
    hitEyeFront = true;
  }

  // 3) Composite glossy 3D cream capsule eyes in front of fur/core
  if (tEye > 0.0 && (hitEyeFront || !enteredShell)) {
    vec3 pe = ro + rd * tEye;
    vec3 Ne = calcEyeNormal(pe, leftXY, rightXY, eyeZ, halfH);
    vec3 Ve = -rd;
    vec3 He = normalize(keyLight + Ve);

    float diffE = clamp((dot(Ne, keyLight) + 0.55) / 1.55, 0.0, 1.0);
    float specE = pow(max(dot(Ne, He), 0.0), 36.0) * 0.42;
    float edgeShade = pow(1.0 - max(dot(Ne, Ve), 0.0), 2.0) * 0.22;

    vec3 eyeCream = vec3(0.985, 0.96, 0.915);
    vec3 eyeShadow = vec3(0.70, 0.65, 0.61);
    vec3 eyeCol = mix(eyeShadow, eyeCream, 0.32 + 0.68 * diffE) + vec3(specE) - vec3(edgeShade);
    eyeCol = clamp(eyeCol, 0.0, 1.0);

    // Blend smoothly with front fur tips slightly overlapping the eye base
    float frontFurBlend = clamp(accumAlpha * 0.22, 0.0, 0.22);
    accumRgb = mix(eyeCol, accumRgb, frontFurBlend);
    accumAlpha = max(accumAlpha, 0.99);
  }

  // Subtle ambient error tint when agent is in error state
  if (uError > 0.01 && accumAlpha > 0.0) {
    accumRgb = mix(accumRgb, vec3(0.96, 0.34, 0.32), uError * 0.14 * accumAlpha);
  }

  accumAlpha = smoothstep(0.03, 0.96, accumAlpha);
  fragColor = vec4(accumRgb * accumAlpha, accumAlpha);
}
`;
