import { nodeCommand } from '../';

describe('nodeCommand', () => {
  it('should have only three commands', () => {
    expect(nodeCommand.commands.length).toBe(3);
  });

  it.each([['run'], ['start'], ['prune']])(
    'should contain %s command',
    (command) => {
      // @ts-ignore
      expect(nodeCommand.commands.map((command) => command._name)).toContain(
        command,
      );
    },
  );
});
