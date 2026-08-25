'use strict';

// Public 3.1 seam. The existing task-shape policy remains owned by the
// Decision Engine; this module avoids creating a second classifier.
function matchRequiredSkills(input = {}) {
  const { matchRequiredSkills: match } = require('./decisionEngine');
  return match(input);
}

module.exports = { matchRequiredSkills };
