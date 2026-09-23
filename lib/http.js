// Small helpers shared by the API endpoints.

export const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
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
