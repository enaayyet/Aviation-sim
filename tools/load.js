// Loads the browser modules into Node (they attach themselves to globalThis.FS).
const path = require('path');
const files = ['math.js', 'atmosphere.js', 'aircraft.js', 'physics.js', 'world.js', 'coach.js', 'debrief.js', 'lessons.js'];
for (const f of files) {
  try {
    require(path.join(__dirname, '..', 'js', f));
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
  }
}
module.exports = globalThis.FS;
