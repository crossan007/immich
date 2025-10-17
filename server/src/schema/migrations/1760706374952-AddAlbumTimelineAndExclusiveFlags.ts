import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" ADD COLUMN "hideFromTimeline" BOOLEAN NOT NULL DEFAULT FALSE;`.execute(db);
  await sql`ALTER TABLE "album" ADD COLUMN "isExclusive" BOOLEAN NOT NULL DEFAULT FALSE;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" DROP COLUMN "hideFromTimeline";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "isExclusive";`.execute(db);
}