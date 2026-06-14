// `cloudflare:test` の提供環境を本プロジェクトの `Env` に束ねる型宣言。
// "workers" プロジェクトのテストが `env.EvaluationCycleAgent` 等を型付きで扱える。
import type { Env } from "../src/env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
