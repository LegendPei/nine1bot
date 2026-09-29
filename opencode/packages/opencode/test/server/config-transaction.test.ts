import { afterEach, expect, mock, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { JsonFile } from "../../src/util/json-file"
import { tmpdir } from "../fixture/fixture"
import { Auth } from "../../src/auth"
import { updateConfigValue } from "../../../../../packages/nine1bot/src/config/editor"
import { patchBrowserExtensionConfig } from "../../src/server/nine1bot-browser-extension-config"

afterEach(() => mock.restore())

test("mixed config writers preserve comments and each other's fields", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "config.jsonc")
  const previous = process.env.NINE1BOT_CONFIG_PATH
  process.env.NINE1BOT_CONFIG_PATH = filename
  try {
    await fs.writeFile(filename, '{\n // keep this\n "model": "before"\n}\n')
    await Promise.all([
      updateConfigValue(filename, ["model"], "after"),
      patchBrowserExtensionConfig({ prompt: "browser prompt" }),
    ])
    const document = await JsonFile.read(filename)
    expect(document.data.model).toBe("after")
    expect(document.data.browser.sidepanel.prompt).toBe("browser prompt")
    expect(document.text).toContain("// keep this")
  } finally {
    if (previous === undefined) delete process.env.NINE1BOT_CONFIG_PATH
    else process.env.NINE1BOT_CONFIG_PATH = previous
  }
})

test("a second-file commit failure restores the first source", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source.json"),
    runtime = path.join(tmp.path, "runtime.json")
  await fs.writeFile(source, '{"model":"old"}')
  await fs.writeFile(runtime, '{"model":"old"}')
  const rename = fs.rename.bind(fs)
  spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === runtime) throw new Error("injected I/O failure")
    await rename(from, to)
  })
  await expect(
    JsonFile.transaction([source, runtime], (documents) => {
      for (const document of documents) document.data.model = "new"
    }),
  ).rejects.toThrow("injected I/O failure")
  expect(await fs.readFile(source, "utf8")).toBe('{"model":"old"}')
  expect(await fs.readFile(runtime, "utf8")).toBe('{"model":"old"}')
})

test("invalid credential JSON is preserved instead of being overwritten as an empty store", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "auth.json")
  const previous = process.env.NINE1BOT_AUTH_PATH
  process.env.NINE1BOT_AUTH_PATH = filename
  try {
    await fs.writeFile(filename, '{"broken":')
    await expect(Auth.set("new", { type: "api", key: "synthetic" })).rejects.toThrow()
    expect(await fs.readFile(filename, "utf8")).toBe('{"broken":')
  } finally {
    if (previous === undefined) delete process.env.NINE1BOT_AUTH_PATH
    else process.env.NINE1BOT_AUTH_PATH = previous
  }
})
