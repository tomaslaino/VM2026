/** m -> matcher som matas av vinnaren (wm-kedjan mot finalen). */
const WM_CHILDREN = {
  73: [90], 74: [89], 75: [90], 76: [91], 77: [89], 78: [91],
  79: [92], 80: [92], 81: [94], 82: [94], 83: [93], 84: [93],
  85: [96], 86: [95], 87: [96], 88: [95],
  89: [97], 90: [97], 91: [99], 92: [99], 93: [98], 94: [98],
  95: [100], 96: [100], 97: [101], 98: [101], 99: [102], 100: [102],
  101: [104], 102: [104],
};

/** @param {number} matchNo */
export function downstreamKoKeys(matchNo) {
  const seen = new Set();
  const q = [...(WM_CHILDREN[matchNo] || [])];
  while (q.length) {
    const m = q.shift();
    if (seen.has(m)) continue;
    seen.add(m);
    q.push(...(WM_CHILDREN[m] || []));
  }
  return [...seen].sort((a, b) => a - b).map((m) => `k:${m}`);
}

/** @param {string[]} finishedKeys  t.ex. ["k:88"] */
export function downstreamKeysFromFinished(finishedKeys) {
  const out = new Set();
  for (const key of finishedKeys) {
    const m = parseInt(String(key).split(":")[1], 10);
    if (!Number.isFinite(m)) continue;
    downstreamKoKeys(m).forEach((k) => out.add(k));
  }
  return [...out].sort();
}
