import { createNosanaCLI } from './createNosanaCli.js';
import { outputFormatSelector } from '../output-formatter/outputFormatSelector.js';
import { validateCLIVersion } from '../version/index.js';

export async function startCLI(version: string) {
  const cli = createNosanaCLI(version);

  try {
    await validateCLIVersion();
    await cli.parseAsync(process.argv);
    outputFormatSelector('').finalize();
  } catch (e: any) {
    outputFormatSelector('').finalize();
    console.error(e);
    process.exit(1);
  }
}
