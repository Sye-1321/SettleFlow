export class EventIdentifierCollisionError extends Error {
  public constructor() {
    super('The generated event identifier collided with an existing event');
    this.name = 'EventIdentifierCollisionError';
  }
}
