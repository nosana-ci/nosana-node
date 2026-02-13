import { TrustedExecutionEnv } from '@nosana/sdk';
import { Option } from 'commander';

export const teeRuntimeOption = new Option(
  '--trusted-execution-runtime <runtime>',
  'specify the container runtime to use for TEE containers',
)
  .choices(Object.values(TrustedExecutionEnv))
  .default(undefined);
