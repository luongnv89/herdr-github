// Turns a frame of the terminal panel into an SVG picture of it, in a window like
// docs/preview.svg's: the Dracula colors, a monospace font, and each run of text
// stretched to its cells, so the columns line up whatever font draws it.
// Pure: no files, no terminal. The width of a piece of text, in cells, comes from
// the caller (panel.js's `width`), so wide characters land where the panel put them.

// The panel's colors, as Dracula draws them.
export const THEME = {
  bg: "#282a36",
  fg: "#f8f8f2",
  colors: {
    30: "#21222c", 31: "#ff5555", 32: "#50fa7b", 33: "#f1fa8c", 34: "#bd93f9", 35: "#ff79c6", 36: "#8be9fd", 37: "#f8f8f2",
    90: "#6272a4", 91: "#ff6e6e", 92: "#69ff94", 93: "#ffffa5", 94: "#d6acff", 95: "#ff92df", 96: "#a4ffff", 97: "#ffffff",
  },
};

// The size of a cell and the window around the cells, in pixels.
export const CELL = 8.43, LINE = 20, PAD_X = 18, TOP = 40, FONT_SIZE = 14;
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// The lines of one frame as panel.js paints it: each line after its cursor move
// (ESC [ row ; 1 H) and up to the reset and erase that end it. Rows it doesn't
// paint are empty.
export function screenLines(frame, rows) {
  const lines = Array.from({ length: rows }, () => "");
  for (const m of frame.matchAll(/\x1b\[(\d+);1H([\s\S]*?)\x1b\[0m\x1b\[K/g)) {
    const row = Number(m[1]) - 1;
    if (row >= 0 && row < rows) lines[row] = m[2];
  }
  return lines;
}

const plain = () => ({ bold: false, faint: false, inverse: false, fg: null });
const hex2 = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");

// One SGR sequence's parameters applied to `style`.
function applySgr(style, params) {
  const codes = params === "" ? [0] : params.split(";").map((p) => (p === "" ? 0 : Number(p)));
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.assign(style, plain());
    else if (c === 1) style.bold = true;
    else if (c === 2) style.faint = true;
    else if (c === 22) Object.assign(style, { bold: false, faint: false });
    else if (c === 7) style.inverse = true;
    else if (c === 27) style.inverse = false;
    else if (c === 39) style.fg = null;
    else if (THEME.colors[c]) style.fg = THEME.colors[c];
    else if (c === 38 && codes[i + 1] === 2) { style.fg = `#${hex2(codes[i + 2])}${hex2(codes[i + 3])}${hex2(codes[i + 4])}`; i += 4; }
    else if (c === 38 && codes[i + 1] === 5) i += 2;
  }
}

const sameStyle = (a, b) => a.bold === b.bold && a.faint === b.faint && a.inverse === b.inverse && a.fg === b.fg;

// A line's text as runs { col, cells, text, style }: one per stretch of the same
// style, and one of its own for each wide character. OSC 8 links and any other
// escape sequence take no cells and are dropped, as are characters XML can't hold.
export function parseLine(line, width) {
  const runs = [], style = plain();
  let col = 0, run = null;
  const token = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b.?|[\s\S]/gu;
  for (const m of line.matchAll(token)) {
    const t = m[0];
    if (t[0] === "\x1b") {
      if (m[1] !== undefined) applySgr(style, m[1]);
      continue;
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿]/.test(t)) continue;
    const cells = width(t);
    if (cells === 0) { if (run) run.text += t; continue; }
    if (!run || cells > 1 || run.wide || !sameStyle(run.style, style)) {
      run = { col, cells: 0, text: "", style: { ...style }, wide: cells > 1 };
      runs.push(run);
    }
    run.text += t;
    run.cells += cells;
    col += cells;
  }
  return runs.map(({ wide, ...r }) => r);
}

export const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n) => (Math.round(n * 10) / 10).toFixed(1);

// `lines`: the frame's lines with their escape sequences. `cols` and `rows`: the
// pane's size. `title` goes on the window's bar, `label` is what the picture shows
// for a screen reader. Returns the SVG's text.
export function toSvg(lines, { cols, rows, width, title = "herdr · GitHub panel", label = title }) {
  const w = Math.ceil(PAD_X * 2 + cols * CELL), h = TOP + rows * LINE + LINE;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}" font-size="${FONT_SIZE}" role="img" aria-label="${escapeXml(label)}">`,
    `<title>${escapeXml(label)}</title>`,
    `<rect width="${w}" height="${h}" rx="10" fill="${THEME.bg}"/>`,
    `<circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>`,
    `<text x="${num(w / 2)}" y="23" fill="${THEME.colors[90]}" text-anchor="middle" font-size="12">${escapeXml(title)}</text>`,
  ];
  lines.slice(0, rows).forEach((line, row) => {
    for (const r of parseLine(line, width)) {
      let { col, cells, text } = r;
      const s = r.style, color = s.fg ?? THEME.fg;
      // Spaces with nothing behind them draw nothing: leave them out.
      if (!s.inverse) {
        const lead = text.length - text.trimStart().length;
        text = text.trim();
        if (!text) continue;
        col += lead;
        cells = width(text);
      }
      const x = num(PAD_X + col * CELL), len = num(cells * CELL);
      const opacity = s.faint ? ` fill-opacity="0.6"` : "";
      const weight = s.bold ? ` font-weight="bold"` : "";
      if (s.inverse) out.push(`<rect x="${x}" y="${TOP + row * LINE + 4}" width="${len}" height="${LINE}" fill="${color}"${opacity}/>`);
      if (!text.trim()) continue;
      const fill = s.inverse ? `fill="${THEME.bg}"` : `fill="${color}"${opacity}`;
      out.push(`<text x="${x}" y="${TOP + row * LINE + 19}" ${fill}${weight} xml:space="preserve" textLength="${len}" lengthAdjust="spacingAndGlyphs">${escapeXml(text)}</text>`);
    }
  });
  out.push("</svg>");
  return out.join("\n") + "\n";
}
