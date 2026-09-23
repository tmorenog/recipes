export class StoreError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

export const TABLES_MISSING_SUPABASE =
  'The database tables do not exist yet. In Supabase, open SQL Editor, paste the contents of schema.sql ' +
  '(from this repository), and click Run.';

export const TABLES_MISSING_POSTGRES = 'The database tables do not exist yet: run `npm run db:setup`, or redeploy.';
