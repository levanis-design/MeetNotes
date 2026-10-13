'use strict';
// Geometry for the floating recording widget. No Electron dependency, so it can be tested directly.

const CORNERS = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
const MARGIN = 14; // gap between the widget and the screen edge
const SIZES = {
  card: { width: 364, height: 176 },
  pill: { width: 364, height: 76 },
  dot: { width: 68, height: 68 },
};

function isCorner(c) {
  return CORNERS.includes(c);
}

function isSize(s) {
  return Object.prototype.hasOwnProperty.call(SIZES, s);
}

// workArea: { x, y, width, height } of the display. Returns the top-left position for the widget.
function cornerPosition(corner, size, workArea, margin = MARGIN) {
  const right = corner.endsWith('right');
  const bottom = corner.startsWith('bottom');
  const x = right ? workArea.x + workArea.width - size.width - margin : workArea.x + margin;
  const y = bottom ? workArea.y + workArea.height - size.height - margin : workArea.y + margin;
  return { x: Math.round(x), y: Math.round(y) };
}

// bounds: current widget bounds. Returns the screen corner closest to the widget centre.
function nearestCorner(bounds, workArea) {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const right = cx > workArea.x + workArea.width / 2;
  const bottom = cy > workArea.y + workArea.height / 2;
  return `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`;
}

module.exports = { CORNERS, MARGIN, SIZES, isCorner, isSize, cornerPosition, nearestCorner };
