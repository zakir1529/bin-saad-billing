'use strict';

// An error the user can fix (wrong password, empty bill, ...). The message is shown on screen as written.
class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.userError = true;
  }
}

module.exports = { UserError };
