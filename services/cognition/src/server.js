const express = require('express');
const hypothesesRouter = require('./routes/hypotheses');
const patternsRouter = require('./routes/patterns');
const { NotFoundError, InvalidTransitionError, ValidationError } = require('./errors');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/v1/banks/:bankId/hypotheses', hypothesesRouter);
app.use('/v1/banks/:bankId/patterns', patternsRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof NotFoundError || err instanceof InvalidTransitionError || err instanceof ValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({ error: 'internal error' });
});

if (require.main === module) {
  const port = process.env.PORT || 8890;
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`gaia-cognition listening on ${port}`);
  });
}

module.exports = { app };
