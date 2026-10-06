/** Telephone state remains distinct from Agent admission/readiness diagnostics. */
export const eventStates: Record<string, string> = {
  'screening-started': 'screening', 'aida-connected': 'screening', 'pbx-fallback': 'fallback',
  'takeover-requested': 'ringing', ringing: 'ringing', bridged: 'human-active',
  'aida-drained': 'human-active', 'takeover-failed': 'screening', hangup: 'ended',
};
export const handsetState = (state: string): string => ['admitted', 'agent-ready'].includes(state) ? 'screening' : state;
