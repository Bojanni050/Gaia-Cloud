'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateSkillRecipe,
  recipeProblems,
  MAX_STEPS,
} = require('../src/skillRecipe');

function recipe(steps, capability = 'desktop') {
  return { capability, steps };
}

test('a recipe over existing tools, hung under its capability, is accepted', () => {
  assert.equal(validateSkillRecipe(recipe([{ tool: 'desktop', skill: 'file-read' }])), null);
  assert.equal(validateSkillRecipe(recipe([
    { tool: 'web_search' },
    { tool: 'desktop', skill: 'file-write' },
  ], 'web_search')), null);
});

test('a capability or a skill id written as a step is refused', () => {
  const hermes = recipeProblems(recipe([{ tool: 'hermes' }], 'hermes'));
  assert.ok(hermes.some((problem) => problem.includes('not a tool the model can call')));

  const skillAsStep = recipeProblems(recipe([{ tool: 'file-write' }]));
  assert.ok(skillAsStep.some((problem) => problem.includes('not a tool the model can call')));
});

test('desktop needs a skill, other tools must not carry one', () => {
  assert.ok(recipeProblems(recipe([{ tool: 'desktop' }]))
    .some((problem) => problem.includes('without naming a skill')));
  assert.ok(recipeProblems(recipe([{ tool: 'desktop', skill: 'send-email' }]))
    .some((problem) => problem.includes('does not expose skill')));
  assert.ok(recipeProblems(recipe([{ tool: 'search_memory', skill: 'file-read' }], 'memory'))
    .some((problem) => problem.includes('only desktop carries one')));
});

test('an empty recipe and a recipe that runs too long are both refused', () => {
  assert.ok(recipeProblems(recipe([])).some((problem) => problem.includes('at least one step')));
  const long = recipe(Array.from({ length: MAX_STEPS + 1 }, () => ({ tool: 'desktop', skill: 'file-read' })));
  assert.ok(recipeProblems(long).some((problem) => problem.includes(`at most ${MAX_STEPS} steps`)));
});

test('a prompt-free local read may not meet a prompt-free external send', () => {
  const readThenSearch = recipeProblems(recipe([
    { tool: 'desktop', skill: 'file-read' },
    { tool: 'web_search' },
  ]));
  assert.ok(readThenSearch.some((problem) => problem.includes('off the machine unseen')));

  // Order is irrelevant: the result of each step is handed back before the next
  // one runs, so either direction moves the content.
  const openThenSearch = recipeProblems(recipe([
    { tool: 'desktop', skill: 'open-url' },
    { tool: 'desktop', skill: 'file-search' },
  ]));
  assert.ok(openThenSearch.some((problem) => problem.includes('off the machine unseen')));
});

test('a sink the person has to confirm stays allowed, in both directions', () => {
  // Reading a file and writing one asks for confirmation on the write, so the
  // person sees the content move.
  assert.equal(validateSkillRecipe(recipe([
    { tool: 'desktop', skill: 'file-read' },
    { tool: 'desktop', skill: 'file-write' },
  ])), null);

  // A web result into a command is visible every run too — the step is
  // `confirm`, with its arguments shown. The taint rule is about what stays
  // unseen, not about forbidding every composition.
  assert.equal(validateSkillRecipe(recipe([
    { tool: 'web_search' },
    { tool: 'desktop', skill: 'run-command' },
  ], 'web_search')), null);
});

test('a recipe without a registered owning capability is refused', () => {
  assert.ok(recipeProblems(recipe([{ tool: 'desktop', skill: 'file-read' }], ''))
    .some((problem) => problem.includes('names the capability')));
  assert.ok(recipeProblems(recipe([{ tool: 'desktop', skill: 'file-read' }], 'teleport'))
    .some((problem) => problem.includes('not registered')));
  assert.ok(recipeProblems(recipe([{ tool: 'desktop', skill: 'file-read' }], 'web_search'))
    .some((problem) => problem.includes('owns none of this recipe')));
});

test('every problem is reported at once for the review card', () => {
  const problems = recipeProblems({
    capability: 'teleport',
    steps: [{ tool: 'hermes' }, { tool: 'desktop' }],
  });
  assert.ok(problems.length >= 3);
  assert.equal(validateSkillRecipe({
    capability: 'teleport',
    steps: [{ tool: 'hermes' }, { tool: 'desktop' }],
  }), problems[0]);
});
