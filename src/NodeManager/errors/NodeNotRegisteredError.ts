export class NodeNotRegisteredError extends Error {
  constructor() {
    super('Node is not registered. Registration required before requesting a market.');
    this.name = 'NodeNotRegisteredError';
  }
}
