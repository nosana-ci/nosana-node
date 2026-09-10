import { Table } from 'console-table-printer';
import {
  JobDefinition,
  Operation,
  OperationArgsMap,
  getExposePorts,
  isOperator,
  isSpreadMarker,
  ExposedPort,
} from '@nosana/sdk';

import { generateExposeId } from '../../../NodeManager/utils/expose-util.js';
import { configs } from '../../../NodeManager/configs/configs.js';

export function generateDeploymentEndpointsTable(jobDefinition: JobDefinition) {
  const table = new Table({
    title: `🚀 Deployment Endpoints 🚀`,
    defaultColumnOptions: {
      alignment: 'left',
      color: 'green',
    },
  });

  for (const op of jobDefinition.ops) {
    if (op.type === 'container/run') {
      const { expose } = op.args as OperationArgsMap['container/run'];
      if (expose) {
        // Mirror generateProxies: only single-port ops fall back to 0, so a
        // multi-port op gets a distinct endpoint per port.
        const exposedPortCount = getExposePorts(
          op as Operation<'container/run'>,
        ).length;

        if (
          typeof expose === 'number' ||
          (typeof expose === 'string' && !isOperator(expose))
        ) {
          const generatedId = generateExposeId(
            jobDefinition.deployment_id!,
            op.id,
            exposedPortCount > 1 ? expose : 0,
            false,
          );
          table.addRow({
            OpId: op.id,
            Port: expose,
            Url: `https://${generatedId}.${configs().frp.serverAddr}`,
          });
        }

        if (Array.isArray(expose)) {
          expose.forEach((port) => {
            if (isSpreadMarker(port)) return; // skip dynamic
            if (typeof port === 'string' && isOperator(port)) return; // skip dynamic

            const p =
              typeof port === 'object' ? (port as ExposedPort).port : port;

            const generatedId = generateExposeId(
              jobDefinition.deployment_id!,
              op.id,
              exposedPortCount > 1 ? p : 0,
              false,
            );

            table.addRow({
              OpId: op.id,
              Port: p,
              Url: `https://${generatedId}.${configs().frp.serverAddr}`,
            });
          });
        }
      }
    }
  }

  table.printTable();
}
