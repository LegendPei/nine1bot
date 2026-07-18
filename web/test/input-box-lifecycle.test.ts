import { describe, expect, it } from 'bun:test'
import { compile } from 'vue'

describe('main conversation input lifecycle', () => {
  it('uses one InputBox instance across empty and loading layouts', async () => {
    const source = await Bun.file(new URL('../src/App.vue', import.meta.url)).text()
    const templateStart = source.indexOf('<template>')
    const templateEnd = source.lastIndexOf('</template>')
    const template = source.slice(templateStart + '<template>'.length, templateEnd)
    const render = compile(template).toString()
    const inputBoxes = render.match(/_createVNode\(_component_InputBox/g) ?? []

    // One composer belongs to the browser extension surface and one to the
    // main Web surface. Empty/loading layout changes must not create a third.
    expect(inputBoxes).toHaveLength(2)
  })
})
