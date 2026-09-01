import type { AgiSession } from './agiSession.js';
import type { Logger } from '../logging/logger.js';
import type { CallOrchestrator, BootstrapDecision } from '../orchestrator/callOrchestrator.js';

export interface BootstrapHandlerDeps {
  orchestrator: CallOrchestrator;
  officePulseInstanceId: string;
  logger: Logger;
}

const VAR = {
  disposition: 'AIDA_DISPOSITION',
  callSessionId: 'AIDA_CALL_SESSION_ID',
  roomName: 'AIDA_ROOM_NAME',
  sipDestination: 'AIDA_SIP_DESTINATION',
  fallbackContext: 'AIDA_FALLBACK_CONTEXT',
  fallbackExtension: 'AIDA_FALLBACK_EXTENSION',
} as const;

function sanitizeCallerNumber(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^0-9+]/g, '');
  if (cleaned === '' || /unknown|anonymous|restricted/i.test(raw)) return undefined;
  return cleaned;
}

/**
 * FastAGI `/bootstrap` — the synchronous inbound path.
 *
 * Reads call identity from the AGI environment, asks the local orchestrator
 * for a routing decision, and writes the AIDA_* channel variables the
 * static dialplan include consumes. Every failure mode degrades to
 * AIDA_DISPOSITION=FALLBACK with this DID's own destination, so the caller
 * always reaches a human after the local prompts.
 */
export function createBootstrapHandler(deps: BootstrapHandlerDeps): (session: AgiSession) => Promise<void> {
  return async (session: AgiSession): Promise<void> => {
    const env = session.env;
    const uniqueid = env['agi_uniqueid'] ?? '';
    const channel = env['agi_channel'] ?? '';
    const didE164 = env['agi_extension'] ?? '';
    const callerNumber = sanitizeCallerNumber(env['agi_callerid']);

    const linkedid = (await safeGetVar(session, 'ASTERISK_LINKEDID')) || uniqueid;
    const instanceId = (await safeGetVar(session, 'OFFICEPULSE_INSTANCE_ID')) || deps.officePulseInstanceId;
    const log = deps.logger.child({ linkedid, uniqueid, channel });

    let decision: BootstrapDecision;
    try {
      decision = await deps.orchestrator.bootstrapInboundCall({
        officePulseInstanceId: instanceId,
        asteriskLinkedId: linkedid,
        callerNumber,
        didE164,
      });
    } catch (err) {
      // The orchestrator degrades internally; reaching here means something
      // unforeseen. The caller still must not be stranded.
      log.error('bootstrap failed unexpectedly; forcing local fallback', { err });
      await session.setVariable(VAR.disposition, 'FALLBACK');
      return;
    }

    switch (decision.disposition) {
      case 'SCREEN': {
        await session.setVariable(VAR.disposition, 'SCREEN');
        await session.setVariable(VAR.callSessionId, decision.callSessionId as string);
        await session.setVariable(VAR.roomName, decision.roomName as string);
        await session.setVariable(VAR.sipDestination, decision.sipDestination as string);
        log.info('bootstrap SCREEN', { callSessionId: decision.callSessionId, roomName: decision.roomName });
        return;
      }
      case 'REJECT': {
        await session.setVariable(VAR.disposition, 'REJECT');
        log.info('bootstrap REJECT');
        return;
      }
      case 'FALLBACK': {
        await session.setVariable(VAR.disposition, 'FALLBACK');
        if (decision.fallback) {
          await session.setVariable(VAR.fallbackContext, decision.fallback.context);
          await session.setVariable(VAR.fallbackExtension, decision.fallback.exten);
        }
        log.info('bootstrap FALLBACK', {
          reason: decision.fallbackReason,
          fallbackSource: decision.fallback?.source,
          resolved: decision.fallback !== undefined,
        });
        return;
      }
    }
  };
}

async function safeGetVar(session: AgiSession, name: string): Promise<string | undefined> {
  try {
    const value = await session.getVariable(name);
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}
