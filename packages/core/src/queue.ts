import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { config } from "./config.ts";

// ElasticMQ speaks the SQS API, so this is the same code you'd run against AWS.
export const sqs = new SQSClient({
  endpoint: config.SQS_ENDPOINT,
  region: config.S3_REGION,
  credentials: { accessKeyId: "x", secretAccessKey: "x" },
});

/** What travels through a queue: a pointer to a job row, never job state. */
export interface JobMessage {
  jobId: string;
}

/**
 * The two queues from PROJECT_OVERVIEW.md: the job queue workers consume, and
 * the dead-letter queue for exhausted or permanently failed work. The names
 * match `outbox.queue`, so the dispatcher can route outbox rows directly.
 */
export type QueueName = "jobs" | "dead-letter";

const QUEUE_NAMES: Record<QueueName, string> = {
  jobs: config.SQS_QUEUE_NAME,
  "dead-letter": config.SQS_DLQ_NAME,
};

// Resolve each queue URL once and share the promise between callers.
const urlCache = new Map<QueueName, Promise<string>>();
export function queueUrl(queue: QueueName = "jobs"): Promise<string> {
  let url = urlCache.get(queue);
  if (!url) {
    url = sqs.send(new GetQueueUrlCommand({ QueueName: QUEUE_NAMES[queue] })).then((res) => res.QueueUrl!);
    urlCache.set(queue, url);
  }
  return url;
}

export async function sendJobMessage(msg: JobMessage, queue: QueueName = "jobs"): Promise<void> {
  await sqs.send(new SendMessageCommand({ QueueUrl: await queueUrl(queue), MessageBody: JSON.stringify(msg) }));
}

/** Long-polls for up to `waitSeconds`. */
export async function receiveJobMessages(opts: {
  max: number;
  waitSeconds: number;
  visibilityTimeoutSeconds: number;
  queue?: QueueName;
}): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: await queueUrl(opts.queue),
      MaxNumberOfMessages: opts.max,
      WaitTimeSeconds: opts.waitSeconds,
      VisibilityTimeout: opts.visibilityTimeoutSeconds,
    }),
  );
  return res.Messages ?? [];
}

/** Acknowledge: the message is gone for good. Until then it will be redelivered. */
export async function deleteJobMessage(receiptHandle: string, queue: QueueName = "jobs"): Promise<void> {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: await queueUrl(queue), ReceiptHandle: receiptHandle }));
}

/** Keeps an in-flight message hidden from other consumers for `seconds` more (0 = release now). */
export async function extendMessageVisibility(receiptHandle: string, seconds: number): Promise<void> {
  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: await queueUrl("jobs"),
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: seconds,
    }),
  );
}

export interface QueueDepth {
  /** Waiting to be received. */
  visible: number;
  /** Received by a consumer but not yet acknowledged. */
  inFlight: number;
}

/** Approximate depth. SQS only promises approximate counts, and so do we. */
export async function queueDepth(queue: QueueName): Promise<QueueDepth> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queueUrl(queue),
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return {
    visible: Number(res.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

export async function purgeQueue(queue: QueueName = "jobs"): Promise<void> {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: await queueUrl(queue) }));
}
