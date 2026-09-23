// Small helpers shared by the API endpoints.

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    // Anyone may read from a browser. Requests carrying a group key trigger a
    // CORS preflight this API doesn't answer, so browsers can't send keys:
    // writes have to come from a server (e.g. a Lovable backend function).
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...headers },
  });

// Turns unexpected failures (database down, not set up) into a clear JSON error
// instead of Vercel's generic crash page.
export const guarded = (handler) => async (request, ...rest) => {
  try {
    return await handler(request, ...rest);
  } catch (e) {
    console.error(e);
    if (e.status) return json(e.status, { errors: [e.message] }); // a readable StoreError
    return json(500, { errors: ['Something went wrong on the server. Check the function logs in Vercel.'] });
  }
};

// Returns the calling group, or a ready-made error response.
export async function requireGroup(request) {
  const { groupFromRequest, unauthorized } = await import('./groups.js');
  const group = groupFromRequest(request);
  if (group) return { group };
  const { status, error } = unauthorized();
  return { response: json(status, { errors: [error] }) };
}
