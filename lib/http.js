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
    if (e.status === 503) return json(503, { errors: [e.message] });
    if (e.code === '42P01') {
      return json(503, { errors: ['The database tables do not exist yet: run `npm run db:setup`, or redeploy.'] });
    }
    return json(500, { errors: ['Something went wrong on the server. Check the function logs in Vercel.'] });
  }
};
