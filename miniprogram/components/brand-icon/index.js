const POSITIONS = { home: [0, 0], explore: [1, 0], ai: [2, 0], learn: [0, 1], profile: [1, 1], assistant: [2, 1] };
// Center the visible HYHQ artwork, not the whitespace in its 512px sprite tile.
// Ink bounds: x=27..468, y=168..287; center=(247.5, 227.5), tile center=(256, 256).
const INK_OFFSETS = { assistant: [1.66015625, 5.56640625] };
Component({
  properties: { name: { type: String, value: 'home' }, size: { type: Number, value: 60 } },
  data: { left: 0, top: 0 },
  observers: {
    name(name) {
      const [column, row] = POSITIONS[name] || POSITIONS.home;
      const [offsetX, offsetY] = INK_OFFSETS[name] || [0, 0];
      this.setData({ left: -100 * column + offsetX, top: -100 * row + offsetY });
    },
  },
});
