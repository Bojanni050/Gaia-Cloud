/**
 * A tiny in-memory stand-in for `pg`'s Pool, just enough to drive
 * hypotheses.js/patterns.js through their real SQL text via a hand-rolled
 * matcher, so tests don't need a live Postgres.
 */
function makeFakePool() {
  const calls = [];
  let queryImpl = async () => ({ rows: [], rowCount: 0 });

  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return queryImpl(sql, params);
    },
  };

  return {
    pool,
    calls,
    setImpl(fn) {
      queryImpl = fn;
    },
  };
}

module.exports = { makeFakePool };
