const canvasSketch = require("canvas-sketch");

const settings = {
  dimensions: [1080, 1080],
  animate: true,
  context: "2d"
};

const fontStyle = "900 180px Helvetica, sans-serif";

// slicing physics 
const wobbleAmount = 1.2;
const wobbleSegments = 24;

const driftStrength = 0.55;
const driftRandomness = 0.15;

const gravityAmount = 0.12;
const minSwipeLength = 10;

const smallFragmentThreshold = 36;
const smallFragmentFade = 1.0;

const maxFragmentCount = 1500;
const idleResetTime = 10000;

// breathing effect for the word
const breathAmplitude = 0.02;
const breathSpeed = 0.8;

// colour palette 
const paletteHex = [
  "#0097A7",
  "#FFD230",
  "#FF3E7F",
  "#FF7A30",
  "#17C79A",
  "#831D70"
];

let word = "SLICE";

// canvas area 
let mainCanvas;
let typeCanvas = document.createElement("canvas");
let typeCtx = typeCanvas.getContext("2d");

let fragments = [];
let glowLines = [];

let isMouseDown = false;
let swipeStart = null;
let swipeEnd = null;

let lastSliceTime = performance.now();
let isResetting = false;

// math helpers
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));


// full word on off screen canvas
function renderWord(w, h) {
  typeCanvas.width = w;
  typeCanvas.height = h;
  typeCtx.clearRect(0, 0, w, h);

  typeCtx.fillStyle = "white";
  typeCtx.font = fontStyle;
  typeCtx.textAlign = "center";
  typeCtx.textBaseline = "middle";
  typeCtx.fillText(word, w / 2, h / 2);
}


// FUNCTIONS FOR SLICING 

// cut the word using a polygon shape
function clippedCanvasFromPoly(src, poly) {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d");

  ctx.save();
  ctx.beginPath();
  poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(src, 0, 0);
  ctx.restore();

  return c;
}

// check whether the swipe line touches a fragment
function findIntersectionOnFragment(fragment, lineStart, lineEnd) {
  const cw = fragment.canvas.width;
  const ch = fragment.canvas.height;
  const ctx = fragment.canvas.getContext("2d");
  const im = ctx.getImageData(0, 0, cw, ch).data;

  const mapLocal = (gx, gy) => ({
    x: Math.round(gx - (fragment.x - cw / 2)),
    y: Math.round(gy - (fragment.y - ch / 2))
  });

  const steps = Math.ceil(Math.hypot(
    lineEnd.x - lineStart.x,
    lineEnd.y - lineStart.y
  ) / 2);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const gx = lineStart.x + (lineEnd.x - lineStart.x) * t;
    const gy = lineStart.y + (lineEnd.y - lineStart.y) * t;

    const { x, y } = mapLocal(gx, gy);
    if (x < 0 || y < 0 || x >= cw || y >= ch) continue;

    if (im[(y * cw + x) * 4 + 3] > 40) return true;
  }
  return false;
}

// create the two sides of the slice (left + right pieces)
function buildPolysForLocalLine(l1, l2) {
  const dx = l2.x - l1.x;
  const dy = l2.y - l1.y;
  const len = Math.hypot(dx, dy) || 1;

  const nx = -dy / len;
  const ny = dx / len;
  const ext = 4000;

  // small random shakiness on the cut
  const wobble = [];
  for (let i = 0; i <= wobbleSegments; i++) {
    const t = i / wobbleSegments;
    wobble.push({
      x: l1.x + (l2.x - l1.x) * t + (Math.random() - 0.5) * wobbleAmount,
      y: l1.y + (l2.y - l1.y) * t + (Math.random() - 0.5) * wobbleAmount
    });
  }

  return {
    leftPoly: [
      ...wobble,
      { x: l2.x + nx * ext, y: l2.y + ny * ext },
      { x: l1.x + nx * ext, y: l1.y + ny * ext }
    ],
    rightPoly: [
      ...wobble,
      { x: l2.x - nx * ext, y: l2.y - ny * ext },
      { x: l1.x - nx * ext, y: l1.y - ny * ext }
    ]
  };
}

