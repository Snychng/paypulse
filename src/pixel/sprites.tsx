/* ============================================================
   PayPulse — pixel sprites + icon set (React 19 port)
   从 design/sprites.js 的 pixmap() / SPRITE / ICONS 忠实移植。

   - <Sprite> : 位图精灵（coin / bill / buddy / buddyBlink / stack）
   - <Icon>   : 像素图标集（继承 currentColor）
   位图数据与配色数组与 sprites.js 原样一致；通过构造 SVG <rect> 像素块渲染，
   配合 shape-rendering="crispEdges" + image-rendering: pixelated 复刻硬边观感。
   ============================================================ */
import type { CSSProperties, JSX } from "react";

/* ---------- 配色板（与 sprites.js 原样一致） ---------- */
type Palette = Readonly<Record<string, string | null>>;

const PAL_COIN: Palette = { ".": null, o: "#c75e3a", g: "#ffcd75", d: "#e0a52a", G: "#fff6d0", e: "#1a1c2c", m: "#c75e3a" };
const PAL_BILL: Palette = { ".": null, o: "#1c6b3a", g: "#38b764", l: "#a7f070", w: "#e8ffe9", s: "#16633a" };
const PAL_STACK: Palette = { ".": null, o: "#0e3320", g: "#2fae5a", d: "#1c6b3a", l: "#86e69b", b: "#f0e6c0" };

/* ---------- 位图（rows）数据 ---------- */
/* shiny coin (flying) 8x8 */
const COIN8: readonly string[] = [
  "..oooo..",
  ".oGggdo.",
  "oGgggddo",
  "ogggdddo",
  "ogggdddo",
  "oggddddo",
  ".oddddo.",
  "..oooo..",
];
/* banknote 12x8 */
const BILL: readonly string[] = [
  "oooooooooooo",
  "olgggggggglo",
  "ogwsllllswgo",
  "oglw.ww.wlgo",
  "oglw.ww.wlgo",
  "ogwsllllswgo",
  "olgggggggglo",
  "oooooooooooo",
];
/* coin-buddy mascot 11x11 (eyes + smile) */
const BUDDY: readonly string[] = [
  "...ooooo...",
  ".ooGgggGoo.",
  "oGgggggggdo",
  "oGgggggggdo",
  "oggegggeggo",
  "oggggggggdo",
  "oggggggggdo",
  "oggmmmmmgdo",
  "oggggggggdo",
  ".oodddddoo.",
  "...ooooo...",
];
/* blinking buddy (eyes closed) */
const BUDDY_BLINK: readonly string[] = [
  "...ooooo...",
  ".ooGgggGoo.",
  "oGgggggggdo",
  "oGgggggggdo",
  "oggmgggmggo",
  "oggggggggdo",
  "oggggggggdo",
  "oggmmmmmgdo",
  "oggggggggdo",
  ".oodddddoo.",
  "...ooooo...",
];
/* a banded stack/wad of US dollar bills (greenback) 14x12 */
const STACK: readonly string[] = [
  ".oooooooooooo.",
  ".ogggggggggdo.",
  ".ollllllllldo.",
  ".obbbbbbbbbbo.",
  ".obbbbbbbbbbo.",
  ".oggggggggddo.",
  ".ollllllllldo.",
  ".oooooooooooo.",
  ".oddddddddddo.",
  ".ogggggggggdo.",
  ".oddddddddddo.",
  ".oooooooooooo.",
];

/* ---------- 精灵注册表 ---------- */
export type SpriteName = "coin" | "bill" | "buddy" | "buddyBlink" | "stack";

interface SpriteDef {
  rows: readonly string[];
  pal: Palette;
  /** 与 SPRITE 表中各项默认 scale 对齐 */
  defaultScale: number;
}

const SPRITES: Readonly<Record<SpriteName, SpriteDef>> = {
  coin: { rows: COIN8, pal: PAL_COIN, defaultScale: 3 },
  bill: { rows: BILL, pal: PAL_BILL, defaultScale: 3 },
  buddy: { rows: BUDDY, pal: PAL_COIN, defaultScale: 4 },
  buddyBlink: { rows: BUDDY_BLINK, pal: PAL_COIN, defaultScale: 4 },
  stack: { rows: STACK, pal: PAL_STACK, defaultScale: 2 },
};

