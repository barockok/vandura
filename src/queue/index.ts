import { Queue } from "bullmq";
import type { JobData, JobResult } from "./types.js";

/**
 * Queue name for Vandura jobs
 */
export const QUEUE_NAME = "vandura";

/**
 * Redis connection options for BullMQ
 */
export function getRedisOptions() {
  return {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null, // BullMQ requires this
    enableReadyCheck: false,
  };
}

/**
 * Create the Vandura job queue
 */
export function createQueue(): Queue<JobData, JobResult, string> {
  return new Queue<JobData, JobResult, string>(QUEUE_NAME, {
    connection: getRedisOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000,
      },
      removeOnComplete: {
        count: 100,
        age: 24 * 3600, // 24 hours
      },
      removeOnFail: {
        count: 50,
        age: 7 * 24 * 3600, // 7 days
      },
    },
  });
}

/**
 * Add a job to the queue
 */
export async function addJob(
  queue: Queue<JobData, JobResult, string>,
  name: string,
  data: JobData
): Promise<void> {
  await queue.add(name, data);
}

/**
 * Close queue and cleanup
 */
export async function closeQueue(queue: Queue): Promise<void> {
  await queue.close();
}

// Re-export types
export * from "./types.js";