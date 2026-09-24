export class StoreError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}

export const TABLES_MISSING = 'The database tables don’t exist yet: redeploy (every deploy creates them), or run `npm run db:setup`.';