/* ---------- 像素方块构造（替代 pixmap() 的字符串拼接） ---------- */
/** 把位图行解析为一组 <rect>，每个亮像素为 1×1 方块（viewBox 单位）。 */
function pixelRects(rows: readonly string[], pal: Palette): JSX.Element[] {
  const rects: JSX.Element[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const fill = pal[ch];
      if (fill) {
        rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />);
      }
    });
  });
  return rects;
}

export interface SpriteProps {
  /** 精灵名：coin / bill / buddy / buddyBlink / stack */
  name: SpriteName;
  /** 像素放大倍数；省略时使用该精灵在原型中的默认倍数 */
  scale?: number;
  /** 透传到外层 <svg> 的额外 class（如动画 helper：spin / bob / wig） */
  className?: string;
  style?: CSSProperties;
}

/**
 * 像素精灵组件 — 对应 sprites.js 的 `SPRITE.coin/bill/buddy/...`。
 * 渲染为按 scale 放大的 SVG 位图，硬边、像素化。
 */
export function Sprite({ name, scale, className = "", style }: SpriteProps): JSX.Element {
  const def = SPRITES[name];
  const w = def.rows[0]?.length ?? 0;
  const h = def.rows.length;
  const s = scale ?? def.defaultScale;
  return (
    <svg
      className={`sprite ${className}`.trim()}
      width={w * s}
      height={h * s}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
      style={style}
    >
      {pixelRects(def.rows, def.pal)}
    </svg>
  );
}

/* ---------- 像素图标集（继承 currentColor） ---------- */
export type IconName =
  | "play"
  | "pause"
  | "stop"
  | "settings"
  | "chart"
  | "bell"
  | "power"
  | "moon"
  | "sun"
  | "globe"
  | "plus"
  | "minus"
  | "pin"
  | "minimize"
  | "close"
  | "fire";

/* 图标内部由若干像素 <rect>/<polygon> 组成；字符串与 sprites.js ICONS 原样一致，
   作为受信任的常量 SVG 片段，用 dangerouslySetInnerHTML 注入 <svg> 内部。 */
