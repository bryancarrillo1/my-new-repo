import { z } from "zod";

// Like a pydantic BaseSettings: parse process.env once, fail fast on bad values,
// and get a fully typed object back. Defaults match docker-compose.yml.
const ConfigSchema = z.object({
  DATABASE_URL: z.string().default("postgres://vpp:vpp@localhost:5433/vpp"),
  S3_ENDPOINT: z.url().default("http://localhost:8333"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().default("vpp"),
  S3_SECRET_KEY: z.string().default("vpp-secret"),
  S3_BUCKET: z.string().default("videos"),
  API_PORT: z.coerce.number().int().default(3000),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 ** 3),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);
