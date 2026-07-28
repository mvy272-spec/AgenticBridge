export function authorized(req) {
  const supplied = Buffer.from(String(req.headers['x-bridge-token'] || ''));
  const expected = Buffer.from(process.env.BRIDGE_TOKEN || 'CHANGE-ME-TO-A-LONG-RANDOM-TOKEN');
  return supplied.length === expected.length && 
         crypto.timingSafeEqual(supplied, expected);
}

export function getAgentId(req) {
  return String(req.headers['x-agent-id'] || 'default').slice(0, 64);
}