export class NodeBannedError extends Error {
  constructor() {
    super('Node has been rejected (REJECTED status). Shutting down.');
    this.name = 'NodeBannedError';
  }
}
