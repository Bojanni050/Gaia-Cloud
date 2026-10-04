class NotFoundError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`invalid status transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.status = 409;
  }
}

class ValidationError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ValidationError';
    this.status = 422;
  }
}

module.exports = { NotFoundError, InvalidTransitionError, ValidationError };
