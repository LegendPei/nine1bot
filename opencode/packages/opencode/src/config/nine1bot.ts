import { Config } from "./config"
import { Provider } from "../provider/provider"
import { JsonFile } from "../util/json-file"
import { sanitizeOpencodeConfig } from "../../../../../packages/nine1bot/src/engine/opencode-runtime"
import type { Nine1BotConfig } from "../../../../../packages/nine1bot/src/config/schema"

/** Mutate source documents, never a directory's merged/effective configuration. */
export async function updateNine1botConfig(edit: (data: JsonFile.Object) => void) {
  const persistent = process.env.NINE1BOT_CONFIG_PATH
  if (!persistent) throw new Error("No config path")
  const runtime = process.env.OPENCODE_CONFIG
  const paths = runtime ? [persistent, runtime] : [persistent]
  const [result] = await JsonFile.transaction(paths, ([source, generated]) => {
    const before = sanitizeOpencodeConfig(source.data as Nine1BotConfig).config
    edit(source.data)
    const after = sanitizeOpencodeConfig(source.data as Nine1BotConfig).config
    Config.Info.parse(after)
    if (generated) {
      JsonFile.applyDiff(generated.data, before, after)
      Config.Info.parse(generated.data)
    }
  })
  Config.refreshAll()
  Provider.refreshAll()
  return result
}
