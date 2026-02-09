
import { type Resource } from '@nosana/sdk';

export type RequiredResource = Omit<Resource, 'target'>;

export type StdOptions = 'stdin' | 'stdout' | 'stderr' | 'nodeerr';

export type ReturnedStatus<T = undefined> =
  | { status: true; result?: T; error?: never } // If status is true, result is optional
  | { status: false; error: Error | unknown; result?: never }; // If status is false, error is required and result is not allowed

export type HealthcheckPayload = {
  id: string;
  flowId: string;
  port: number | string;
  service?: string;
};