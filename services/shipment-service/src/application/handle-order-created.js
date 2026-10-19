const normalizeOrderCreated = require(
  "../domain/order-created-event"
);

class HandleOrderCreated {
  constructor(repository) {
    this.repository = repository;
  }

  async execute(event) {
    const input = normalizeOrderCreated(event);

    return this.repository.ensureShipment(input);
  }
}

module.exports = HandleOrderCreated;