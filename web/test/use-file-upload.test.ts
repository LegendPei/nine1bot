import { afterEach, describe, expect, it } from 'bun:test'
import { api } from '../src/api/client'
import { useFileUpload } from '../src/composables/useFileUpload'

const originalUploadSessionFile = api.uploadSessionFile

afterEach(() => {
  api.uploadSessionFile = originalUploadSessionFile
})

describe('useFileUpload attachment relocation after await', () => {
  it('aborts the upload when the attachment was removed while ensuring the session', async () => {
    let uploadCalls = 0
    api.uploadSessionFile = (async () => {
      uploadCalls++
      return { url: '/file/upload?path=x', mime: 'text/plain', filename: 'a.txt' }
    }) as unknown as typeof api.uploadSessionFile

    let resolveSession!: (id: string | null) => void
    const { attachments, uploadError, addFiles, removeFile } = useFileUpload({
      ensureSessionId: () => new Promise<string | null>((resolve) => {
        resolveSession = resolve
      })
    })

    await addFiles([new File(['x'], 'a.txt', { type: 'text/plain' })])
    // 等 uploadAttachment 走到 await ensureSessionId 之前的状态更新
    await Bun.sleep(0)
    expect(attachments.value[0]?.status).toBe('uploading')

    // ensureSessionId 在途期间用户删除附件
    removeFile(attachments.value[0].id)
    expect(attachments.value).toHaveLength(0)

    resolveSession('session_1')
    await Bun.sleep(10)

    // 不应上传已被删除的附件，也不应抛错或写入错误状态
    expect(uploadCalls).toBe(0)
    expect(attachments.value).toHaveLength(0)
    expect(uploadError.value).toBeNull()
  })
})
