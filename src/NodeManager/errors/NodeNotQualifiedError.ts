export class NodeNotQualifiedError extends Error {
  constructor() {
    super('Node does not meet the minimum requirements for any market. Shutting down.');
    this.name = 'NodeNotQualifiedError';
  }
}
