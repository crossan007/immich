import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TYPE "asset_visibility_enum" ADD VALUE IF NOT EXISTS 'album-hidden';`.execute(db);
}

export async function down(): Promise<void> {
  // Cannot remove enum values in PostgreSQL, this is irreversible
  // The enum value will remain but won't be used if the feature is rolled back
}