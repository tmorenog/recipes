// Calls the coordinator's MCP endpoint in-process, with the same headers a
// Lovable app sends, so the site's own agents are checked and logged exactly
// like the students' ones. The Pricer and the Shopper (site: true) send the
// admin key, which is what lets them save prices and the class's choice.
import { handle as mcpHandle } from '../api/mcp.js';

export function coordinatorClient(agent, groupName, { site = false } = {}) {
  let id = 0;
  const key = (site ? process.env.ADMIN_KEY : process.env.CLASS_KEY)?.trim() ?? '';
  const rpc = async (method, params) => {
    const res = await mcpHandle(new Request(`http://coordinator/api/mcp?agent=${agent}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'x-group': groupName,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    }));
    const body = await res.json().catch(() => null);
    if (!body || body.error) throw new Error(body?.error?.message || `the coordinator answered ${res.status}`);
    return body.result;
  };
  return {
    tools: async () => (await rpc('tools/list', {})).tools,
    call: async (name, args) => {
      const result = await rpc('tools/call', { name, arguments: args });
      const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { text, isError: Boolean(result.isError) };
    },
  };
}
