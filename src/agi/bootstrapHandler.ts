import type { AgiSession } from './agiSession.js';
import type { AidaControlClient, BootstrapCallResult } from '../aidacontrol/client.js';
import type { Logger } from '../logging/logger.js';

/**
 * Resolves an Aida destination id (extension/ring-group UUID from
 * AidaControl) to the concrete dialplan location provisioned for it.
 * Backed by the aida_object mapping the provisioning API maintains.
 */
export interface FallbackResolver {
  resolveDestination(
    kind: 'EXTENSION' | 'RING_GROUP',
    externalId: string,
  ): Promise<{ context: string; exten: string } | undefined>;
}

export interface BootstrapHandlerDeps {
  aidaControl: AidaControlClient;
  fallbackResolver?: FallbackResolver;
  officePulseInstanceId: string;
  logger: Logger;
}

const VAR = {
  disposition: 'AIDA_DISPOSITION',
  callSessionId: 'AIDA_CALL_SESSION_ID',
  roomName: 'AIDA_ROOM_NAME',
  sipDestination: 'AIDA_SIP_DESTINATION',
  routeToken: 'AIDA_ROUTE_TOKEN',
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
 * FastAGI /bootstrap handler — the synchronous inbound path (POC issue 3).
 *
 * Reads call identity from the AGI environment plus the channel variables
 * the DID dialplan row sets, asks AidaControl for the routing decision,
 * and writes the AIDA_* channel variables the static dialplan include
 * consumes. Every failure mode (timeout, malformed response, AidaControl
 * unreachable) degrades to AIDA_DISPOSITION=FALLBACK so the caller always
 * reaches the configured destination after local prompts.
 *
 * The route token is written only to the channel variable — it is never
 * logged; log records carry only a boolean flag for its presence.
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

    const log = deps.logger.child({ linkedid, uniqueid, channel, didE164 });

    let result: BootstrapCallResult;
    try {
      result = await deps.aidaControl.bootstrapCall(
        {
          officePulseInstanceId: instanceId,
          asteriskLinkedId: linkedid,
          callerNumber,
          didE164,
        },
        { correlationId: linkedid },
      );
    } catch (err) {
      log.warn('bootstrap decision unavailable; falling back locally', { err });
      await applyFallback(session, undefined, deps, log);
      return;
    }

    switch (result.disposition) {
      case 'SCREEN': {
        await session.setVariable(VAR.disposition, 'SCREEN');
        await session.setVariable(VAR.callSessionId, result.callSessionId as string);
        await session.setVariable(VAR.roomName, result.roomName as string);
        await session.setVariable(VAR.sipDestination, result.sipDestination as string);
        await session.setVariable(VAR.routeToken, result.routeToken as string);
        await applyFallbackVars(session, result, deps, log);
        log.info('bootstrap SCREEN', {
          callSessionId: result.callSessionId,
          roomName: result.roomName,
          routeTokenPresent: Boolean(result.routeToken),
        });
        return;
      }
      case 'REJECT': {
        await session.setVariable(VAR.disposition, 'REJECT');
        log.info('bootstrap REJECT');
        return;
      }
      case 'FALLBACK': {
        await applyFallback(session, result, deps, log);
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

async function applyFallback(
  session: AgiSession,
  result: BootstrapCallResult | undefined,
  deps: BootstrapHandlerDeps,
  log: Logger,
): Promise<void> {
  await session.setVariable(VAR.disposition, 'FALLBACK');
  await applyFallbackVars(session, result, deps, log);
  log.info('bootstrap FALLBACK', { fromAidaControl: result !== undefined });
}

async function applyFallbackVars(
  session: AgiSession,
  result: BootstrapCallResult | undefined,
  deps: BootstrapHandlerDeps,
  log: Logger,
): Promise<void> {
  if (!result?.destinationType || !result.destinationId || !deps.fallbackResolver) return;
  try {
    const dest = await deps.fallbackResolver.resolveDestination(result.destinationType, result.destinationId);
    if (dest) {
      await session.setVariable(VAR.fallbackContext, dest.context);
      await session.setVariable(VAR.fallbackExtension, dest.exten);
    } else {
      log.warn('fallback destination not provisioned locally', {
        destinationType: result.destinationType,
        destinationId: result.destinationId,
      });
    }
  } catch (err) {
    log.warn('fallback destination lookup failed', { err });
  }
}
