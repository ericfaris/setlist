import '@testing-library/jest-dom/vitest';

// jsdom does not implement HTMLMediaElement playback — .play() returns
// undefined instead of a Promise. sfx.ts's playSfx() does
// `node.play().catch(() => undefined)`, so without this mock that throws a
// synchronous TypeError ("Cannot read properties of undefined (reading
// 'catch')") from INSIDE whatever click/pointerdown handler called it —
// aborting the rest of that handler before it reaches the real logic (e.g.
// BuzzScreen's pointerdown calls playSfx('buzz') then store.buzz(); the
// throw was silently preventing store.buzz() from ever running, which
// showed up as unrelated-looking assertion failures across several tests,
// not as this actual crash). Standard jsdom/vitest workaround: stub play()
// to resolve immediately so playSfx's own .catch() has a real Promise to
// call.
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};