// colour a fragment using a palette colour
function tintCanvasHex(srcCanvas, hexColor) {
  const c = document.createElement("canvas");
  c.width = srcCanvas.width;
  c.height = srcCanvas.height;
  const ctx = c.getContext("2d");

  ctx.drawImage(srcCanvas, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = hexColor;
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.globalCompositeOperation = "source-over";

  return c;
}

// turn the clipped piece into a physics fragment
function makeFragmentObject(canvas, oldX, oldY, driftX, driftY) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d");
  const im = ctx.getImageData(0, 0, w, h).data;

  let minX = w, minY = h, maxX = 0, maxY = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (im[(y * w + x) * 4 + 3] > 20) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX) return null;

  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;

  const cropped = document.createElement("canvas");
  cropped.width = cw;
  cropped.height = ch;
  cropped.getContext("2d").drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);

  const worldX = oldX + (minX + cw / 2 - w / 2);
  const worldY = oldY + (minY + ch / 2 - h / 2);

  const tinted = tintCanvasHex(cropped, paletteHex[Math.floor(Math.random() * paletteHex.length)]);

  const push = driftStrength + Math.random() * driftRandomness;

  return {
    canvas: tinted,
    w: cw, h: ch,
    x: worldX, y: worldY,
    vx: driftX * push + rand(-0.06, 0.06),
    vy: driftY * push + rand(-0.06, 0.06),
    rot: rand(-0.01, 0.01),
    vrot: rand(-0.005, 0.005),
    opacity: 1,
    life: cw * ch <= smallFragmentThreshold ? smallFragmentFade * 60 : null
  };
}


// actual slicing function 
function performSlice(line) {
  lastSliceTime = performance.now();
  isResetting = false;

  glowLines.push({ ...line, life: 35 });

  const updates = [];

  for (let i = fragments.length - 1; i >= 0; i--) {
    const f = fragments[i];
    if (!findIntersectionOnFragment(f, {x: line.x1, y: line.y1}, {x: line.x2, y: line.y2})) continue;

    const mapLocal = (gx, gy) => ({
      x: gx - (f.x - f.w / 2),
      y: gy - (f.y - f.h / 2)
    });

    const l1 = mapLocal(line.x1, line.y1);
    const l2 = mapLocal(line.x2, line.y2);

    const { leftPoly, rightPoly } = buildPolysForLocalLine(l1, l2);

    const leftCanvas = clippedCanvasFromPoly(f.canvas, leftPoly);
    const rightCanvas = clippedCanvasFromPoly(f.canvas, rightPoly);

    const length = Math.hypot(line.x2 - line.x1, line.y2 - line.y1) || 1;
    const dx = (line.x2 - line.x1) / length;
    const dy = (line.y2 - line.y1) / length;

    const newFrags = [];
    const lf = makeFragmentObject(leftCanvas, f.x, f.y, -dx, -dy);
    const rf = makeFragmentObject(rightCanvas, f.x, f.y, dx, dy);

    if (lf) newFrags.push(lf);
    if (rf) newFrags.push(rf);

    updates.push({ index: i, newFrags });
  }

  for (const u of updates) {
    fragments.splice(u.index, 1);
    fragments.push(...u.newFrags);
  }

  if (fragments.length > maxFragmentCount) {
    fragments.splice(0, fragments.length - maxFragmentCount);
  }
}