const ICONS: Readonly<Record<IconName, string>> = {
  play: '<polygon points="4,3 4,13 13,8" fill="currentColor"/>',
  pause: '<rect x="4" y="3" width="3" height="10" fill="currentColor"/><rect x="9" y="3" width="3" height="10" fill="currentColor"/>',
  stop: '<rect x="4" y="4" width="8" height="8" fill="currentColor"/>',
  settings:
    '<rect x="2" y="4" width="12" height="2" fill="currentColor"/><rect x="9" y="2" width="3" height="6" fill="currentColor"/><rect x="2" y="10" width="12" height="2" fill="currentColor"/><rect x="4" y="8" width="3" height="6" fill="currentColor"/>',
  chart:
    '<rect x="2" y="9" width="3" height="4" fill="currentColor"/><rect x="6" y="5" width="3" height="8" fill="currentColor"/><rect x="10" y="7" width="3" height="6" fill="currentColor"/><rect x="2" y="13" width="12" height="1" fill="currentColor"/>',
  bell: '<rect x="6" y="2" width="4" height="2" fill="currentColor"/><rect x="4" y="4" width="8" height="6" fill="currentColor"/><rect x="3" y="10" width="10" height="2" fill="currentColor"/><rect x="7" y="13" width="2" height="2" fill="currentColor"/>',
  power:
    '<rect x="7" y="2" width="2" height="6" fill="currentColor"/><rect x="4" y="5" width="2" height="2" fill="currentColor"/><rect x="10" y="5" width="2" height="2" fill="currentColor"/><rect x="3" y="7" width="2" height="4" fill="currentColor"/><rect x="11" y="7" width="2" height="4" fill="currentColor"/><rect x="5" y="11" width="6" height="2" fill="currentColor"/>',
  moon: '<rect x="5" y="2" width="6" height="2" fill="currentColor"/><rect x="4" y="4" width="3" height="8" fill="currentColor"/><rect x="4" y="12" width="6" height="2" fill="currentColor"/><rect x="7" y="4" width="2" height="2" fill="currentColor"/>',
  sun: '<rect x="6" y="6" width="4" height="4" fill="currentColor"/><rect x="7" y="2" width="2" height="2" fill="currentColor"/><rect x="7" y="12" width="2" height="2" fill="currentColor"/><rect x="2" y="7" width="2" height="2" fill="currentColor"/><rect x="12" y="7" width="2" height="2" fill="currentColor"/><rect x="3" y="3" width="2" height="2" fill="currentColor"/><rect x="11" y="3" width="2" height="2" fill="currentColor"/><rect x="3" y="11" width="2" height="2" fill="currentColor"/><rect x="11" y="11" width="2" height="2" fill="currentColor"/>',
  globe:
    '<rect x="5" y="2" width="6" height="2" fill="currentColor"/><rect x="3" y="4" width="10" height="2" fill="currentColor"/><rect x="2" y="6" width="12" height="4" fill="currentColor"/><rect x="3" y="10" width="10" height="2" fill="currentColor"/><rect x="5" y="12" width="6" height="2" fill="currentColor"/><rect x="7" y="2" width="2" height="12" fill="#1a1c2c"/><rect x="2" y="7" width="12" height="2" fill="#1a1c2c"/>',
  plus: '<rect x="6" y="2" width="4" height="12" fill="currentColor"/><rect x="2" y="6" width="12" height="4" fill="currentColor"/>',
  minus: '<rect x="2" y="6" width="12" height="4" fill="currentColor"/>',
  pin: '<rect x="6" y="2" width="4" height="7" fill="currentColor"/><rect x="3" y="8" width="10" height="2" fill="currentColor"/><rect x="7" y="10" width="2" height="4" fill="currentColor"/>',
  minimize: '<rect x="3" y="11" width="10" height="2" fill="currentColor"/>',
  close:
    '<rect x="3" y="3" width="2" height="2" fill="currentColor"/><rect x="5" y="5" width="2" height="2" fill="currentColor"/><rect x="7" y="7" width="2" height="2" fill="currentColor"/><rect x="9" y="5" width="2" height="2" fill="currentColor"/><rect x="11" y="3" width="2" height="2" fill="currentColor"/><rect x="9" y="9" width="2" height="2" fill="currentColor"/><rect x="11" y="11" width="2" height="2" fill="currentColor"/><rect x="5" y="9" width="2" height="2" fill="currentColor"/><rect x="3" y="11" width="2" height="2" fill="currentColor"/>',
  fire: '<rect x="7" y="2" width="2" height="3" fill="currentColor"/><rect x="6" y="4" width="4" height="2" fill="currentColor"/><rect x="5" y="6" width="6" height="5" fill="currentColor"/><rect x="4" y="8" width="8" height="4" fill="currentColor"/><rect x="6" y="11" width="4" height="2" fill="#ffcd75"/>',
};

/** 所有可用图标名（便于上层做穷举/类型守卫） */
export const ICON_NAMES = Object.keys(ICONS) as readonly IconName[];

/* ---------- 命令式 SVG 字符串构造（供 CoinFlow 等 WAAPI 引擎注入 DOM 用） ---------- */
/**
 * 返回某精灵的 SVG 字符串 —— 等价于 sprites.js 里的 `SPRITE.coin(scale)`。
 * 与 <Sprite> 渲染同源（同一份位图 + 配色），仅输出形态不同（string vs JSX）。
 * 命令式动画（CoinFlow）需要插入 innerHTML，故保留字符串形态。
 */
export function spriteSVG(name: SpriteName, scale?: number, cls = ""): string {
  const def = SPRITES[name];
  const w = def.rows[0]?.length ?? 0;
  const h = def.rows.length;
  const s = scale ?? def.defaultScale;
  let rects = "";
  def.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const fill = def.pal[ch];
      if (fill) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`;
    });
  });
  const klass = `sprite ${cls}`.trim();
  return `<svg class="${klass}" width="${w * s}" height="${h * s}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}

export interface IconProps {
  /** 图标名 */
  name: IconName;
  /** 边长（px），默认 16 */
  size?: number;
  /** 显式颜色；省略则继承 currentColor */
  color?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * 像素图标组件 — 对应 sprites.js 的 `icon(name, size, cls)`。
 * 图标几何继承 currentColor；传入 `color` 时在外层 <svg> 上设置 color 覆盖。
 */
export function Icon({ name, size = 16, color, className = "", style }: IconProps): JSX.Element {
  const svg = ICONS[name] ?? "";
  return (
    <svg
      className={`ico ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
      style={color ? { color, ...style } : style}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
