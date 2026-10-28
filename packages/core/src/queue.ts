import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
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

/** What travels through the queue: a pointer to a job row, never job state. */
export interface JobMessage {
  jobId: string;
}

// Resolve the queue URL once and share the promise between callers.
let queueUrlPromise: Promise<string> | undefined;
export function queueUrl(): Promise<string> {
  queueUrlPromise ??= sqs
    .send(new GetQueueUrlCommand({ QueueName: config.SQS_QUEUE_NAME }))
    .then((res) => res.QueueUrl!);
  return queueUrlPromise;
}

export async function sendJobMessage(msg: JobMessage): Promise<void> {
  await sqs.send(new SendMessageCommand({ QueueUrl: await queueUrl(), MessageBody: JSON.stringify(msg) }));
}

/** Long-polls for up to `waitSeconds`. Abort the signal to stop waiting (shutdown). */
export async function receiveJobMessages(opts: {
  max: number;
  waitSeconds: number;
  visibilityTimeoutSeconds: number;
  signal?: AbortSignal;
}): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: await queueUrl(),
      MaxNumberOfMessages: opts.max,
      WaitTimeSeconds: opts.waitSeconds,
      VisibilityTimeout: opts.visibilityTimeoutSeconds,
    }),
    opts.signal ? { abortSignal: opts.signal } : {},
  );
  return res.Messages ?? [];
}

/** Acknowledge: the message is gone for good. Until then it will be redelivered. */
export async function deleteJobMessage(receiptHandle: string): Promise<void> {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: await queueUrl(), ReceiptHandle: receiptHandle }));
}

/** Keeps an in-flight message hidden from other consumers for `seconds` more. */
export async function extendMessageVisibility(receiptHandle: string, seconds: number): Promise<void> {
  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: await queueUrl(),
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: seconds,
    }),
  );
}

export async function purgeQueue(): Promise<void> {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: await queueUrl() }));
}
