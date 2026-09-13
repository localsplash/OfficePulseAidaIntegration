const text = (maxLength: number) => ({ type: 'string', maxLength });
export const agentPaths = {
  '/v1/agent/calls/{callSessionId}/bootstrap': { post: {
    tags: ['Agent'], summary: 'Consume one-time call bootstrap credentials',
    description: 'Bootstrap v1. Requires native admission enabled. Verifies the intended dispatch and SIP identity/SID with LiveKit, checks current tenant/profile authorization, and atomically consumes both credentials. Always no-store; never retry an ambiguous response.',
    'x-access-policy': 'one-time-call-credentials',
    parameters: [{ name: 'callSessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'Authorization', in: 'header', required: true, schema: { type: 'string' }, description: 'Bearer bootstrapToken from dispatch metadata. Not a staff credential.' }],
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false,
      required: ['roomName','sipParticipantIdentity','sipParticipantSid','routeToken'], properties: {
        roomName: text(120), sipParticipantIdentity: text(120), sipParticipantSid: text(80), routeToken: { ...text(256), minLength: 43, pattern: '^[A-Za-z0-9_-]+$' },
      } } } } },
    responses: {
      '200': { description: 'Authorized immutable profile; credentials consumed', content: { 'application/json': { schema: {
        type: 'object', additionalProperties: false, required: ['callSessionId','roomName','sipParticipantIdentity','sipParticipantSid','profileSnapshot'],
        properties: { callSessionId: text(36), roomName: text(120), sipParticipantIdentity: text(120), sipParticipantSid: text(80),
          profileSnapshot: { type: 'object', additionalProperties: false, required: ['schemaVersion','callSessionId','tenantId','businessName','prompt','locale','didE164'],
            properties: { schemaVersion: { type: 'integer', enum: [1] }, callSessionId: text(36), tenantId: { type: 'string', pattern: '^[1-9][0-9]*$' },
              businessName: text(256), prompt: text(12000), locale: { type: 'string', enum: ['en-US'] }, didE164: { ...text(16), pattern: '^\\+[1-9][0-9]{6,14}$' },
              tone: text(256), objective: text(2048), openingStatement: text(2048), transferStatement: text(2048), failedTransferStatement: text(2048) } },
        },
      } } } },
      '400': { description: 'invalid_request' }, '401': { description: 'credential_rejected' }, '503': { description: 'authority_unavailable' },
    },
  } },
};