// main animation loop
const sketch = ({ context, width, height, canvas }) => {
  mainCanvas = canvas;
  renderWord(width, height);

  return ({ context, width, height, time }) => {
    const now = performance.now();

    const idle = fragments.length === 0 && !isResetting;
    const breathScale =
      idle ? 1 + Math.sin(time * breathSpeed) * breathAmplitude : 1;

    if (!isResetting && fragments.length > 0) {
      if (now - lastSliceTime >= idleResetTime) {
        isResetting = true;
        for (const f of fragments) {
          const ang = rand(0, Math.PI * 2);
          const spd = rand(1.8, 3.2);
          f.vx = Math.cos(ang) * spd;
          f.vy = Math.sin(ang) * spd;
        }
      }
    }

    // background 
    const gShift = Math.sin(time * 0.25) * 30;
    const grad = context.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, `hsl(${210 + gShift}, 30%, 6%)`);
    grad.addColorStop(1, `hsl(${260 + gShift}, 30%, 8%)`);
    context.fillStyle = grad;
    context.fillRect(0, 0, width, height);

    // drawing word/fragments 
    if (fragments.length === 0) {
      context.save();
      context.translate(width / 2, height / 2);
      context.scale(breathScale, breathScale);
      context.translate(-width / 2, -height / 2);
      context.drawImage(typeCanvas, 0, 0);
      context.restore();
    } else {
      for (let i = fragments.length - 1; i >= 0; i--) {
        const f = fragments[i];

        if (isResetting) {
          f.x += f.vx;
          f.y += f.vy;
          f.rot += f.vrot;
          f.opacity *= 0.96;

          if (
            f.opacity < 0.02 ||
            f.x < -200 || f.x > width + 200 ||
            f.y < -200 || f.y > height + 200
          ) {
            fragments.splice(i, 1);

            if (fragments.length === 0) {
              renderWord(width, height);
              isResetting = false;
            }
            continue;
          }
        } else {
          if (f.life != null && f.w * f.h <= smallFragmentThreshold) {
            f.vy += gravityAmount;
          }

          f.x += f.vx;
          f.y += f.vy;
          f.rot += f.vrot;

          // slow bouncing on edges
          if (f.x - f.w / 2 < 0) { f.x = f.w / 2; f.vx *= -0.8; }
          if (f.x + f.w / 2 > width) { f.x = width - f.w / 2; f.vx *= -0.8; }
          if (f.y - f.h / 2 < 0) { f.y = f.h / 2; f.vy *= -0.8; }
          if (f.y + f.h / 2 > height) { f.y = height - f.h / 2; f.vy *= -0.8; }

          if (f.life != null) {
            f.life--;
            f.opacity = clamp(f.life / (smallFragmentFade * 60), 0, 1);
            if (f.opacity <= 0) {
              fragments.splice(i, 1);
              continue;
            }
          }
        }

        // draw this fragment
        context.save();
        context.globalAlpha = f.opacity;
        context.translate(f.x, f.y);
        context.rotate(f.rot);
        context.shadowColor = "rgba(0,0,0,0.35)";
        context.shadowBlur = 8;
        context.drawImage(f.canvas, -f.w / 2, -f.h / 2);
        context.restore();
      }
    }

    // glow effect from slices 
    for (let i = glowLines.length - 1; i >= 0; i--) {
      const g = glowLines[i];
      g.life--;
      const alpha = clamp(g.life / 35, 0, 1);

      context.save();
      context.strokeStyle = `rgba(255,255,255,${alpha})`;
      context.lineWidth = 5;
      context.lineCap = "round";
      context.shadowBlur = 25;

      context.beginPath();
      context.moveTo(g.x1, g.y1);
      context.lineTo(g.x2, g.y2);
      context.stroke();

      context.restore();
      if (g.life <= 0) glowLines.splice(i, 1);
    }

    // light preview line while dragging 
    if (isMouseDown && swipeStart) {
      context.save();
      context.strokeStyle = "rgba(255,255,255,0.4)";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(swipeStart.x, swipeStart.y);
      context.lineTo(swipeEnd.x, swipeEnd.y);
      context.stroke();
      context.restore();
    }

    // information text at the top 
    context.fillStyle = "rgba(255,255,255,0.85)";
    context.font = "14px sans-serif";
    context.fillText(`Fragments: ${fragments.length}`, 16, 26);
    context.fillText(`Word: ${word}`, 16, 48);
  };
};


// mouse interaction 
function toCanvasPos(e) {
  const rect = mainCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (mainCanvas.width / rect.width),
    y: (e.clientY - rect.top) * (mainCanvas.height / rect.height)
  };
}

document.addEventListener("mousedown", e => {
  isMouseDown = true;
  swipeStart = toCanvasPos(e);
  swipeEnd = { ...swipeStart };
});

document.addEventListener("mousemove", e => {
  if (isMouseDown) swipeEnd = toCanvasPos(e);
});

document.addEventListener("mouseup", e => {
  if (!isMouseDown) return;
  isMouseDown = false;

  swipeEnd = toCanvasPos(e);
  const dx = swipeEnd.x - swipeStart.x;
  const dy = swipeEnd.y - swipeStart.y;

  if (Math.hypot(dx, dy) >= minSwipeLength) {
    if (fragments.length === 0) {
      const base = makeFragmentObject(
        typeCanvas,
        mainCanvas.width / 2,
        mainCanvas.height / 2,
        0, 0
      );
      if (base) fragments.push(base);
    }
    performSlice({
      x1: swipeStart.x, y1: swipeStart.y,
      x2: swipeEnd.x,   y2: swipeEnd.y
    });
  }

  swipeStart = swipeEnd = null;
});


// typing to change the word 
document.addEventListener("keydown", e => {
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    word += e.key;
    renderWord(mainCanvas.width, mainCanvas.height);
  } else if (e.key === "Backspace") {
    word = word.slice(0, -1);
    renderWord(mainCanvas.width, mainCanvas.height);
  } else if (e.key === "Enter") {
    fragments = [];
    renderWord(mainCanvas.width, mainCanvas.height);
  }
});

canvasSketch(sketch, settings);
