// Environment for the test suite: its own database, queue and bucket, so
// tests never touch dev data or compete with running dev workers.
export const TEST_ENV = {
  DATABASE_URL: "postgres://vpp:vpp@localhost:5433/vpp_test",
  SQS_QUEUE_NAME: "jobs-test",
  S3_BUCKET: "videos-test",
  JOB_LEASE_SECONDS: "5",
  PLACEHOLDER_STEP_MS: "10",
};
