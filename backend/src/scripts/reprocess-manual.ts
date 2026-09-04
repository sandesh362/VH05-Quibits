/** Reprocess one stored manual and wait for the local worker to finish. */
import { ObjectId } from 'mongodb';
import { connectMongo, disconnectMongo, getDb } from '../db/mongo.js';
import { reprocessManual } from '../modules/manuals/manual-processing.service.js';
import { flushAll } from '../modules/manuals/manual-processing-queue.js';
import { collections } from '../database/collections.js';

const manualId = process.argv[2];

if (!manualId || !ObjectId.isValid(manualId)) {
  throw new Error('Usage: npm run reprocess-manual --workspace @itp/backend -- <manualId>');
}

async function main(): Promise<void> {
  await connectMongo();
  const db = getDb();
  if (!db) throw new Error('MongoDB connection was not established.');

  const actor = await collections.users(db).findOne({ is_deleted: false, is_active: true });
  if (!actor) throw new Error('An active user is required to reprocess a manual.');

  const result = await reprocessManual(
    db,
    new ObjectId(manualId),
    { id: actor._id, username: actor.username, role: actor.role },
    'Retry after installing Tesseract OCR.',
    'manual-ocr-repair',
  );
  await flushAll();
  console.log(`Manual reprocessing completed: ${result.jobId.toHexString()}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => disconnectMongo());
